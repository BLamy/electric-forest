import { useEffect, useRef, type ReactNode } from "react";

export function Dialog(props: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly title: string;
  readonly description?: string;
  readonly children: ReactNode;
}): React.JSX.Element {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (dialog === null) return;
    if (props.open && !dialog.open) dialog.showModal();
    if (!props.open && dialog.open) dialog.close();
  }, [props.open]);
  return (
    <dialog
      ref={ref}
      data-slot="dialog"
      className="ui-dialog"
      aria-labelledby="ui-dialog-title"
      aria-describedby={props.description === undefined ? undefined : "ui-dialog-description"}
      onCancel={(event) => {
        event.preventDefault();
        props.onOpenChange(false);
      }}
      onClose={() => props.onOpenChange(false)}
    >
      <div data-slot="dialog-content" className="ui-dialog-content">
        <header>
          <h2 id="ui-dialog-title">{props.title}</h2>
          {props.description === undefined ? null : (
            <p id="ui-dialog-description">{props.description}</p>
          )}
        </header>
        {props.children}
      </div>
    </dialog>
  );
}
