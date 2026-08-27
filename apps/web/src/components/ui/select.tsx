import { forwardRef, type SelectHTMLAttributes } from "react";

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(
  function Select({ className = "", ...props }, ref) {
    return (
      <select ref={ref} data-slot="select" className={`ui-select ${className}`.trim()} {...props} />
    );
  },
);
