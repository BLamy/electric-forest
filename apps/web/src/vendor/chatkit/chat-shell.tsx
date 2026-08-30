/* Vendored from github.com/blamy/ui touchkit/packages/chatkit/src/lib/chat-shell.tsx @ b7e037c (2026-08-29).
   @touchkit/chatkit is unpublished; keep edits minimal and mark them with "ef:" comments. */
import {
  Children,
  createContext,
  Fragment,
  isValidElement,
  useContext,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { chatTokenVars, K, KEASE, KFONT } from "./chat-tokens.js";
import { cn } from "./cn.js";

export interface ChatShellContextValue {
  /** container width (not the viewport) */
  w: number;
  compact: boolean;
  navOpen: boolean;
  setNavOpen: (open: boolean) => void;
}

const ChatShellCtx = createContext<ChatShellContextValue | null>(null);

export function useChatShell(): ChatShellContextValue {
  const ctx = useContext(ChatShellCtx);
  if (!ctx) throw new Error("useChatShell must be used within <ChatShell>");
  return ctx;
}

export type ChatShellSlotChildren = ReactNode;

interface SlotComponent {
  (props: { children?: ChatShellSlotChildren }): null;
  __ckSlot: string;
}

function ckSlot(name: string): SlotComponent {
  const S = (() => null) as unknown as SlotComponent;
  S.__ckSlot = name;
  return S;
}

export interface ChatShellProps {
  breakpoint?: number;
  /** initial state of the compact hamburger drawer (only meaningful below the breakpoint) */
  defaultNavOpen?: boolean;
  children?: ReactNode;
  className?: string;
  style?: CSSProperties;
}

export function ChatShell({
  breakpoint = 880,
  defaultNavOpen = false,
  children,
  className,
  style,
}: ChatShellProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(1200);
  const [navOpen, setNavOpen] = useState(defaultNavOpen);
  useEffect(() => {
    const el = ref.current;
    if (!el || !window.ResizeObserver) return;
    const ro = new ResizeObserver(() => setW(el.offsetWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const compact = w < breakpoint;
  const ctx: ChatShellContextValue = { w, compact, navOpen, setNavOpen };
  const slots: Record<string, ChatShellSlotChildren> = {};
  Children.forEach(children, (c) => {
    if (
      isValidElement(c) &&
      typeof c.type === "function" &&
      (c.type as unknown as SlotComponent).__ckSlot
    ) {
      slots[(c.type as unknown as SlotComponent).__ckSlot] = (
        c.props as { children?: ChatShellSlotChildren }
      ).children;
    }
  });
  const get = (k: string): ReactNode => {
    const sl = slots[k];
    return sl == null ? null : sl;
  };
  const railNav = (
    <Fragment>
      {get("rail")}
      {get("nav")}
    </Fragment>
  );
  return (
    <ChatShellCtx.Provider value={ctx}>
      <div
        ref={ref}
        data-slot="chat-shell"
        className={cn(className)}
        style={{
          ...chatTokenVars,
          position: "relative",
          width: "100%",
          height: "100%",
          display: "flex",
          background: K.bg,
          color: K.label,
          overflow: "hidden",
          fontFamily: KFONT,
          colorScheme: "dark",
          ...style,
        }}
      >
        {!compact && railNav}
        <div style={{ flex: 1, minWidth: 0, minHeight: 0, display: "flex" }}>{get("main")}</div>
        {compact && (
          <Fragment>
            <div
              onClick={() => setNavOpen(false)}
              style={{
                position: "absolute",
                inset: 0,
                zIndex: 30,
                background: "rgba(0,0,0,.5)",
                opacity: navOpen ? 1 : 0,
                pointerEvents: navOpen ? "auto" : "none",
                transition: "opacity .3s",
              }}
            />
            <div
              style={{
                position: "absolute",
                top: 0,
                bottom: 0,
                left: 0,
                zIndex: 31,
                display: "flex",
                transform: navOpen ? "none" : "translateX(-102%)",
                transition: "transform .38s " + KEASE,
                boxShadow: navOpen ? "0 0 44px rgba(0,0,0,.5)" : "none",
              }}
            >
              {railNav}
            </div>
          </Fragment>
        )}
      </div>
    </ChatShellCtx.Provider>
  );
}

ChatShell.Rail = ckSlot("rail");
ChatShell.Nav = ckSlot("nav");
ChatShell.Main = ckSlot("main");
ChatShell.Context = ChatShellCtx;
ChatShell.useShell = useChatShell;
