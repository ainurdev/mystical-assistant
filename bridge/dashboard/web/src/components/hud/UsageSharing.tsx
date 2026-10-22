import { useEffect, useState } from "react";
import { api } from "../../api";
import { startUsage, stopUsage } from "../../lib/usage";
import { notify } from "./Notifications";
import { CARD, Row, Section, Switch } from "./SettingsModal";

/* Opt-in usage sharing, asked once per install: bridge/usagesharing.py keeps
   the answer, lib/usage.ts is everything PostHog may see. Two places, like
   Rivendell's marks:
   - the ask: a pill on load while this install has never answered. SHARE USAGE
     and NO THANKS weigh the same; × leaves it unanswered, so the next load asks
     again. Nothing loads or sends before a yes;
   - the switch under SETTINGS ▸ System, to change the answer.
   A bridge older than the route can't keep an answer, so it is never asked. */

const WHAT = "Clicks and screen recordings with every letter, picture and token blanked out. Never your code, chats or files.";
const begin = () => void startUsage().catch(() => { /* a page older than the build can't load the chunk: the next load starts it */ });

async function answer(share: boolean): Promise<boolean> {
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

/** SETTINGS ▸ System. */
export function UsageSharingSection() {
  const [share, setShare] = useState<boolean | null | "old">(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api.usageSharing().then((r) => setShare(r.share)).catch(() => setShare("old"));
  }, []);
  const flip = async () => {
    if (busy || share === "old") return;
    setBusy(true);
    if (await answer(!share)) setShare(!share);
    setBusy(false);
  };
  return (
    <Section
      title="USAGE SHARING"
      top
      desc="Help improve Mystical by sharing how you use the dashboard."
      info="Off until you say yes, once per install. Shared: where you click, and screen recordings with every letter, picture and token blanked out, sent to Mystical's PostHog project in the EU under a random id, with no name or email. Never your code, chats or files, and nothing from the Telegram bot or the Mini App."
    >
      <div style={CARD}>
        <Row first label="SHARE USAGE" desc={share === "old" ? "Restart the bridge to change this." : WHAT}>
          {share !== "old" && <Switch on={share === true} onClick={() => void flip()} label="Share usage" />}
        </Row>
      </div>
    </Section>
  );
}
