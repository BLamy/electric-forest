import { forwardRef, type SelectHTMLAttributes } from "react";
import { cn } from "../../lib/utils.js";

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(
  function Select({ className = "", ...props }, ref) {
    return (
      <select ref={ref} data-slot="select" className={cn("ui-select", className)} {...props} />
    );
  },
);
