import { askConfirm } from "../components/ui/Ask";

/* Leaving while a card waits for an answer takes away the only place it can be
   answered. The browser's beforeunload prompt is the only thing that can stop a
   toolbar or swipe reload — and its wording isn't ours to set — so it stays as
   the backstop; every reload path the app owns asks with the HUD's own confirm.
   ponytail: two module-level flags, not a store. */

let pending = false;
let leaving = false;

export const setLeavePending = (v: boolean) => { pending = v; };
export const leavePending = () => pending;
export const leavingOnPurpose = () => leaving;

/** Whether it's fine to go. Asks in the HUD's own dialog if a card is waiting. */
export async function confirmLeave(): Promise<boolean> {
  if (!pending) return true;
  if (!(await askConfirm("A question is waiting for an answer here. Reload anyway?"))) return false;
  leaving = true; // so the beforeunload backstop doesn't ask the same thing again
  return true;
}
