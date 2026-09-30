/* Provenance: registry/blocks/discord-clone/components/workspace-rail.tsx — @brett_lamy/ui 2.0.0 registry block
   "discord-clone" (https://blamy.github.io/ui/r/discord-clone.json), installed as owned source.
   Every divergence from the upstream file carries an `ef:` marker. */
import type { CSSProperties, ReactNode } from "react";
import { cn } from "@brett_lamy/ui";

/* ══ WorkspaceTile — a server tile for a `TabViewBar variant="workspace"` rail ══
   <TabView orientation="vertical" defaultSelectedKey="blui">
     <TabViewBar variant="workspace">
       <TabViewList aria-label="Workspaces">
         <TabViewTab id="blui" textValue="BL UI HQ">
           <TabViewIndicator variant="pill" attention={unread} />
           <WorkspaceTile color="#0A84FF" mentions={4}>B</WorkspaceTile>
         </TabViewTab>
       </TabViewList>
       <TabViewFooter><TabViewAction aria-label="Add workspace" icon="plus" /></TabViewFooter>
     </TabViewBar>
   </TabView>
   Discord's tile: a circle at rest that morphs to a rounded square when its tab is hovered or selected (filling
   with the workspace color), with a mention badge. It reads the tab's state through `group-data-*`. */

export interface WorkspaceTileProps {
  /** fill when selected; the accent by default */
  color?: string;
  /** mention count: a red badge on the tile */
  mentions?: number;
  children?: ReactNode;
  className?: string;
}

export function WorkspaceTile({
  color = "var(--primary)",
  mentions,
  children,
  className,
}: WorkspaceTileProps) {
  return (
    <span
      data-slot="workspace-tile"
      style={{ "--tile": color } as CSSProperties}
      className={cn(
        "relative box-border grid size-[34px] shrink-0 place-items-center rounded-[17px] border-2 border-transparent bg-secondary-strong font-ios text-[14px] leading-[normal] font-extrabold text-secondary-foreground [transition:border-radius_var(--duration-spring-bouncy)_var(--ease-spring-bouncy),background-color_var(--duration-spring-snappy)_var(--ease-spring-snappy),border-color_var(--duration-spring-snappy)_var(--ease-spring-snappy),color_var(--duration-spring-snappy)_var(--ease-spring-snappy),scale_var(--duration-spring-snappy)_var(--ease-spring-snappy)] group-data-hovered:rounded-[11px] group-data-selected:rounded-[11px] group-data-selected:border-(--tile) group-data-selected:bg-(--tile) group-data-selected:text-white group-data-pressed:scale-[.94] motion-reduce:transition-none group-data-focus-visible:outline-2 group-data-focus-visible:outline-offset-2 group-data-focus-visible:outline-link",
        className,
      )}
    >
      {children}
      {mentions ? (
        <span className="absolute -right-[7px] -bottom-[6px] box-border flex h-[18px] min-w-[18px] items-center justify-center rounded-full border-[3px] border-muted bg-destructive px-[3px] font-ios text-[10px] leading-none font-bold text-white">
          {mentions > 99 ? "99+" : mentions}
        </span>
      ) : null}
    </span>
  );
}
