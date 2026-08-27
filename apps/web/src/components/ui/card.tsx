import type { HTMLAttributes } from "react";

export function Card({
  className = "",
  ...props
}: HTMLAttributes<HTMLDivElement>): React.JSX.Element {
  return <div data-slot="card" className={`ui-card ${className}`.trim()} {...props} />;
}

export function CardHeader({
  className = "",
  ...props
}: HTMLAttributes<HTMLDivElement>): React.JSX.Element {
  return (
    <div data-slot="card-header" className={`ui-card-header ${className}`.trim()} {...props} />
  );
}

export function CardContent({
  className = "",
  ...props
}: HTMLAttributes<HTMLDivElement>): React.JSX.Element {
  return (
    <div data-slot="card-content" className={`ui-card-content ${className}`.trim()} {...props} />
  );
}
