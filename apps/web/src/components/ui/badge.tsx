import type { HTMLAttributes } from "react";

export function Badge({
  className = "",
  ...props
}: HTMLAttributes<HTMLSpanElement>): React.JSX.Element {
  return <span className={`ui-badge ${className}`.trim()} {...props} />;
}
