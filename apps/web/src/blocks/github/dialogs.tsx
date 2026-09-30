/* Provenance: registry/blocks/github-clone/dialogs.tsx — @brett_lamy/ui 2.0.0 registry block
   "github-clone" (https://blamy.github.io/ui/r/github-clone.json), installed as owned source.
   Every divergence from the upstream file carries an `ef:` marker. */
/* Credenzas: the Clone dialog ("Code ▾") and the label filter — a dialog when wide, a tray on phone. */
import { useState } from "react";
import { Button, List, ListRow, Segmented, cn } from "@brett_lamy/ui";
import { AppSheet } from "../../components/overlay.js";
import { navigate } from "../../navigation.js";
import { Oct, ghButton } from "./parts.js";

async function copyText(value: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(value);
  } catch {
    /* clipboard access is a browser permission, never a product error */
  }
}

// ef:begin ef CLI / branch stream targets, history and inspector rows
// ef: the clone targets are the `ef` CLI and the branch stream (no git remotes exist); the rows open
// the branch's event history and the stream inspector instead of GitHub Desktop / a ZIP.
export function CloneDialog({
  open,
  onClose,
  org,
  repo,
  branch,
}: {
  open: boolean;
  onClose: () => void;
  org: string;
  repo: string;
  branch: string;
}) {
  const [proto, setProto] = useState("cli");
  const streamId = `fs:${org}/${repo}:${branch}:meta`;
  const url = proto === "cli" ? `ef clone ${org}/${repo} ${branch}` : streamId;
  const go = (href: string): void => {
    onClose();
    navigate(href);
  };
  const base = `/${encodeURIComponent(org)}/${encodeURIComponent(repo)}`;
  return (
    <AppSheet open={open} onClose={onClose} title="Clone">
      <Segmented
        aria-label="Protocol"
        value={proto}
        onChange={setProto}
        options={[
          { id: "cli", label: "ef CLI" },
          { id: "stream", label: "Branch stream" },
        ]}
      />
      <div className="mt-3 flex h-9 items-center gap-2 rounded-lg border border-border bg-muted pr-1 pl-3">
        <code className="min-w-0 flex-1 truncate font-mono text-[13px]">{url}</code>
        <Button
          aria-label="Copy"
          className={cn(ghButton(), "h-7 w-7 px-0")}
          onPress={() => void copyText(url)}
        >
          <Oct name="copy" size={14} />
        </Button>
      </div>
      <p className="mt-2 mb-3 text-[12px] text-muted-foreground">
        {proto === "cli"
          ? "Two working directories converge through the branch stream."
          : "Every file view is a reducer over this stream."}
      </p>
      <List className="overflow-hidden rounded-xl border border-border">
        <ListRow
          leading={<Oct name="history" className="text-muted-foreground" />}
          title="Event history"
          onPress={() => go(`${base}/history/${encodeURIComponent(branch)}`)}
          className="[&_[data-slot=list-row-content]]:text-[15px]"
        />
        <ListRow
          leading={<Oct name="stream" className="text-muted-foreground" />}
          title="Stream inspector"
          divider={false}
          onPress={() =>
            go(
              `/inspect/${encodeURIComponent(org)}/${encodeURIComponent(repo)}/${encodeURIComponent(branch)}`,
            )
          }
          className="[&_[data-slot=list-row-content]]:text-[15px]"
        />
      </List>
    </AppSheet>
  );
}
// ef:end

// ef: the label filter credenza is not installed — the issue list filters with a native select over
// the live label catalog (issues-tab.tsx), which keeps the `issue-label-filter` evidence control.
