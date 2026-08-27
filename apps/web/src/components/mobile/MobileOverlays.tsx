import { useEffect, useId, useRef, type RefObject } from "react";
import { Credenza, SideDrawer, type CredenzaProps, type SideDrawerProps } from "@brett_lamy/ui";

const FOCUSABLE = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

function markerFromId(prefix: string, id: string): string {
  return `${prefix}-${id.replace(/[^a-zA-Z0-9_-]/g, "")}`;
}

function focusableWithin(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
    (element) => !element.hidden && element.getAttribute("aria-hidden") !== "true",
  );
}

interface DialogSemanticsOptions {
  readonly open: boolean;
  readonly marker: string;
  readonly slot: "credenza" | "side-drawer";
  readonly modal: boolean;
  readonly label: string;
  readonly onClose: (() => void) | undefined;
  readonly initialFocusRef: RefObject<HTMLElement | null> | undefined;
  readonly returnFocusRef: RefObject<HTMLElement | null> | undefined;
}

function useDialogSemantics(options: DialogSemanticsOptions): void {
  const triggerRef = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(options.onClose);
  onCloseRef.current = options.onClose;

  useEffect(() => {
    if (!options.open) return;
    triggerRef.current =
      options.returnFocusRef?.current ??
      (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    const root = document.querySelector<HTMLElement>(
      `[data-slot="${options.slot}"].${options.marker}`,
    );
    if (root === null) return;

    const dialog =
      options.slot === "side-drawer"
        ? ((root.lastElementChild as HTMLElement | null) ?? root)
        : root;
    dialog.setAttribute("role", options.modal ? "dialog" : "complementary");
    dialog.setAttribute("aria-label", options.label);
    if (options.modal) dialog.setAttribute("aria-modal", "true");
    else dialog.removeAttribute("aria-modal");
    dialog.tabIndex = -1;

    const inerted: Array<{ element: HTMLElement; inert: boolean }> = [];
    if (options.modal && root.parentElement !== null) {
      const scrim = options.slot === "credenza" ? root.previousElementSibling : null;
      for (const sibling of root.parentElement.children) {
        if (!(sibling instanceof HTMLElement) || sibling === root || sibling === scrim) continue;
        inerted.push({ element: sibling, inert: sibling.inert });
        sibling.inert = true;
      }
    }

    const initial = options.initialFocusRef?.current ?? focusableWithin(dialog)[0] ?? dialog;
    if (!dialog.contains(document.activeElement)) initial.focus({ preventScroll: true });

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape" && options.modal) {
        event.preventDefault();
        onCloseRef.current?.();
        return;
      }
      if (event.key !== "Tab" || !options.modal) return;
      const focusable = focusableWithin(dialog);
      if (focusable.length === 0) {
        event.preventDefault();
        dialog.focus({ preventScroll: true });
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (
        event.shiftKey &&
        (document.activeElement === first || document.activeElement === dialog)
      ) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };
    dialog.addEventListener("keydown", onKeyDown);

    return () => {
      dialog.removeEventListener("keydown", onKeyDown);
      inerted.forEach(({ element, inert }) => {
        element.inert = inert;
      });
      const returnTarget = options.returnFocusRef?.current ?? triggerRef.current;
      if (returnTarget?.isConnected) returnTarget.focus({ preventScroll: true });
    };
  }, [
    options.initialFocusRef,
    options.label,
    options.marker,
    options.modal,
    options.open,
    options.returnFocusRef,
    options.slot,
  ]);
}

export interface MobileCredenzaProps extends Omit<CredenzaProps, "title"> {
  readonly label: string;
  readonly title?: CredenzaProps["title"];
  readonly initialFocusRef?: RefObject<HTMLElement | null>;
  readonly returnFocusRef?: RefObject<HTMLElement | null>;
}

/** Adds modal naming, focus containment/restoration, Escape, and inert background. */
export function MobileCredenza(props: MobileCredenzaProps): React.JSX.Element {
  const id = useId();
  const marker = markerFromId("mobile-a11y-credenza", id);
  useDialogSemantics({
    open: props.open,
    marker,
    slot: "credenza",
    modal: true,
    label: props.label,
    onClose: props.onClose,
    initialFocusRef: props.initialFocusRef,
    returnFocusRef: props.returnFocusRef,
  });
  const { label, initialFocusRef, returnFocusRef, className, ...credenzaProps } = props;
  void label;
  void initialFocusRef;
  void returnFocusRef;
  return (
    <Credenza
      {...credenzaProps}
      title={props.title ?? props.label}
      className={[marker, "mobile-accessible-credenza", className].filter(Boolean).join(" ")}
    />
  );
}

export interface MobileSideDrawerProps extends Omit<SideDrawerProps, "title"> {
  readonly label: string;
  readonly title?: SideDrawerProps["title"];
  readonly initialFocusRef?: RefObject<HTMLElement | null>;
  readonly returnFocusRef?: RefObject<HTMLElement | null>;
}

/** Preserves SideDrawer visuals while repairing overlay and fixed-panel semantics. */
export function MobileSideDrawer(props: MobileSideDrawerProps): React.JSX.Element {
  const id = useId();
  const marker = markerFromId("mobile-a11y-drawer", id);
  useDialogSemantics({
    open: props.open,
    marker,
    slot: "side-drawer",
    modal: props.mode === "overlay",
    label: props.label,
    onClose: props.onClose,
    initialFocusRef: props.initialFocusRef,
    returnFocusRef: props.returnFocusRef,
  });
  const { label, initialFocusRef, returnFocusRef, className, ...drawerProps } = props;
  void label;
  void initialFocusRef;
  void returnFocusRef;
  return (
    <SideDrawer
      {...drawerProps}
      title={props.title ?? props.label}
      className={[marker, "mobile-accessible-drawer", className].filter(Boolean).join(" ")}
    />
  );
}
