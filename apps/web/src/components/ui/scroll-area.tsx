import { forwardRef, type HTMLAttributes } from "react";
import { cn } from "../../lib/utils.js";

export const ScrollArea = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(
  function ScrollArea({ className = "", ...props }, ref) {
    return (
      <div
        ref={ref}
        data-slot="scroll-area"
        className={cn("ui-scroll-area", className)}
        {...props}
      />
    );
  },
);
