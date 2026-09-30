import { sha256Hex } from "@eforest/protocol";
import type { WhoamiUser } from "./chat/useWhoami.js";

/** A stable, subject-qualified namespace; ownership still comes from server events. */
export function personalAccount(user: WhoamiUser | null): {
  readonly name: string;
  readonly namespace: string;
} | null {
  if (user === null) return null;
  const name = user.email.split("@")[0] || "Your account";
  const stem =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 20)
      .replace(/-$/g, "") || "user";
  return {
    name,
    namespace: `${stem}-${sha256Hex(new TextEncoder().encode(user.sub)).slice(0, 12)}`,
  };
}
