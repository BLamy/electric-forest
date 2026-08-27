import { forwardRef, type InputHTMLAttributes } from "react";

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  function Input({ className = "", ...props }, ref) {
    return (
      <input ref={ref} data-slot="input" className={`ui-input ${className}`.trim()} {...props} />
    );
  },
);
