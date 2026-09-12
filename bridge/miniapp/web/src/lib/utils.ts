import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/** Merge conditional class names, de-duplicating conflicting Tailwind utilities. */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** Wall clock, 24h — when a prompt was sent, when its answer landed. 24h so the
 *  two times on a turn read the same on both surfaces. */
export const hhmm = (sec: number): string =>
  new Date(sec * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
