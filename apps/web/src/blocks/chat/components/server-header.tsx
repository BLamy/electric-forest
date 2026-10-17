/* Provenance: registry/blocks/discord-clone/components/server-header.tsx — @brett_lamy/ui 2.0.0 registry block
   "discord-clone" (https://blamy.github.io/ui/r/discord-clone.json), installed as owned source.
   Every divergence from the upstream file carries an `ef:` marker. */
import type { ComponentProps, ReactNode } from "react";
import { Button } from "react-aria-components";
import { Icon, cn, useOptionalChatShell } from "@brett_lamy/ui";

export interface ServerHeaderProps extends ComponentProps<"div"> {
  /** trailing control; defaults to a close button inside a compact ChatShell, else a disclosure chevron */
  action?: ReactNode;
  /** closes the navigation; inside a compact ChatShell it defaults to closing the drawer */
  onClose?: () => void;
}

/** The server / workspace name at the top of the channel sidebar. */
export function ServerHeader({
  action,
  onClose,
  className,
  children,
  ...props
}: ServerHeaderProps) {
  const shell = useOptionalChatShell();
  const close = onClose ?? (shell?.compact ? () => shell.setNavOpen(false) : undefined);
  return (
    <div
      data-slot="server-header"
      className={cn(
        "flex items-center gap-[8px] border-b border-border px-[14px] pt-[13px] pb-[9px]",
        className,
      )}
      {...props}
    >
      <span className="flex-1 truncate text-[13.5px] font-extrabold tracking-[-.1px] text-foreground">
        {children}
      </span>
      {action !== undefined ? (
        action
      ) : close ? (
        <Button
          onPress={close}
          aria-label="Close channels"
          className="grid cursor-pointer border-0 bg-transparent p-[4px] text-tertiary-foreground"
        >
          <Icon name="xmark-large" size={14} sw={1.9} />
        </Button>
      ) : (
        <span className="grid text-tertiary-foreground">
          <Icon
            name="chevron-right-compact"
            size={13}
            sw={1.9}
            className="[transform:rotate(90deg)]"
          />
        </span>
      )}
    </div>
  );
}
