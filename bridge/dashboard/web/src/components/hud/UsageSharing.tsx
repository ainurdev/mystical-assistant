import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { queryClient, settings as setq } from "../../lib/queries";
import { CARD, Row, Section, Switch } from "./SettingsModal";
import { answer, WHAT } from "./UsageOffer";

/* SETTINGS' half of usage sharing; the ask on load is UsageOffer.ts, apart so
   the entry script doesn't carry SETTINGS for it. */

/** SETTINGS ▸ System. */
export function UsageSharingSection() {
  const key = setq.usageSharing();
  const q = useQuery(key);
  const share: boolean | null | "old" = q.data ? q.data.share : q.isError ? "old" : null;
  const [busy, setBusy] = useState(false);
  const flip = async () => {
    if (busy || share === "old") return;
    setBusy(true);
    if (await answer(!share)) queryClient.setQueryData(key.queryKey, { share: !share });
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
