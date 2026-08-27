import { useEffect, useId, useRef, type ReactNode } from "react";
import { cn } from "../../lib/utils.js";

export function Dialog(props: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly title: string;
  readonly description?: string;
  readonly children: ReactNode;
  readonly className?: string;
}): React.JSX.Element {
  const ref = useRef<HTMLDialogElement>(null);
  const id = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const titleId = `ui-dialog-title-${id}`;
  const descriptionId = `ui-dialog-description-${id}`;
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
      className={cn("ui-dialog", props.className)}
      aria-labelledby={titleId}
      aria-describedby={props.description === undefined ? undefined : descriptionId}
      onCancel={(event) => {
        event.preventDefault();
        props.onOpenChange(false);
      }}
      onClose={() => props.onOpenChange(false)}
    >
      <div data-slot="dialog-content" className="ui-dialog-content">
        <header>
          <h2 id={titleId}>{props.title}</h2>
          {props.description === undefined ? null : <p id={descriptionId}>{props.description}</p>}
        </header>
        {props.children}
      </div>
    </dialog>
  );
}
