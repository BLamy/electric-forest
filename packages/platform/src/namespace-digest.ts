import { stateDigest } from "@eforest/protocol";
import type { NamespaceView } from "./ns/reducer.js";

export function namespaceViewDigest(view: NamespaceView): string {
  return stateDigest(view);
}
