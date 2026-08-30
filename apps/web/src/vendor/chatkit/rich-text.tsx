/* Vendored from github.com/blamy/ui touchkit/packages/chatkit/src/lib/rich-text.tsx @ b7e037c (2026-08-29).
   @touchkit/chatkit is unpublished; keep edits minimal and mark them with "ef:" comments. */
import { Fragment } from "react";
import { useChatUsers, type ChatUsers } from "./chat-users.js";

export interface RichTextProps {
  text: string;
  /** overrides the ChatUsersProvider context */
  users?: ChatUsers;
}

export function RichText({ text, users }: RichTextProps) {
  const ctxUsers = useChatUsers();
  const map = users ?? ctxUsers;
  const parts = text.split(/(@\w+)/g);
  return (
    <Fragment>
      {parts.map((p, i) => {
        const m = p.match(/^@(\w+)$/);
        const handle = m?.[1]; // ef: strict index access
        const user = handle === undefined ? undefined : map[handle];
        if (user)
          return (
            <span
              key={i}
              style={{
                background: "rgba(10,132,255,.16)",
                color: "#7EB6FF",
                borderRadius: 4,
                padding: "0 3px",
                fontWeight: 600,
              }}
            >
              @{user.name}
            </span>
          );
        return p;
      })}
    </Fragment>
  );
}
