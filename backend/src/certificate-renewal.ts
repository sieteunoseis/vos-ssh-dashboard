import https from 'https';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { Logger } from './logger';
import { DatabaseManager } from './database';
import { ConnectionRecord } from './types';
import { accountManager } from './account-manager';
import { SSHClient } from './ssh-client';

export interface RenewalStatus {
  id: string;
  connectionId: number;
  status: 'pending' | 'generating_csr' | 'creating_account' | 'requesting_certificate' | 'creating_dns_challenge' | 'dns_validation' | 'waiting_dns_propagation' | 'waiting_manual_dns' | 'completing_validation' | 'downloading_certificate' | 'uploading_certificate' | 'completed' | 'failed';
  message: string;
  progress: number;
  startTime: Date;
  endTime?: Date;
  error?: string;
  logs: string[];
  challenges?: any[];
  manualDNSEntry?: {
    recordName: string;
    recordValue: string;
    instructions: string;
  };
}

export interface CertificateRenewalService {
  renewCertificate(connectionId: number, database: DatabaseManager): Promise<RenewalStatus>;
  getRenewalStatus(renewalId: string): Promise<RenewalStatus | null>;
}

class CertificateRenewalServiceImpl implements CertificateRenewalService {
  private renewalStatuses: Map<string, RenewalStatus> = new Map();
  private database: DatabaseManager | null = null;
  private activeRenewals: Set<number> = new Set(); // Track active renewals by connection ID
  private authzRecords: any[] = []; // Store authorization records for DNS challenges
  private dnsRecordIds: string[] = []; // Store DNS record IDs for cleanup

  setDatabase(database: DatabaseManager): void {
    this.database = database;
  }

  async renewCertificate(connectionId: number, database: DatabaseManager): Promise<RenewalStatus> {
    // Check if there's already an active renewal for this connection
    if (this.activeRenewals.has(connectionId)) {
      throw new Error('A certificate renewal is already in progress for this connection');
    }

    const renewalId = crypto.randomUUID();
    const status: RenewalStatus = {
      id: renewalId,
      connectionId,
      status: 'pending',
      message: 'Starting certificate renewal process',
      progress: 0,
      startTime: new Date(),
      logs: []
    };

    this.renewalStatuses.set(renewalId, status);
    this.activeRenewals.add(connectionId); // Mark as active
    Logger.info(`Created renewal status with ID: ${renewalId} for connection ${connectionId}`);

    // Save to database
    await database.saveRenewalStatus(renewalId, connectionId, status.status, undefined, status.message, undefined, status.logs);

    // Start the renewal process asynchronously with comprehensive error handling
    this.performRenewal(renewalId, connectionId, database).catch(async error => {
      try {
        Logger.error(`Certificate renewal failed for connection ${connectionId}:`, error);
        status.status = 'failed';
        status.error = error.message || 'Unknown error during certificate renewal';
        status.message = 'Certificate renewal failed';
        status.endTime = new Date();
        status.logs.push(`ERROR: ${status.error}`);
        
        // Save failed status to database
        if (database) {
          await database.saveRenewalStatus(
            renewalId,
            connectionId,
            'failed',
            undefined,
            'Certificate renewal failed',
            status.error,
            status.logs
          ).catch(err => {
            Logger.error(`Failed to save failed renewal status to database: ${err.message}`);
          });
        }
      } catch (cleanupError) {
        Logger.error(`Error during renewal cleanup for connection ${connectionId}:`, cleanupError);
      }
    }).finally(() => {
      // Always remove from active renewals when done
      this.activeRenewals.delete(connectionId);
    });

    return status;
  }

  async getRenewalStatus(renewalId: string): Promise<RenewalStatus | null> {
    Logger.info(`Looking for renewal status ID: ${renewalId}`);
    
    // First check memory cache
    const memoryStatus = this.renewalStatuses.get(renewalId);
    if (memoryStatus) {
      return memoryStatus;
    }
    
    // If not in memory, check database
    if (this.database) {
      const dbStatus = await this.database.getRenewalStatus(renewalId);
      if (dbStatus) {
        // Convert database format to RenewalStatus format
        const status: RenewalStatus = {
          id: dbStatus.renewal_id,
          connectionId: dbStatus.connection_id,
          status: dbStatus.status,
          message: dbStatus.message || '',
          progress: this.getProgressForStatus(dbStatus.status),
          startTime: new Date(dbStatus.created_at),
          endTime: dbStatus.updated_at ? new Date(dbStatus.updated_at) : undefined,
          error: dbStatus.error,
          logs: dbStatus.logs || []
        };
        // Cache in memory
        this.renewalStatuses.set(renewalId, status);
        return status;
      }
    }
    
    Logger.info(`Available renewal IDs in memory: ${Array.from(this.renewalStatuses.keys()).join(', ')}`);
    return null;
  }

  private getProgressForStatus(status: string): number {
    const progressMap: Record<string, number> = {
      'pending': 0,
      'generating_csr': 10,
      'creating_account': 15,
      'requesting_certificate': 20,
      'creating_dns_challenge': 30,
      'waiting_dns_propagation': 50,
      'completing_validation': 70,
      'downloading_certificate': 80,
      'uploading_certificate': 90,
      'completed': 100,
      'failed': 0
    };
    return progressMap[status] || 0;
  }

  private async performRenewal(renewalId: string, connectionId: number, database: DatabaseManager): Promise<void> {
    const status = this.renewalStatuses.get(renewalId)!;
    
    // Ensure database is set for this renewal
    if (!this.database) {
      this.database = database;
    }
    
    try {
      // Get connection details
      const connection = await database.getConnectionById(connectionId);
      if (!connection) {
        throw new Error(`Connection ${connectionId} not found`);
      }

      const fullFQDN = `${connection.hostname}.${connection.domain}`;

      // Check for existing valid certificate
      const existingCert = await this.getExistingCertificate(fullFQDN);
      if (existingCert) {
        if (connection.application_type === 'general') {
          await this.updateStatus(status, 'uploading_certificate', 'Existing certificate available for download', 80);
          status.logs.push(`Existing valid certificate available for ${connection.name}`);
        } else {
          await this.updateStatus(status, 'uploading_certificate', 'Using existing valid certificate', 80);
          await this.uploadCertificateToCUCM(connection, existingCert, status);
        }
        
        // Handle service restart if enabled
        await this.handleServiceRestart(connection, status);
        
        await this.updateStatus(status, 'completed', 'Certificate renewal completed successfully', 100);
        status.endTime = new Date();
        return;
      }

      // Step 1: Get CSR based on application type
      let csr: string;
      if (connection.application_type === 'general') {
        // For general applications, use the provided custom CSR
        await this.updateStatus(status, 'generating_csr', 'Processing custom CSR for general application', 10);
        
        if (!connection.custom_csr) {
          throw new Error('Custom CSR is required for general applications');
        }
        
        // Extract CSR and private key if both are present
        const customCsrContent = connection.custom_csr;
        
        // Look for CSR section
        const csrMatch = customCsrContent.match(/-----BEGIN CERTIFICATE REQUEST-----[\s\S]*?-----END CERTIFICATE REQUEST-----/);
        if (!csrMatch) {
          throw new Error('Valid CSR not found in custom CSR field');
        }
        csr = csrMatch[0];
        
        // Look for private key section (supports both PRIVATE KEY and RSA PRIVATE KEY formats)
        const privateKeyMatch = customCsrContent.match(/-----BEGIN (RSA )?PRIVATE KEY-----[\s\S]*?-----END (RSA )?PRIVATE KEY-----/);
        
        status.logs.push(`Using custom CSR for general application: ${connection.name}`);
        await accountManager.saveRenewalLog(fullFQDN, `Using custom CSR for general application: ${connection.name}`);
        await accountManager.saveRenewalLog(fullFQDN, `CSR length: ${csr.length} characters`);
        
        // Save the CSR to accounts folder for record keeping
        await accountManager.saveCSR(fullFQDN, csr);
        
        // If private key is included, save it as well
        if (privateKeyMatch) {
          const privateKey = privateKeyMatch[0];
          status.logs.push(`Private key found and saved for ${connection.name}`);
          await accountManager.saveRenewalLog(fullFQDN, `Private key found and saved for ${connection.name}`);
          await accountManager.saveRenewalLog(fullFQDN, `Private key length: ${privateKey.length} characters`);
          
          // Save private key to accounts folder
          const domainDir = path.join(accountManager['accountsDir'], fullFQDN);
          const privateKeyPath = path.join(domainDir, 'private_key.pem');
          await fs.promises.writeFile(privateKeyPath, privateKey);
        } else {
          status.logs.push(`No private key found in custom CSR - only CSR will be processed`);
          await accountManager.saveRenewalLog(fullFQDN, `No private key found in custom CSR - only CSR will be processed`);
        }
      } else {
        // For VOS applications (CUCM, CER, CUC), generate CSR from API
        await this.updateStatus(status, 'generating_csr', 'Generating CSR from VOS application API', 10);
        csr = await this.generateCSRFromCUCM(connection, status);
      }
      
      // Now continue with Let's Encrypt certificate request
      await this.updateStatus(status, 'requesting_certificate', 'Requesting certificate from Let\'s Encrypt', 20);
      const certificate = await this.requestCertificate(connection, csr, database, status);
      
      // Step 4: Handle certificate installation based on application type
      if (connection.application_type === 'general') {
        // For general applications, just make certificate available for download
        await this.updateStatus(status, 'uploading_certificate', 'Certificate ready for download', 90);
        status.logs.push(`Certificate generated and ready for manual installation on ${connection.name}`);
        await accountManager.saveRenewalLog(fullFQDN, `Certificate generated and ready for manual installation on ${connection.name}`);
        const isStaging = process.env.LETSENCRYPT_STAGING !== 'false';
        const envDir = isStaging ? 'staging' : 'prod';
        await accountManager.saveRenewalLog(fullFQDN, `Certificate files available in: ./accounts/${fullFQDN}/${envDir}/`);
        
        // Create CRT and KEY files for easier ESXi import
        try {
          const domainEnvDir = path.join(accountManager['accountsDir'], fullFQDN, envDir);
          const certPath = path.join(domainEnvDir, 'certificate.pem');
          const privateKeyPath = path.join(domainEnvDir, 'private_key.pem');
          
          // Create .crt file from certificate.pem
          if (fs.existsSync(certPath)) {
            const certContent = await fs.promises.readFile(certPath, 'utf8');
            const crtPath = path.join(domainEnvDir, `${fullFQDN}.crt`);
            await fs.promises.writeFile(crtPath, certContent);
            status.logs.push(`Created ${fullFQDN}.crt file for ESXi import`);
            await accountManager.saveRenewalLog(fullFQDN, `Created ${fullFQDN}.crt file for ESXi import`);
          }
          
          // Create .key file from private_key.pem
          if (fs.existsSync(privateKeyPath)) {
            const keyContent = await fs.promises.readFile(privateKeyPath, 'utf8');
            if (keyContent.trim()) { // Only create if not empty
              const keyPath = path.join(domainEnvDir, `${fullFQDN}.key`);
              await fs.promises.writeFile(keyPath, keyContent);
              status.logs.push(`Created ${fullFQDN}.key file for ESXi import`);
              await accountManager.saveRenewalLog(fullFQDN, `Created ${fullFQDN}.key file for ESXi import`);
            }
          }
        } catch (error) {
          status.logs.push(`Warning: Could not create CRT/KEY files: ${error instanceof Error ? error.message : 'Unknown error'}`);
          await accountManager.saveRenewalLog(fullFQDN, `Warning: Could not create CRT/KEY files: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
      } else {
        // For VOS applications, upload via API
        await this.updateStatus(status, 'uploading_certificate', 'Uploading certificate to VOS application', 90);
        await this.uploadCertificateToCUCM(connection, certificate, status);
      }
      
      // Handle service restart if enabled
      await this.handleServiceRestart(connection, status);
      
      await this.updateStatus(status, 'completed', 'Certificate renewal completed successfully', 100);
      status.endTime = new Date();
      
      // Save the renewal completion info
      await accountManager.saveRenewalLog(fullFQDN, `Certificate renewal completed for renewal ${renewalId}`);
      
      // Update database with renewal info
      await this.updateDatabaseWithRenewal(connectionId, database);
      
    } catch (error) {
      Logger.error(`Certificate renewal error for ${renewalId}:`, error);
      status.status = 'failed';
      status.error = error instanceof Error ? error.message : 'Unknown error';
      status.message = 'Certificate renewal failed';
      status.endTime = new Date();
      status.logs.push(`ERROR: ${status.error}`);
    } finally {
      // Always remove from active renewals
      this.activeRenewals.delete(connectionId);
    }
  }

  private async getExistingCertificate(domain: string): Promise<string | null> {
    try {
      // Use environment-specific directory structure
      const isStaging = process.env.LETSENCRYPT_STAGING !== 'false';
      const envDir = isStaging ? 'staging' : 'prod';
      const fullChainPath = path.join(process.env.ACCOUNTS_DIR || './accounts', domain, envDir, 'fullchain.pem');
      
      if (!fs.existsSync(fullChainPath)) {
        // Try to find certificate.pem as fallback
        const certPath = path.join(process.env.ACCOUNTS_DIR || './accounts', domain, envDir, 'certificate.pem');
        if (!fs.existsSync(certPath)) {
          return null;
        }
        
        const certificateData = await fs.promises.readFile(certPath, 'utf8');
        const cert = new crypto.X509Certificate(certificateData);

        const thirtyDaysFromNow = new Date();
        thirtyDaysFromNow.setDate(thirtyDaysFromNow.getDate() + 30);

        if (new Date(cert.validTo) > thirtyDaysFromNow) {
          const envType = isStaging ? 'staging' : 'production';
          Logger.info(`Found existing certificate for ${domain} that is valid for more than 30 days (${envType}).`);
          return certificateData;
        }

        return null;
      }

      const certificateData = await fs.promises.readFile(fullChainPath, 'utf8');
      const cert = new crypto.X509Certificate(certificateData);

      const thirtyDaysFromNow = new Date();
      thirtyDaysFromNow.setDate(thirtyDaysFromNow.getDate() + 30);

      if (new Date(cert.validTo) > thirtyDaysFromNow) {
        const envType = isStaging ? 'staging' : 'production';
        Logger.info(`Found existing certificate for ${domain} that is valid for more than 30 days (${envType}).`);
        return certificateData;
      }

      return null;
    } catch (error) {
      Logger.error(`Error checking for existing certificate for ${domain}:`, error);
      return null;
    }
  }

  private async updateStatus(status: RenewalStatus, newStatus: RenewalStatus['status'], message: string, progress: number): Promise<void> {
    status.status = newStatus;
    status.message = message;
    status.progress = progress;
    status.logs.push(`${new Date().toISOString()}: ${message}`);
    Logger.info(`Renewal ${status.id}: ${message}`);
    
    // Save to database if available
    if (this.database) {
      await this.database.saveRenewalStatus(
        status.id,
        status.connectionId,
        newStatus,
        undefined,
        message,
        status.error,
        status.logs
      ).catch(err => {
        Logger.error(`Failed to save renewal status to database: ${err.message}`);
      });
    }
  }

  private async generateCSRFromCUCM(connection: ConnectionRecord, status: RenewalStatus): Promise<string> {
    return new Promise(async (resolve, reject) => {
      try {
        // Construct full FQDN from hostname and domain
        const fullFQDN = `${connection.hostname}.${connection.domain}`;
        
        // Check if we have an existing CSR
        const existingCSR = await accountManager.loadCSR(fullFQDN);
        if (existingCSR) {
          status.logs.push(`Using existing CSR for ${fullFQDN}`);
          await accountManager.saveRenewalLog(fullFQDN, `Using existing CSR for renewal`);
          resolve(existingCSR);
          return;
        }

        if (!connection.username || !connection.password) {
          throw new Error('Username and password are required for VOS applications');
        }

        const authHeader = `Basic ${Buffer.from(`${connection.username}:${connection.password}`).toString('base64')}`;
        Logger.info(`Using Authorization header: ${authHeader}`);
        
        // Parse altNames from comma-separated string
        const altNames = connection.alt_names 
          ? connection.alt_names.split(',').map(name => name.trim()).filter(name => name.length > 0)
          : [];

        const csrPayload = {
          'service': 'tomcat',
          'distribution': 'this-server',
          'commonName': fullFQDN,
          'keyType': 'rsa',
          'keyLength': 2048,
          'hashAlgorithm': 'sha256',
          ...(altNames.length > 0 && { 'altNames': altNames })
        };

        const options = {
          hostname: fullFQDN,
          port: 443,
          path: '/platformcom/api/v1/certmgr/config/csr',
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': authHeader,
            'Accept': 'application/json',
            'Content-Length': Buffer.byteLength(JSON.stringify(csrPayload))
          },
          rejectUnauthorized: false,
          timeout: 30000
        };

        const postData = JSON.stringify(csrPayload);

        Logger.info(`Sending CSR request to ${fullFQDN}:${options.port}${options.path}`);
        Logger.info(`CSR Request Body: ${postData}`);
        Logger.info(`Using credentials for user: ${connection.username}`);
        
        // Log detailed CSR information to renewal log
        await accountManager.saveRenewalLog(fullFQDN, `=== CSR Generation Request ===`);
        await accountManager.saveRenewalLog(fullFQDN, `Target: ${fullFQDN}:${options.port}${options.path}`);
        await accountManager.saveRenewalLog(fullFQDN, `Service: ${csrPayload.service}`);
        await accountManager.saveRenewalLog(fullFQDN, `Common Name: ${csrPayload.commonName}`);
        await accountManager.saveRenewalLog(fullFQDN, `Key Type: ${csrPayload.keyType}, Length: ${csrPayload.keyLength}`);
        await accountManager.saveRenewalLog(fullFQDN, `Hash Algorithm: ${csrPayload.hashAlgorithm}`);
        if (altNames.length > 0) {
          await accountManager.saveRenewalLog(fullFQDN, `Alt Names: ${altNames.join(', ')}`);
        }
        await accountManager.saveRenewalLog(fullFQDN, `Request Body: ${postData}`);
        await accountManager.saveRenewalLog(fullFQDN, `Using credentials for user: ${connection.username}`);
        
        // Test basic connectivity first
        Logger.info(`Testing CUCM connectivity and authentication...`);
        await accountManager.saveRenewalLog(fullFQDN, `Testing CUCM connectivity and authentication...`);
        
        const req = https.request(options, (res) => {
          let data = '';
          res.on('data', (chunk) => data += chunk);
          res.on('end', async () => {
            try {
              Logger.info(`CSR API Response Status: ${res.statusCode}`);
              Logger.info(`CSR API Response Body: ${data}`);
              
              await accountManager.saveRenewalLog(fullFQDN, `CSR API Response Status: ${res.statusCode}`);
              await accountManager.saveRenewalLog(fullFQDN, `CSR API Response Body: ${data}`);
              
              if (res.statusCode !== 200) {
                const errorMsg = `CSR API returned status ${res.statusCode}: ${data}`;
                await accountManager.saveRenewalLog(fullFQDN, `ERROR: ${errorMsg}`);
                reject(new Error(errorMsg));
                return;
              }
              
              const response = JSON.parse(data);
              if (response.csr) {
                // Save CSR to accounts folder
                await accountManager.saveCSR(fullFQDN, response.csr);
                await accountManager.saveRenewalLog(fullFQDN, `Generated new CSR from ${fullFQDN} for service: tomcat`);
                await accountManager.saveRenewalLog(fullFQDN, `CSR length: ${response.csr.length} characters`);
                
                status.logs.push(`CSR generated successfully from ${fullFQDN} for service: tomcat`);
                resolve(response.csr);
              } else {
                const errorMsg = `CSR not found in response. Response: ${JSON.stringify(response)}`;
                await accountManager.saveRenewalLog(fullFQDN, `ERROR: ${errorMsg}`);
                reject(new Error(errorMsg));
              }
            } catch (error) {
              const errorMsg = `Failed to parse CSR response: ${error}. Raw response: ${data}`;
              await accountManager.saveRenewalLog(fullFQDN, `ERROR: ${errorMsg}`);
              reject(new Error(errorMsg));
            }
          });
        });

        req.on('error', async (error) => {
          const errorMsg = `CSR generation failed: ${error.message}`;
          await accountManager.saveRenewalLog(fullFQDN, `ERROR: ${errorMsg}`);
          reject(new Error(errorMsg));
        });

        req.write(postData);
        req.end();
      } catch (error) {
        reject(error);
      }
    });
  }

  private async requestCertificate(connection: ConnectionRecord, csr: string, database: DatabaseManager, status: RenewalStatus): Promise<string> {
    // Get SSL provider settings
    const sslProvider = connection.ssl_provider || 'letsencrypt';
    const settings = await database.getSettingsByProvider(sslProvider);
    
    if (sslProvider === 'letsencrypt') {
      return this.requestLetsEncryptCertificate(connection, csr, settings, database, status);
    } else if (sslProvider === 'zerossl') {
      return this.requestZeroSSLCertificate(connection, csr, settings, status);
    } else {
      throw new Error(`Unsupported SSL provider: ${sslProvider}`);
    }
  }

  private async requestLetsEncryptCertificate(connection: ConnectionRecord, csr: string, settings: any[], database: DatabaseManager, status: RenewalStatus): Promise<string> {
    try {
      const { acmeClient } = await import('./acme-client');
      const CloudflareProvider = (await import('./dns-providers/cloudflare')).default;
      
      const fullFQDN = `${connection.hostname}.${connection.domain}`;
      
      // Parse altNames from connection
      const altNames = connection.alt_names 
        ? connection.alt_names.split(',').map(name => name.trim()).filter(name => name.length > 0)
        : [];
      
      const domains = [fullFQDN, ...altNames];
      
      // Log renewal start
      await accountManager.saveRenewalLog(fullFQDN, `=== Let's Encrypt Certificate Renewal Started ===`);
      await accountManager.saveRenewalLog(fullFQDN, `Domains: ${domains.join(', ')}`);
      await accountManager.saveRenewalLog(fullFQDN, `Environment: ${process.env.LETSENCRYPT_STAGING !== 'false' ? 'STAGING' : 'PRODUCTION'}`);
      
      await this.updateStatus(status, 'creating_account', 'Setting up Let\'s Encrypt account', 20);
      
      // Load existing ACME account
      const account = await acmeClient.loadAccount(fullFQDN);
      if (!account) {
        const isStaging = process.env.LETSENCRYPT_STAGING !== 'false';
        const envType = isStaging ? 'STAGING' : 'PRODUCTION';
        const errorMsg = `No Let's Encrypt account found for ${fullFQDN} in ${envType} mode. The account should have been created during server startup. Please restart the server to create missing accounts.`;
        
        Logger.error(errorMsg);
        await accountManager.saveRenewalLog(fullFQDN, `ERROR: ${errorMsg}`);
        
        // Try to create account as fallback
        const email = settings.find(s => s.key_name === 'LETSENCRYPT_EMAIL')?.key_value;
        if (!email) {
          throw new Error('Let\'s Encrypt email not configured in settings. Please add LETSENCRYPT_EMAIL to your settings.');
        }
        
        Logger.info(`Attempting to create account as fallback with email: ${email}`);
        await accountManager.saveRenewalLog(fullFQDN, `Attempting to create account as fallback with email: ${email}`);
        
        try {
          const newAccount = await acmeClient.createAccount(email, fullFQDN);
          await accountManager.saveRenewalLog(fullFQDN, `Account created successfully as fallback`);
          await accountManager.saveRenewalLog(fullFQDN, `Account URL: ${newAccount.accountUrl}`);
        } catch (accountError) {
          Logger.error(`Failed to create account as fallback:`, accountError);
          await accountManager.saveRenewalLog(fullFQDN, `Failed to create account: ${accountError instanceof Error ? accountError.message : 'Unknown error'}`);
          throw new Error(`Failed to create Let's Encrypt account for ${fullFQDN}. ${accountError instanceof Error ? accountError.message : 'Unknown error'}`);
        }
      } else {
        Logger.info(`Using existing account for domain: ${fullFQDN}`);
        await accountManager.saveRenewalLog(fullFQDN, `Using existing account for domain: ${fullFQDN}`);
        await accountManager.saveRenewalLog(fullFQDN, `Account URL: ${account.accountUrl}`);
      }
      
      await this.updateStatus(status, 'requesting_certificate', 'Requesting certificate from Let\'s Encrypt', 30);
      
      // Create certificate order
      await accountManager.saveRenewalLog(fullFQDN, `Creating certificate order for domains: ${domains.join(', ')}`);
      const order = await acmeClient.requestCertificate(csr, domains);
      await accountManager.saveRenewalLog(fullFQDN, `Certificate order created: ${order.order.url}`);
      
      await this.updateStatus(status, 'creating_dns_challenge', 'Setting up DNS challenges', 40);
      
      // Initialize Cloudflare provider
      const cloudflare = await CloudflareProvider.create(database, fullFQDN);
      await accountManager.saveRenewalLog(fullFQDN, `Cloudflare DNS provider initialized`);
      
      // Create DNS TXT records for challenges
      const dnsRecords: any[] = [];
      await accountManager.saveRenewalLog(fullFQDN, `Setting up ${order.challenges.length} DNS challenge(s)`);
      
      for (const challenge of order.challenges) {
        const keyAuthorization = await acmeClient.getChallengeKeyAuthorization(challenge);
        
        // Log the key authorization for debugging
        await accountManager.saveRenewalLog(fullFQDN, `Key authorization: ${keyAuthorization}`);
        
        const dnsValue = acmeClient.getDNSRecordValue(keyAuthorization);
        
        // Extract domain from challenge
        const challengeDomain = challenge.url.includes('identifier') 
          ? domains.find(d => challenge.url.includes(d)) || domains[0]
          : domains[0];
        
        await accountManager.saveRenewalLog(fullFQDN, `Processing challenge for domain: ${challengeDomain}`);
        await accountManager.saveRenewalLog(fullFQDN, `Challenge URL: ${challenge.url}`);
        await accountManager.saveRenewalLog(fullFQDN, `DNS value: ${dnsValue}`);
        
        // Clean up any existing TXT records before creating new one
        await accountManager.saveRenewalLog(fullFQDN, `Cleaning up existing TXT records for ${challengeDomain}`);
        await cloudflare.cleanupTxtRecords(challengeDomain);
        
        const record = await cloudflare.createTxtRecord(challengeDomain, dnsValue);
        dnsRecords.push({ record, challenge, domain: challengeDomain });
        
        await accountManager.saveRenewalLog(fullFQDN, `Created DNS TXT record for ${challengeDomain}: ${record.id}`);
        status.logs.push(`Created DNS TXT record for ${challengeDomain}: ${record.id}`);
      }
      
      await this.updateStatus(status, 'waiting_dns_propagation', 'Waiting for DNS propagation', 50);
      await accountManager.saveRenewalLog(fullFQDN, `Waiting for DNS propagation of ${dnsRecords.length} record(s)`);
      
      // Wait for DNS propagation
      for (const { challenge, domain } of dnsRecords) {
        const keyAuthorization = await acmeClient.getChallengeKeyAuthorization(challenge);
        const expectedValue = acmeClient.getDNSRecordValue(keyAuthorization);
        
        await accountManager.saveRenewalLog(fullFQDN, `Verifying DNS propagation for ${domain}, expected value: ${expectedValue}`);
        const isVerified = await cloudflare.verifyTxtRecord(domain, expectedValue);
        if (!isVerified) {
          await accountManager.saveRenewalLog(fullFQDN, `ERROR: DNS propagation verification failed for ${domain}`);
          throw new Error(`DNS propagation verification failed for ${domain}`);
        }
        
        await accountManager.saveRenewalLog(fullFQDN, `DNS propagation verified for ${domain}`);
        status.logs.push(`DNS propagation verified for ${domain}`);
      }
      
      await this.updateStatus(status, 'completing_validation', 'Completing Let\'s Encrypt validation', 70);
      await accountManager.saveRenewalLog(fullFQDN, `Completing ${dnsRecords.length} Let's Encrypt challenge(s)`);
      
      // Complete challenges
      for (const { challenge } of dnsRecords) {
        await accountManager.saveRenewalLog(fullFQDN, `Completing challenge: ${challenge.url}`);
        await acmeClient.completeChallenge(challenge);
        await accountManager.saveRenewalLog(fullFQDN, `Challenge completed successfully: ${challenge.url}`);
      }
      
      // Add delay to ensure Let's Encrypt processes the completed challenges
      Logger.info('Waiting for Let\'s Encrypt to process challenge completion...');
      await accountManager.saveRenewalLog(fullFQDN, `Waiting 3 seconds for Let's Encrypt to process challenge completion...`);
      await new Promise(resolve => setTimeout(resolve, 3000));
      
      // Wait for order completion
      await accountManager.saveRenewalLog(fullFQDN, `Waiting for order completion: ${order.order.url}`);
      const completedOrder = await acmeClient.waitForOrderCompletion(order.order);
      await accountManager.saveRenewalLog(fullFQDN, `Order completed successfully`);
      
      await this.updateStatus(status, 'downloading_certificate', 'Downloading certificate', 80);
      
      // Finalize and get certificate
      await accountManager.saveRenewalLog(fullFQDN, `Finalizing certificate order`);
      const certificate = await acmeClient.finalizeCertificate(completedOrder, csr);
      await accountManager.saveRenewalLog(fullFQDN, `Certificate downloaded successfully`);
      
      // Clean up DNS records - skip in staging mode for debugging
      const isStaging = process.env.LETSENCRYPT_STAGING !== 'false';
      if (!isStaging || process.env.LETSENCRYPT_CLEANUP_DNS === 'true') {
        await accountManager.saveRenewalLog(fullFQDN, `Cleaning up ${dnsRecords.length} DNS TXT record(s)`);
        for (const { record } of dnsRecords) {
          try {
            await cloudflare.deleteTxtRecord(record.id);
            await accountManager.saveRenewalLog(fullFQDN, `Cleaned up DNS TXT record: ${record.id}`);
            status.logs.push(`Cleaned up DNS TXT record: ${record.id}`);
          } catch (error) {
            Logger.warn(`Failed to clean up DNS record ${record.id}:`, error);
            await accountManager.saveRenewalLog(fullFQDN, `WARNING: Failed to clean up DNS record ${record.id}: ${error instanceof Error ? error.message : 'Unknown error'}`);
          }
        }
      } else {
        Logger.info(`Skipping DNS record cleanup in staging mode (${dnsRecords.length} records)`);
        await accountManager.saveRenewalLog(fullFQDN, `Skipping DNS record cleanup in staging mode (${dnsRecords.length} records)`);
        status.logs.push(`Skipped DNS cleanup in staging mode for debugging`);
      }
      
      // Save certificate and chain to accounts folder
      await this.saveCertificateFiles(fullFQDN, certificate, status);
      
      await accountManager.saveRenewalLog(fullFQDN, `=== Certificate obtained successfully from Let's Encrypt ===`);
      status.logs.push('Certificate obtained from Let\'s Encrypt');
      return certificate;
      
    } catch (error) {
      const fullFQDN = `${connection.hostname}.${connection.domain}`;
      Logger.error('Let\'s Encrypt certificate request failed:', error);
      
      // Log detailed error information
      await accountManager.saveRenewalLog(fullFQDN, `=== ERROR: Let's Encrypt certificate request failed ===`);
      await accountManager.saveRenewalLog(fullFQDN, `Error: ${error instanceof Error ? error.message : 'Unknown error'}`);
      
      if (error instanceof Error && error.stack) {
        await accountManager.saveRenewalLog(fullFQDN, `Stack trace: ${error.stack}`);
      }
      
      // If it's a JSON error with detailed info, log that too
      try {
        const errorObj = JSON.parse(error instanceof Error ? error.message : String(error));
        if (errorObj && typeof errorObj === 'object') {
          await accountManager.saveRenewalLog(fullFQDN, `Detailed error: ${JSON.stringify(errorObj, null, 2)}`);
          
          // If we have authorization URLs, try to get detailed auth info
          if (errorObj.authorizations && Array.isArray(errorObj.authorizations)) {
            await accountManager.saveRenewalLog(fullFQDN, `Attempting to fetch detailed authorization information...`);
            // The detailed auth info will be logged by the ACME client's enhanced error handling
          }
        }
      } catch {
        // Not a JSON error, ignore
      }
      
      throw error;
    }
  }

  private async requestZeroSSLCertificate(connection: ConnectionRecord, csr: string, _settings: any[], status: RenewalStatus): Promise<string> {
    try {
      const { ZeroSSLProvider } = await import('./ssl-providers/zerossl');
      const { MXToolboxService } = await import('./services/mxtoolbox');
      
      if (!this.database) {
        throw new Error('Database not initialized');
      }

      const zeroSSL = await ZeroSSLProvider.create(this.database);
      const mxToolbox = await MXToolboxService.create(this.database);
      
      const fullFQDN = `${connection.hostname}.${connection.domain}`;
      const domains = [fullFQDN];
      
      // Add alt_names if provided
      if (connection.alt_names) {
        const altNames = connection.alt_names.split(',').map(name => name.trim()).filter(name => name);
        domains.push(...altNames);
      }

      await this.updateStatus(status, 'requesting_certificate', 'Creating ZeroSSL certificate request', 30);
      
      // Create certificate with ZeroSSL
      const certificate = await zeroSSL.createCertificate(domains, csr);
      status.logs.push(`ZeroSSL certificate created with ID: ${certificate.id}`);

      await this.updateStatus(status, 'creating_dns_challenge', 'Setting up DNS validation', 40);
      
      // Get validation details
      const validations = await zeroSSL.getValidationDetails(certificate.id);
      status.logs.push(`Retrieved validation details for ${validations.length} domains`);

      // Create DNS records for validation
      const dnsProvider = connection.dns_provider || 'cloudflare';
      
      for (const validation of validations) {
        if (validation.details?.cname_validation_p1 && validation.details?.cname_validation_p2) {
          const recordName = validation.details.cname_validation_p1;
          const recordValue = validation.details.cname_validation_p2;
          
          status.logs.push(`Creating CNAME record: ${recordName} -> ${recordValue}`);
          
          // Create DNS record using the configured DNS provider
          await this.createDNSRecordForValidation(dnsProvider, recordName, recordValue, 'CNAME');
          
          // Store record for cleanup
          this.dnsRecordIds.push(`CNAME_${recordName}`);
        }
      }

      await this.updateStatus(status, 'waiting_dns_propagation', 'Waiting for DNS propagation via MXToolbox', 50);
      
      // Wait for DNS propagation using MXToolbox
      for (const validation of validations) {
        if (validation.details?.cname_validation_p1 && validation.details?.cname_validation_p2) {
          const recordName = validation.details.cname_validation_p1;
          const recordValue = validation.details.cname_validation_p2;
          
          const isVerified = await mxToolbox.waitForDNSPropagation(
            recordName,
            recordValue,
            'CNAME',
            180000 // 3 minutes timeout
          );
          
          if (!isVerified) {
            throw new Error(`DNS propagation failed for ${recordName}`);
          }
          
          status.logs.push(`CNAME record verified: ${recordName}`);
        }
      }

      await this.updateStatus(status, 'completing_validation', 'Triggering ZeroSSL validation', 70);
      
      // Verify domains with ZeroSSL
      for (const validation of validations) {
        await zeroSSL.verifyDomain(certificate.id, validation.domain);
        status.logs.push(`Verification triggered for ${validation.domain}`);
      }

      await this.updateStatus(status, 'downloading_certificate', 'Waiting for certificate issuance', 80);
      
      // Wait for certificate to be issued and download it
      const certificateData = await zeroSSL.waitForCertificate(certificate.id, 300000); // 5 minutes
      status.logs.push('ZeroSSL certificate downloaded successfully');

      return certificateData;
    } catch (error) {
      Logger.error(`ZeroSSL certificate request failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
      throw error;
    }
  }

  private async createDNSRecordForValidation(dnsProvider: string, recordName: string, recordValue: string, recordType: string = 'TXT'): Promise<void> {
    if (!this.database) {
      throw new Error('Database not initialized');
    }

    try {
      if (dnsProvider === 'cloudflare') {
        const { CloudflareProvider } = await import('./dns-providers/cloudflare');
        const cloudflare = await CloudflareProvider.create(this.database, recordName);
        await cloudflare.createDNSRecord(recordName, recordValue, recordType);
      } else if (dnsProvider === 'digitalocean') {
        const { DigitalOceanDNSProvider } = await import('./dns-providers/digitalocean');
        const digitalOcean = await DigitalOceanDNSProvider.create(this.database, recordName);
        await digitalOcean.createDNSRecord(recordName, recordValue, recordType);
      } else if (dnsProvider === 'route53') {
        const { Route53DNSProvider } = await import('./dns-providers/route53');
        const route53 = await Route53DNSProvider.create(this.database, recordName);
        await route53.createDNSRecord(recordName, recordValue, recordType);
      } else if (dnsProvider === 'azure') {
        const { AzureDNSProvider } = await import('./dns-providers/azure');
        const azure = await AzureDNSProvider.create(this.database, recordName);
        await azure.createDNSRecord(recordName, recordValue, recordType);
      } else if (dnsProvider === 'google') {
        const { GoogleDNSProvider } = await import('./dns-providers/google');
        const google = await GoogleDNSProvider.create(this.database, recordName);
        await google.createDNSRecord(recordName, recordValue, recordType);
      } else {
        throw new Error(`DNS provider ${dnsProvider} not supported for ZeroSSL CNAME validation`);
      }
    } catch (error) {
      Logger.error(`Failed to create DNS record: ${error instanceof Error ? error.message : 'Unknown error'}`);
      throw error;
    }
  }

  private async handleDNSChallenge(connection: ConnectionRecord, database: DatabaseManager, status: RenewalStatus): Promise<void> {
    const dnsProvider = connection.dns_provider || 'cloudflare';
    const settings = await database.getSettingsByProvider(dnsProvider);
    
    if (dnsProvider === 'cloudflare') {
      await this.handleCloudflareChallenge(connection, settings, status);
    } else if (dnsProvider === 'digitalocean') {
      await this.handleDigitalOceanChallenge(connection, settings, status);
    } else if (dnsProvider === 'route53') {
      await this.handleRoute53Challenge(connection, settings, status);
    } else if (dnsProvider === 'azure') {
      await this.handleAzureChallenge(connection, settings, status);
    } else if (dnsProvider === 'google') {
      await this.handleGoogleChallenge(connection, settings, status);
    } else if (dnsProvider === 'custom') {
      await this.handleCustomDNSChallenge(connection, settings, status);
    } else {
      throw new Error(`Unsupported DNS provider: ${dnsProvider}`);
    }
  }

  private async handleCloudflareChallenge(_connection: ConnectionRecord, settings: any[], status: RenewalStatus): Promise<void> {
    const cfKey = settings.find(s => s.key_name === 'CF_KEY')?.key_value;
    const cfZone = settings.find(s => s.key_name === 'CF_ZONE')?.key_value;
    
    if (!cfKey || !cfZone) {
      throw new Error('Cloudflare API key or zone ID not configured');
    }

    status.logs.push('Managing DNS challenge via Cloudflare');
    
    // TODO: Implement Cloudflare API integration
    // This would involve:
    // 1. Creating TXT record for _acme-challenge.domain
    // 2. Waiting for DNS propagation
    // 3. Cleaning up the TXT record after challenge
    
    return new Promise((resolve) => {
      setTimeout(() => {
        status.logs.push('DNS challenge completed via Cloudflare');
        resolve();
      }, 1000);
    });
  }

  private async handleDigitalOceanChallenge(connection: ConnectionRecord, _settings: any[], status: RenewalStatus): Promise<void> {
    const fullFQDN = `${connection.hostname}.${connection.domain}`;
    
    try {
      const { DigitalOceanDNSProvider } = await import('./dns-providers/digitalocean');
      if (!this.database) {
        throw new Error('Database not initialized');
      }
      const digitalOceanDNS = await DigitalOceanDNSProvider.create(this.database, fullFQDN);
      
      await this.updateStatus(status, 'dns_validation', 'Creating DNS records in DigitalOcean', 50);
      
      // Process each authorization
      for (const authz of this.authzRecords) {
        const challenge = authz.challenges.find((ch: any) => ch.type === 'dns-01');
        if (!challenge) continue;
        
        const recordName = `_acme-challenge.${authz.identifier.value}`;
        const keyAuth = challenge.keyAuthorization;
        
        // Create the DNS record
        const record = await digitalOceanDNS.createDNSRecord(recordName, keyAuth, 'TXT');
        status.logs.push(`Created DigitalOcean DNS record with ID: ${record.id}`);
        
        // Store record ID for cleanup
        this.dnsRecordIds.push(record.id.toString());
      }
      
      // Wait for DNS propagation
      await this.updateStatus(status, 'waiting_dns_propagation', 'Waiting for DNS propagation', 60);
      
      for (const authz of this.authzRecords) {
        const recordName = `_acme-challenge.${authz.identifier.value}`;
        const challenge = authz.challenges.find((ch: any) => ch.type === 'dns-01');
        if (!challenge) continue;
        
        const isVerified = await digitalOceanDNS.waitForDNSPropagation(
          recordName,
          challenge.keyAuthorization,
          120000 // 2 minutes timeout
        );
        
        if (!isVerified) {
          throw new Error(`DNS propagation failed for ${recordName}`);
        }
      }
      
      await this.updateStatus(status, 'completing_validation', 'DNS propagation confirmed - completing validation', 70);
      
    } catch (error) {
      Logger.error(`DigitalOcean DNS challenge failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
      throw error;
    }
  }

  private async handleRoute53Challenge(connection: ConnectionRecord, _settings: any[], status: RenewalStatus): Promise<void> {
    const fullFQDN = `${connection.hostname}.${connection.domain}`;
    
    try {
      const { Route53DNSProvider } = await import('./dns-providers/route53');
      if (!this.database) {
        throw new Error('Database not initialized');
      }
      const route53DNS = await Route53DNSProvider.create(this.database, fullFQDN);
      
      await this.updateStatus(status, 'dns_validation', 'Creating DNS records in Route53', 50);
      
      // Process each authorization
      for (const authz of this.authzRecords) {
        const challenge = authz.challenges.find((ch: any) => ch.type === 'dns-01');
        if (!challenge) continue;
        
        const recordName = `_acme-challenge.${authz.identifier.value}`;
        const keyAuth = challenge.keyAuthorization;
        
        // Create the DNS record
        const record = await route53DNS.createDNSRecord(recordName, keyAuth, 'TXT');
        status.logs.push(`Created Route53 DNS record: ${record.id}`);
        
        // Store record ID for cleanup
        this.dnsRecordIds.push(record.id);
      }
      
      // Wait for DNS propagation
      await this.updateStatus(status, 'waiting_dns_propagation', 'Waiting for DNS propagation', 60);
      
      for (const authz of this.authzRecords) {
        const recordName = `_acme-challenge.${authz.identifier.value}`;
        const challenge = authz.challenges.find((ch: any) => ch.type === 'dns-01');
        if (!challenge) continue;
        
        const isVerified = await route53DNS.waitForDNSPropagation(
          recordName,
          challenge.keyAuthorization,
          120000 // 2 minutes timeout
        );
        
        if (!isVerified) {
          throw new Error(`DNS propagation failed for ${recordName}`);
        }
      }
      
      await this.updateStatus(status, 'completing_validation', 'DNS propagation confirmed - completing validation', 70);
      
    } catch (error) {
      Logger.error(`Route53 DNS challenge failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
      throw error;
    }
  }

  private async handleAzureChallenge(connection: ConnectionRecord, _settings: any[], status: RenewalStatus): Promise<void> {
    const fullFQDN = `${connection.hostname}.${connection.domain}`;
    
    try {
      const { AzureDNSProvider } = await import('./dns-providers/azure');
      if (!this.database) {
        throw new Error('Database not initialized');
      }
      const azureDNS = await AzureDNSProvider.create(this.database, fullFQDN);
      
      await this.updateStatus(status, 'dns_validation', 'Creating DNS records in Azure', 50);
      
      // Process each authorization
      for (const authz of this.authzRecords) {
        const challenge = authz.challenges.find((ch: any) => ch.type === 'dns-01');
        if (!challenge) continue;
        
        const recordName = `_acme-challenge.${authz.identifier.value}`;
        const keyAuth = challenge.keyAuthorization;
        
        // Create the DNS record
        const record = await azureDNS.createDNSRecord(recordName, keyAuth, 'TXT');
        status.logs.push(`Created Azure DNS record: ${record.id}`);
        
        // Store record ID for cleanup
        this.dnsRecordIds.push(record.id);
      }
      
      // Wait for DNS propagation
      await this.updateStatus(status, 'waiting_dns_propagation', 'Waiting for DNS propagation', 60);
      
      for (const authz of this.authzRecords) {
        const recordName = `_acme-challenge.${authz.identifier.value}`;
        const challenge = authz.challenges.find((ch: any) => ch.type === 'dns-01');
        if (!challenge) continue;
        
        const isVerified = await azureDNS.waitForDNSPropagation(
          recordName,
          challenge.keyAuthorization,
          120000 // 2 minutes timeout
        );
        
        if (!isVerified) {
          throw new Error(`DNS propagation failed for ${recordName}`);
        }
      }
      
      await this.updateStatus(status, 'completing_validation', 'DNS propagation confirmed - completing validation', 70);
      
    } catch (error) {
      Logger.error(`Azure DNS challenge failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
      throw error;
    }
  }

  private async handleGoogleChallenge(connection: ConnectionRecord, _settings: any[], status: RenewalStatus): Promise<void> {
    const fullFQDN = `${connection.hostname}.${connection.domain}`;
    
    try {
      const { GoogleDNSProvider } = await import('./dns-providers/google');
      if (!this.database) {
        throw new Error('Database not initialized');
      }
      const googleDNS = await GoogleDNSProvider.create(this.database, fullFQDN);
      
      await this.updateStatus(status, 'dns_validation', 'Creating DNS records in Google Cloud', 50);
      
      // Process each authorization
      for (const authz of this.authzRecords) {
        const challenge = authz.challenges.find((ch: any) => ch.type === 'dns-01');
        if (!challenge) continue;
        
        const recordName = `_acme-challenge.${authz.identifier.value}`;
        const keyAuth = challenge.keyAuthorization;
        
        // Create the DNS record
        const record = await googleDNS.createDNSRecord(recordName, keyAuth, 'TXT');
        status.logs.push(`Created Google Cloud DNS record: ${record.id}`);
        
        // Store record ID for cleanup
        this.dnsRecordIds.push(record.id);
      }
      
      // Wait for DNS propagation
      await this.updateStatus(status, 'waiting_dns_propagation', 'Waiting for DNS propagation', 60);
      
      for (const authz of this.authzRecords) {
        const recordName = `_acme-challenge.${authz.identifier.value}`;
        const challenge = authz.challenges.find((ch: any) => ch.type === 'dns-01');
        if (!challenge) continue;
        
        const isVerified = await googleDNS.waitForDNSPropagation(
          recordName,
          challenge.keyAuthorization,
          120000 // 2 minutes timeout
        );
        
        if (!isVerified) {
          throw new Error(`DNS propagation failed for ${recordName}`);
        }
      }
      
      await this.updateStatus(status, 'completing_validation', 'DNS propagation confirmed - completing validation', 70);
      
    } catch (error) {
      Logger.error(`Google Cloud DNS challenge failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
      throw error;
    }
  }

  private async handleCustomDNSChallenge(connection: ConnectionRecord, _settings: any[], status: RenewalStatus): Promise<void> {
    const fullFQDN = `${connection.hostname}.${connection.domain}`;
    
    try {
      // Import the custom DNS provider
      const { CustomDNSProvider } = await import('./dns-providers/custom');
      if (!this.database) {
        throw new Error('Database not initialized');
      }
      const customDNS = await CustomDNSProvider.create(this.database, fullFQDN);
      
      await this.updateStatus(status, 'waiting_dns_propagation', 'Manual DNS entry required - waiting for admin', 60);
      
      // Get the challenges that were created in the renewal flow
      const challenges = status.challenges || [];
      
      for (const challenge of challenges) {
        const keyAuth = challenge.keyAuthorization;
        const recordName = `_acme-challenge.${fullFQDN}`;
        
        // Create the DNS record instruction
        await customDNS.createDNSRecord(recordName, keyAuth, 'TXT');
        
        // Log manual instructions
        const instructions = customDNS.getManualInstructions(recordName, keyAuth);
        await accountManager.saveRenewalLog(fullFQDN, instructions);
        status.logs.push('Manual DNS entry required - check renewal logs for instructions');
        
        // Store renewal status with manual entry state
        status.manualDNSEntry = {
          recordName,
          recordValue: keyAuth,
          instructions
        };
        
        // Update status to indicate manual intervention needed
        await this.updateStatus(status, 'waiting_manual_dns', 'Waiting for manual DNS entry', 65);
        
        // Wait for manual DNS entry (5 minute timeout)
        const maxWaitTime = 300000; // 5 minutes
        Logger.info(`Waiting for manual DNS entry for ${recordName}`);
        await accountManager.saveRenewalLog(fullFQDN, `Waiting for manual DNS entry. Timeout: ${maxWaitTime / 1000} seconds`);
        
        const isVerified = await customDNS.waitForManualEntry(recordName, keyAuth, maxWaitTime);
        
        if (!isVerified) {
          throw new Error(`Manual DNS entry verification timed out after ${maxWaitTime / 1000} seconds`);
        }
        
        await accountManager.saveRenewalLog(fullFQDN, `Manual DNS entry verified successfully`);
        status.logs.push(`DNS record verified: ${recordName}`);
      }
      
      await this.updateStatus(status, 'completing_validation', 'Manual DNS entries verified - completing validation', 70);
      
    } catch (error) {
      Logger.error(`Custom DNS challenge failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
      throw error;
    }
  }

  private async uploadCertificateToCUCM(connection: ConnectionRecord, certificate: string, status: RenewalStatus): Promise<void> {
    return new Promise(async (resolve, reject) => {
      try {
        // Parse the certificate chain into individual certificates
        const certParts = certificate.split('-----END CERTIFICATE-----');
        const certificates = certParts
          .filter(part => part.includes('-----BEGIN CERTIFICATE-----'))
          .map(part => (part.trim() + '\n-----END CERTIFICATE-----'));

        if (certificates.length === 0) {
          return reject(new Error('No certificates found to upload.'));
        }

        const leafCert = certificates[0];
        const caCerts = certificates.slice(1);

        // Upload the leaf certificate
        await this.uploadLeafCertificate(connection, leafCert, status);

        // Upload the CA certificates
        if (caCerts.length > 0) {
          await this.uploadCaCertificates(connection, caCerts, status);
        }

        resolve();
      } catch (error) {
        reject(error);
      }
    });
  }

  private async uploadLeafCertificate(connection: ConnectionRecord, certificate: string, status: RenewalStatus): Promise<void> {
    return new Promise(async (resolve, reject) => {
      const fullFQDN = `${connection.hostname}.${connection.domain}`;
      
      if (!connection.username || !connection.password) {
        reject(new Error('Username and password are required for VOS application certificate upload'));
        return;
      }

      const postData = JSON.stringify({
        service: 'tomcat',
        certificates: [certificate]
      });

      const options = {
        hostname: fullFQDN,
        port: 443,
        path: '/platformcom/api/v1/certmgr/config/identity/certificates',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Basic ${Buffer.from(`${connection.username}:${connection.password}`).toString('base64')}`,
          'Content-Length': Buffer.byteLength(postData)
        },
        rejectUnauthorized: false
      };

      Logger.info(`CUCM leaf cert upload request body: ${postData}`);
      await accountManager.saveRenewalLog(fullFQDN, `CUCM leaf certificate upload request to ${fullFQDN}:${options.port}${options.path}`);
      await accountManager.saveRenewalLog(fullFQDN, `Request body: ${postData}`);

      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', (chunk) => data += chunk);
        res.on('end', async () => {
          try {
            Logger.info(`CUCM leaf cert upload response: ${data}`);
            await accountManager.saveRenewalLog(fullFQDN, `CUCM leaf cert upload response (${res.statusCode}): ${data}`);
            if (res.statusCode === 200 || res.statusCode === 201) {
              status.logs.push(`Leaf certificate uploaded successfully to ${fullFQDN}`);
              await accountManager.saveRenewalLog(fullFQDN, `Leaf certificate uploaded successfully to ${fullFQDN}`);
              resolve();
            } else {
              const response = JSON.parse(data);
              const errorMsg = `Leaf certificate upload failed: ${response.message || 'Unknown error'}`;
              await accountManager.saveRenewalLog(fullFQDN, `ERROR: ${errorMsg}`);
              reject(new Error(errorMsg));
            }
          } catch (error) {
            const errorMsg = `Failed to parse leaf cert upload response: ${error}. Raw response: ${data}`;
            await accountManager.saveRenewalLog(fullFQDN, `ERROR: ${errorMsg}`);
            reject(new Error(errorMsg));
          }
        });
      });

      req.on('error', async (error) => {
        const errorMsg = `Leaf certificate upload failed: ${error.message}`;
        await accountManager.saveRenewalLog(fullFQDN, `ERROR: ${errorMsg}`);
        reject(new Error(errorMsg));
      });

      req.write(postData);
      req.end();
    });
  }

  private async getExistingTrustCertificates(connection: ConnectionRecord): Promise<string[]> {
    return new Promise((resolve, reject) => {
        const fullFQDN = `${connection.hostname}.${connection.domain}`;
        
        if (!connection.username || !connection.password) {
          reject(new Error('Username and password are required for VOS application certificate operations'));
          return;
        }

        const options = {
            hostname: fullFQDN,
            port: 443,
            path: '/platformcom/api/v1/certmgr/config/trust/certificate?service=tomcat',
            method: 'GET',
            headers: {
                'Accept': 'application/json',
                'Authorization': `Basic ${Buffer.from(`${connection.username}:${connection.password}`).toString('base64')}`
            },
            rejectUnauthorized: false
        };

        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', (chunk) => data += chunk);
            res.on('end', () => {
                try {
                    if (res.statusCode === 200) {
                        const response = JSON.parse(data);
                        // Handle both array format and object with certificates property
                        const certificates = Array.isArray(response) ? response : response.certificates || [];
                        const existingCerts = certificates.map((c: any) => c.certificate.trim());
                        resolve(existingCerts);
                    } else {
                        Logger.warn(`Could not get existing trust certificates. Status: ${res.statusCode}, Body: ${data}`);
                        resolve([]);
                    }
                } catch (error) {
                    Logger.error(`Failed to parse existing trust certificates response: ${error}. Raw response: ${data}`);
                    resolve([]);
                }
            });
        });

        req.on('error', (error) => {
            Logger.error(`Failed to get existing trust certificates: ${error.message}`);
            resolve([]);
        });

        req.end();
    });
  }

  private async uploadCaCertificates(connection: ConnectionRecord, certificates: string[], status: RenewalStatus): Promise<void> {
    return new Promise(async (resolve, reject) => {
      try {
        const fullFQDN = `${connection.hostname}.${connection.domain}`;
        
        if (!connection.username || !connection.password) {
          reject(new Error('Username and password are required for VOS application certificate upload'));
          return;
        }

        const existingCerts = await this.getExistingTrustCertificates(connection);
        const certsToUpload = certificates.filter(c => !existingCerts.includes(c.trim()));

        if (certsToUpload.length === 0) {
            Logger.info('All CA certificates already exist on the server. Skipping upload.');
            status.logs.push('All CA certificates already exist on the server. Skipping upload.');
            await accountManager.saveRenewalLog(fullFQDN, `All CA certificates already exist on ${fullFQDN}. Skipping upload.`);
            await accountManager.saveRenewalLog(fullFQDN, `Found ${existingCerts.length} existing trust certificates on server`);
            return resolve();
        }

        const postData = JSON.stringify({
          service: ['tomcat'],
          certificates: certsToUpload,
          description: 'Trust Certificate'
        });

        const options = {
          hostname: fullFQDN,
          port: 443,
          path: '/platformcom/api/v1/certmgr/config/trust/certificates',
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Basic ${Buffer.from(`${connection.username}:${connection.password}`).toString('base64')}`,
            'Content-Length': Buffer.byteLength(postData)
          },
          rejectUnauthorized: false
        };

        Logger.info(`CUCM CA cert upload request body: ${postData}`);
        await accountManager.saveRenewalLog(fullFQDN, `Uploading ${certsToUpload.length} CA certificate(s) to ${fullFQDN}:${options.port}${options.path}`);
        await accountManager.saveRenewalLog(fullFQDN, `CA cert request body: ${postData}`);

        const req = https.request(options, (res) => {
          let data = '';
          res.on('data', (chunk) => data += chunk);
          res.on('end', async () => {
            try {
              Logger.info(`CUCM CA cert upload response: ${data}`);
              await accountManager.saveRenewalLog(fullFQDN, `CUCM CA cert upload response (${res.statusCode}): ${data}`);
              if (res.statusCode === 200 || res.statusCode === 201) {
                status.logs.push(`CA certificates uploaded successfully to ${fullFQDN}`);
                await accountManager.saveRenewalLog(fullFQDN, `CA certificates uploaded successfully to ${fullFQDN}`);
                resolve();
              } else {
                const response = JSON.parse(data);
                const errorMsg = `CA certificate upload failed: ${response.message || response.messages?.[0] || 'Unknown error'}`;
                await accountManager.saveRenewalLog(fullFQDN, `ERROR: ${errorMsg}`);
                await accountManager.saveRenewalLog(fullFQDN, `Full response: ${JSON.stringify(response, null, 2)}`);
                reject(new Error(errorMsg));
              }
            } catch (error) {
              const errorMsg = `Failed to parse CA cert upload response: ${error}. Raw response: ${data}`;
              await accountManager.saveRenewalLog(fullFQDN, `ERROR: ${errorMsg}`);
              reject(new Error(errorMsg));
            }
          });
        });

        req.on('error', async (error) => {
          const errorMsg = `CA certificate upload failed: ${error.message}`;
          await accountManager.saveRenewalLog(fullFQDN, `ERROR: ${errorMsg}`);
          reject(new Error(errorMsg));
        });

        req.write(postData);
        req.end();
      } catch (error) {
        reject(error);
      }
    });
  }

  private async saveCertificateFiles(domain: string, certificateData: string, status: RenewalStatus): Promise<void> {
    try {
      // Parse certificate chain
      const certParts = certificateData.split('-----END CERTIFICATE-----');
      const certificates = certParts
        .filter(part => part.includes('-----BEGIN CERTIFICATE-----'))
        .map(part => part.trim() + '\n-----END CERTIFICATE-----');
      
      if (certificates.length === 0) {
        throw new Error('No certificates found in response');
      }
      
      // First certificate is the domain certificate
      const domainCert = certificates[0];
      
      // Remaining certificates are the chain (intermediate + root)
      const chainCerts = certificates.slice(1);
      const fullChain = chainCerts.join('\n');
      
      // Save domain certificate
      await accountManager.saveCertificate(domain, domainCert, ''); // Private key not included in Let's Encrypt response
      
      // Save certificate chain to accounts folder
      const accountsDir = process.env.ACCOUNTS_DIR || './accounts';
      const domainDir = path.join(accountsDir, domain);
      
      // Ensure domain directory exists
      if (!fs.existsSync(domainDir)) {
        fs.mkdirSync(domainDir, { recursive: true });
      }
      
      const chainPath = path.join(domainDir, 'chain.pem');
      const fullChainPath = path.join(domainDir, 'fullchain.pem');
      
      await fs.promises.writeFile(chainPath, fullChain);
      await fs.promises.writeFile(fullChainPath, certificateData);
      
      status.logs.push(`Saved certificate files for ${domain}`);
      status.logs.push(`- Domain certificate: certificate.pem`);
      status.logs.push(`- Certificate chain: chain.pem`);
      status.logs.push(`- Full chain: fullchain.pem`);
      
      Logger.info(`Successfully saved certificate files for ${domain}`);
    } catch (error) {
      Logger.error(`Failed to save certificate files for ${domain}:`, error);
      throw error;
    }
  }

  private async updateDatabaseWithRenewal(connectionId: number, database: DatabaseManager): Promise<void> {
    try {
      // Update the database with renewal information
      await database.updateConnection(connectionId, {
        last_cert_issued: new Date().toISOString(),
        cert_count_this_week: 1, // This should be calculated based on existing count
        cert_count_reset_date: new Date().toISOString()
      });
      
      Logger.info(`Updated database with renewal info for connection ${connectionId}`);
    } catch (error) {
      Logger.error(`Failed to update database with renewal info for connection ${connectionId}:`, error);
      throw error;
    }
  }

  /**
   * Restart Cisco Tomcat service via SSH if auto_restart_service is enabled
   */
  private async handleServiceRestart(connection: ConnectionRecord, status: RenewalStatus): Promise<void> {
    // Only proceed if SSH is enabled and auto_restart_service is enabled
    if (!connection.enable_ssh || !connection.auto_restart_service) {
      Logger.info(`Skipping service restart for ${connection.hostname}.${connection.domain} - SSH or auto restart not enabled`);
      return;
    }

    try {
      const fqdn = `${connection.hostname}.${connection.domain}`;
      Logger.info(`Starting Cisco Tomcat service restart for ${fqdn}`);
      
      status.logs.push(`Restarting Cisco Tomcat service on ${fqdn}`);
      await this.updateStatus(status, 'uploading_certificate', 'Restarting Cisco Tomcat service via SSH', 95);

      // Test SSH connection first
      const sshTest = await SSHClient.testConnection({
        hostname: fqdn,
        username: connection.username!,
        password: connection.password!
      });

      if (!sshTest.success) {
        const errorMsg = `SSH connection failed for ${fqdn}: ${sshTest.error}`;
        Logger.error(errorMsg);
        status.logs.push(`Warning: ${errorMsg}`);
        return;
      }

      // Execute service restart command with extended timeout (5 minutes)
      const restartResult = await SSHClient.executeCommand({
        hostname: fqdn,
        username: connection.username!,
        password: connection.password!,
        command: 'utils service restart Cisco Tomcat',
        timeout: 300000 // 5 minutes for service restart
      });

      if (restartResult.success) {
        Logger.info(`Successfully restarted Cisco Tomcat service for ${fqdn}`);
        status.logs.push(`✅ Cisco Tomcat service restarted successfully on ${fqdn}`);
        status.logs.push(`Service restart output: ${restartResult.output || 'Command completed'}`);
      } else {
        const errorMsg = `Failed to restart Cisco Tomcat service for ${fqdn}: ${restartResult.error}`;
        Logger.error(errorMsg);
        status.logs.push(`⚠️ ${errorMsg}`);
      }

    } catch (error: any) {
      const errorMsg = `Error during service restart for ${connection.hostname}: ${error.message}`;
      Logger.error(errorMsg);
      status.logs.push(`⚠️ ${errorMsg}`);
    }
  }
}

export const certificateRenewalService = new CertificateRenewalServiceImpl();