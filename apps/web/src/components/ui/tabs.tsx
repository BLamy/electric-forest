import type { ReactNode } from "react";

export interface TabItem<T extends string> {
  readonly id: T;
  readonly label: ReactNode;
  readonly count?: ReactNode;
}

export function Tabs<T extends string>(props: {
  readonly label: string;
  readonly items: readonly TabItem<T>[];
  readonly selected: T;
  readonly onSelect: (value: T) => void;
}): React.JSX.Element {
  return (
    <div className="ui-tabs" role="tablist" aria-label={props.label}>
      {props.items.map((item) => (
        <button
          key={item.id}
          type="button"
          role="tab"
          aria-selected={item.id === props.selected}
          className={item.id === props.selected ? "ui-tab ui-tab-active" : "ui-tab"}
          onClick={() => props.onSelect(item.id)}
        >
          <span>{item.label}</span>
          {item.count === undefined ? null : <span className="ui-tab-count">{item.count}</span>}
        </button>
      ))}
    </div>
  );
}
