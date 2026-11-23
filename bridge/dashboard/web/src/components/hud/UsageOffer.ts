import { api } from "../../api";
import { startUsage, stopUsage } from "../../lib/usage";
import { notify } from "./Notifications";

/* Opt-in usage sharing, asked once per install: bridge/usagesharing.py keeps
   the answer, lib/usage.ts is everything PostHog may see. Two places, like
   Rivendell's marks:
   - the ask: a pill on load while this install has never answered. SHARE USAGE
     and NO THANKS weigh the same; × leaves it unanswered, so the next load asks
     again. Nothing loads or sends before a yes;
   - the switch under SETTINGS ▸ System, to change the answer.
   A bridge older than the route can't keep an answer, so it is never asked. */

export const WHAT = "Clicks and screen recordings with every letter, picture and token blanked out. Never your code, chats or files.";
const begin = () => void startUsage().catch(() => { /* a page older than the build can't load the chunk: the next load starts it */ });

export async function answer(share: boolean): Promise<boolean> {
  try {
    await api.setUsageSharing(share);
  } catch (e) {
    notify("error", `Usage sharing wasn't saved: ${e instanceof Error ? e.message : e}`);
    return false;
  }
  if (share) begin();
  else stopUsage();
  return true;
}

/** On load: start if this install said yes, ask if it never answered. */
export async function offerUsageSharing(): Promise<void> {
  let share: boolean | null;
  try { ({ share } = await api.usageSharing()); } catch { return; }
  if (share) return begin();
  if (share === false) return;
  notify("ask", "Share anonymous usage to help improve Mystical?", undefined, {
    sub: `${WHAT} Nothing is sent unless you say yes; change it any time in Settings › System.`,
    actions: [
      { label: "Share usage", run: () => void answer(true) },
      { label: "No thanks", run: () => void answer(false) },
    ],
  });
}
