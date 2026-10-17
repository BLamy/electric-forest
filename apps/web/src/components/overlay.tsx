import { useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Credenza } from "@brett_lamy/ui";

function useCompactViewport(): boolean {
  const [compact, setCompact] = useState(() => window.matchMedia("(max-width: 639px)").matches);
  useEffect(() => {
    const media = window.matchMedia("(max-width: 639px)");
    const update = (): void => setCompact(media.matches);
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  return compact;
}

/**
 * The package's Credenza (a centered dialog; a draggable bottom tray on phones), portaled to a
 * viewport-fixed layer. Credenza positions itself `absolute` against its nearest positioned
 * ancestor; the portal keeps a sheet opened from deep inside a scrolling tab panel centered on
 * the viewport. Credenza itself provides role="dialog", aria-modal, the Escape/Tab trap and focus
 * restoration.
 */
export function AppSheet(props: {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly title: string;
  readonly children: ReactNode;
}): React.JSX.Element | null {
  const compact = useCompactViewport();
  if (!props.open) return null;
  return createPortal(
    <div className="fixed inset-0 z-400" data-app-sheet={props.title}>
      <Credenza open onClose={props.onClose} title={props.title} compact={compact}>
        <div className="max-h-[70vh] overflow-y-auto px-4 pt-1 pb-4">{props.children}</div>
      </Credenza>
    </div>,
    document.body,
  );
}
