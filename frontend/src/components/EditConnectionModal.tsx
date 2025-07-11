import { useState, useEffect } from "react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/hooks/use-toast";
import validator from "validator";
import { apiCall } from '../lib/api';

interface Column {
  name: string;
  type: string;
  optional?: boolean;
  label?: string;
  placeholder?: string;
  default?: string | boolean;
  description?: string;
  options?: { value: string; label: string }[];
  allowCustom?: boolean;
  conditional?: {
    field: string;
    value: string | boolean;
  };
  validator: {
    name: keyof typeof validator;
    options?: unknown;
  };
}

interface EditConnectionModalProps {
  record: Record<string, string | boolean>;
  isOpen: boolean;
  onClose: () => void;
  onConnectionUpdated: () => void;
}

const EditConnectionModal: React.FC<EditConnectionModalProps> = ({ 
  record, 
  isOpen, 
  onClose, 
  onConnectionUpdated 
}) => {
  const { toast } = useToast();
  const [data, setData] = useState<Column[]>([]);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formData, setFormData] = useState<Record<string, string | boolean>>({});
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    const fetchData = async () => {
      const response = await fetch("/dbSetup.json");
      const jsonData: Column[] = await response.json();
      setData(jsonData);
    };

    fetchData();
  }, []);

  useEffect(() => {
    if (record && data.length > 0) {
      // Initialize form data with record values
      const initialData = data.reduce((obj: Record<string, string | boolean>, col) => {
        obj[col.name] = record[col.name] || col.default || "";
        return obj;
      }, {});
      setFormData(initialData);
    }
  }, [record, data]);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>, options: Column['validator'], isOptional = false) => {
    const { name, value } = e.target;
    const newErrors: Record<string, string> = {};

    // Validate - skip validation if field is optional and empty
    if (value.trim() !== '' || !isOptional) {
      const validatorFn = validator[options.name] as (value: string, options?: unknown) => boolean;
      if (!validatorFn(value, options.options)) {
        newErrors[name] = "Invalid value";
      } else {
        newErrors[name] = "";
      }
    } else {
      newErrors[name] = "";
    }

    if (Object.keys(newErrors).length > 0) {
      setErrors(prev => ({ ...prev, ...newErrors }));
    }

    setFormData((prev) => ({
      ...prev,
      [name]: value,
    }));
  };

  const handleSelectChange = (name: string, value: string, options: Column['validator'], isOptional = false) => {
    const newErrors: Record<string, string> = {};

    // Validate - skip validation if field is optional and empty
    if (value.trim() !== '' || !isOptional) {
      const validatorFn = validator[options.name] as (value: string, options?: unknown) => boolean;
      if (!validatorFn(value, options.options)) {
        newErrors[name] = "Invalid value";
      } else {
        newErrors[name] = "";
      }
    } else {
      newErrors[name] = "";
    }

    if (Object.keys(newErrors).length > 0) {
      setErrors(prev => ({ ...prev, ...newErrors }));
    }

    setFormData((prev) => ({
      ...prev,
      [name]: value,
    }));
  };

  const handleTextareaChange = (e: React.ChangeEvent<HTMLTextAreaElement>, options: Column['validator'], isOptional = false) => {
    const { name, value } = e.target;
    const newErrors: Record<string, string> = {};

    // For CSR, validate format if not empty (can include private key)
    if (name === 'custom_csr' && value.trim() !== '') {
      if (!value.includes('-----BEGIN CERTIFICATE REQUEST-----') || !value.includes('-----END CERTIFICATE REQUEST-----')) {
        newErrors[name] = "Must contain a valid PEM formatted certificate request";
      } else {
        newErrors[name] = "";
      }
    } else if (value.trim() !== '' || !isOptional) {
      const validatorFn = validator[options.name] as (value: string, options?: unknown) => boolean;
      if (!validatorFn(value, options.options)) {
        newErrors[name] = "Invalid value";
      } else {
        newErrors[name] = "";
      }
    } else {
      newErrors[name] = "";
    }

    if (Object.keys(newErrors).length > 0) {
      setErrors(prev => ({ ...prev, ...newErrors }));
    }

    setFormData((prev) => ({
      ...prev,
      [name]: value,
    }));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSubmitting(true);
    
    try {
      await apiCall(`/data/${record.id}`, {
        method: "PUT",
        body: JSON.stringify(formData),
      });
      
      toast({
        title: "Success!",
        description: "Connection updated successfully.",
        duration: 3000,
      });
      
      onConnectionUpdated(); // Notify the table to refresh
      onClose(); // Close the modal
    } catch (error) {
      console.error("Error updating connection:", error);
      
      toast({
        title: "Error",
        description: "Failed to update connection. Please try again.",
        variant: "destructive",
        duration: 5000,
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  const formatColumnName = (col: string): string => {
    return col
      .replace(/[^a-zA-Z]+/g, " ") // Replace non-letter characters with spaces
      .split(' ')
      .map(word => {
        // Keep SSL, DNS, and SSH in uppercase
        if (word.toLowerCase() === 'ssl' || word.toLowerCase() === 'dns' || word.toLowerCase() === 'ssh') {
          return word.toUpperCase();
        }
        return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
      })
      .join(' ');
  };

  if (!record) return null;

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="max-w-4xl w-[95vw] sm:w-[90vw] max-h-[90vh] h-[90vh] flex flex-col overflow-hidden">
        <DialogHeader>
          <DialogTitle>Edit Connection</DialogTitle>
          <DialogDescription>
            Update the connection details for {record.name || 'this connection'}.
          </DialogDescription>
        </DialogHeader>
        
        <div className="flex-1 overflow-y-auto pl-1 pr-2 mt-4 pb-4 min-h-0 scroll-smooth scrollbar-styled">
          <form onSubmit={handleSubmit} className="space-y-4" autoComplete="off">
          {data.map((col) => {
            const formValue = formData[col.name];
            const isOptional = col.optional === true;
            const label = col.label || formatColumnName(col.name);
            const placeholder = col.placeholder || (isOptional 
              ? `${label} (Optional)`
              : label);

            // Check if field should be shown based on conditional logic
            const shouldShow = !col.conditional || formData[col.conditional.field] === col.conditional.value;
            
            // For conditional fields like custom_csr, make them required when their condition is met
            const isConditionallyRequired = col.conditional && formData[col.conditional.field] === col.conditional.value && col.name === 'custom_csr';
              
            if (!shouldShow) {
              return null;
            }
              
            return (
              <div key={col.name} className="space-y-2">
                {col.type !== "SWITCH" && <Label>{label}</Label>}
                
                {col.type === "SELECT" ? (
                  <Select 
                    value={String(formValue || col.default || "")} 
                    onValueChange={(value) => handleSelectChange(col.name, value, col.validator, isOptional)}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder={placeholder} />
                    </SelectTrigger>
                    <SelectContent position="item-aligned">
                      {col.options?.map((option) => (
                        <SelectItem key={option.value} value={option.value}>
                          {option.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : col.type === "SWITCH" ? (
                  <div className="space-y-2">
                    <div className="flex items-start space-x-3">
                      <Switch
                        id={col.name}
                        checked={Boolean(formValue)}
                        onCheckedChange={(checked) => {
                          setFormData(prev => ({ ...prev, [col.name]: checked }));
                          setErrors(prev => {
                            const newErrors = { ...prev };
                            delete newErrors[col.name];
                            return newErrors;
                          });
                        }}
                        className="mt-1"
                      />
                      <div className="space-y-1">
                        <Label htmlFor={col.name} className="text-sm font-medium cursor-pointer">
                          {label}
                        </Label>
                        {col.description && (
                          <p className="text-xs text-muted-foreground">
                            {col.description}
                          </p>
                        )}
                      </div>
                    </div>
                  </div>
                ) : col.type === "TEXTAREA" ? (
                  <Textarea
                    required={!isOptional || isConditionallyRequired}
                    name={col.name}
                    placeholder={placeholder}
                    value={String(formValue || "")}
                    rows={6}
                    autoComplete="off"
                    data-lpignore="true"
                    data-form-type="other"
                    data-1p-ignore="true"
                    onChange={(e) => {
                      handleTextareaChange(e, col.validator, isOptional && !isConditionallyRequired);
                    }}
                  />
                ) : (
                  <Input
                    required={!isOptional || isConditionallyRequired}
                    type={col.name === "password" || col.name === "pw" ? "password" : "text"}
                    name={col.name}
                    placeholder={placeholder}
                    value={String(formValue || "")}
                    autoComplete="off"
                    data-lpignore="true"
                    data-form-type="other"
                    data-1p-ignore="true"
                    onChange={(e) => {
                      handleChange(e, col.validator, isOptional && !isConditionallyRequired);
                    }}
                  />
                )}
                
                {errors[col.name] && <span className="text-red-500 font-semibold">{errors[col.name]}</span>}
              </div>
            );
          })}
          </form>
        </div>
        
        <div className="flex justify-end space-x-2 pt-4 border-t flex-shrink-0 bg-background">
          <Button type="button" variant="outline" onClick={onClose} disabled={isSubmitting}>
            Cancel
          </Button>
          <Button 
            onClick={() => {
              // Trigger form submission
              const form = document.querySelector('form') as HTMLFormElement;
              if (form) {
                form.requestSubmit();
              }
            }}
            disabled={isSubmitting}
          >
            {isSubmitting ? 'Updating...' : 'Update Connection'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
};

export default EditConnectionModal;