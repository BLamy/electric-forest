import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/** shadcn class composer; product tokens supply the concrete visual vocabulary. */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
