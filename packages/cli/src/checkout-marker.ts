import {
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { canonicalJson } from "@eforest/protocol";

export const CHECKOUT_MARKER_NAME = "checkout-in-progress" as const;

export interface CheckoutMarker {
  readonly v: 1;
  readonly branch: string;
  readonly offset: string;
}

export function checkoutMarkerPath(root: string): string {
  return join(root, ".ef", CHECKOUT_MARKER_NAME);
}

export function hasCheckoutMarker(root: string): boolean {
  return existsSync(checkoutMarkerPath(root));
}

export function writeCheckoutMarker(root: string, marker: CheckoutMarker): void {
  const markerPath = checkoutMarkerPath(root);
  const temporary = `${markerPath}.${process.pid}.tmp`;
  const fd = openSync(temporary, "wx", 0o600);
  try {
    writeFileSync(fd, `${canonicalJson(marker)}\n`, "utf8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temporary, markerPath);
  const directoryFd = openSync(join(root, ".ef"), "r");
  try {
    fsyncSync(directoryFd);
  } finally {
    closeSync(directoryFd);
  }
}

export function removeCheckoutMarker(root: string): void {
  unlinkSync(checkoutMarkerPath(root));
  const directoryFd = openSync(join(root, ".ef"), "r");
  try {
    fsyncSync(directoryFd);
  } finally {
    closeSync(directoryFd);
  }
}
