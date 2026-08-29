import { forwardRef, type InputHTMLAttributes } from "react";
import { cn } from "../../lib/utils.js";

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  function Input({ className = "", ...props }, ref) {
    return <input ref={ref} data-slot="input" className={cn("ui-input", className)} {...props} />;
  },
);
