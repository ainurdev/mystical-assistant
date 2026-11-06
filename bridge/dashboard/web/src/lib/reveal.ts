// Asking a turn to show one of its events. The turn may not be mounted yet (the
// transcript is virtualized, and a search can land on a turn still being paged in), so
// the request waits here until its RunStream takes it, opens whatever folds hold the row
// and clears it.
import { useSyncExternalStore } from "react";

type Ask = { turn: string; seq: number };
let ask: Ask | null = null;
const subs = new Set<() => void>();

export function requestReveal(turn: string, seq: number): void {
  ask = { turn, seq };
  subs.forEach((f) => f());
}

export function clearReveal(a: Ask): void {
  if (ask !== a) return;
  ask = null;
  subs.forEach((f) => f());
}

function subscribe(f: () => void) {
  subs.add(f);
  return () => { subs.delete(f); };
}

/** The waiting ask for this turn, or null. */
export function useRevealAsk(turn: string): Ask | null {
  return useSyncExternalStore(subscribe, () => (ask?.turn === turn ? ask : null));
}

/** The anchor a revealed row wears (lib/checkpoints ckId's key). */
export const revealKey = (i: number, seq?: number) => (seq != null ? `s${seq}` : `ev${i}`);
