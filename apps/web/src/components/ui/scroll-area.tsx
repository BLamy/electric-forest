import { forwardRef, type HTMLAttributes } from "react";

export const ScrollArea = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(
  function ScrollArea({ className = "", ...props }, ref) {
    return (
      <div
        ref={ref}
        data-slot="scroll-area"
        className={`ui-scroll-area ${className}`.trim()}
        {...props}
      />
    );
  },
);
