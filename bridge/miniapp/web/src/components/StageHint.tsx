import { useState } from "react";
import type { FlowStageShape } from "../lib/api";
import { engagement } from "../lib/flows";

// What the stage you are standing in wants from you, on the line above the
// prompt box. A stage that only wants a message says nothing — the strip exists
// for the stages where the answer isn't typing: a gate waiting on approval, a
// sweep waiting on a triage, a reproduce waiting on a log.
//
// The buttons for those live on the card itself (that is where the findings and
// the screens are); this is the reminder when the card has scrolled away, plus
// the one affordance a card cannot offer — getting a pasted log into the box
// already fenced.
//
// Mirrors bridge/dashboard/web/src/components/StageHint.tsx. Keep them in sync.

const WANTS: Record<string, string> = {
  approve: "waiting on your approval — the card above has the button",
  arm: "hold the card's button to run it",
  evidence: "paste the log or attach a screenshot",
  triage: "drop the findings that aren't real, on the card above",
  annotate: "note what to change, per screen on the card above",
  pick: "star the ones worth keeping, on the card above",
  answer: "answer what it asked — one question per concept",
};

export function StageHint({ stage, onPaste }: {
  /** The stage the session is standing on, or null when it isn't in a flow. */
  stage: FlowStageShape | null;
  /** Drop text into the prompt box (a fenced log, ready to send). */
  onPaste: (text: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  if (!stage?.input) return null;
  // How much this stage is asking of you, before you read what it wants — the
  // ladder the flow gallery draws, L0 watch through L5 co-edit.
  const eng = engagement(stage.input);
  return (
    <div className="flh" data-gate={stage.gate ? "" : undefined}>
      <i className="flh-mark" aria-hidden>{stage.gate ? "◈" : "◇"}</i>
      <span className="flh-stage">{stage.label}</span>
      <span className="flh-lvl" title={`engagement L${eng.level} — ${eng.verb.toLowerCase()}`}>
        L{eng.level} · {eng.verb}
      </span>
      <span className="flh-want">{WANTS[stage.input] ?? ""}</span>
      {stage.input === "evidence" && (
        <button
          type="button"
          className="flh-btn"
          disabled={busy}
          title="paste the clipboard into the prompt as a code block"
          onClick={async () => {
            setBusy(true);
            // Clipboard reads need permission and a WebView may just refuse:
            // an empty fence is still the thing you wanted, minus one paste.
            let text = "";
            try { text = await navigator.clipboard.readText(); } catch { /* below */ }
            setBusy(false);
            onPaste("```\n" + text.trim() + "\n```\n");
          }}
        >
          PASTE LOG
        </button>
      )}
    </div>
  );
}
