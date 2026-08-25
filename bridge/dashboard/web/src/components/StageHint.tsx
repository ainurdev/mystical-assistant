import { useState } from "react";
import type { FlowStageShape } from "../api";

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
// Mirrors bridge/miniapp/web/src/components/StageHint.tsx. Keep them in sync.

const WANTS: Record<string, string> = {
  approve: "waiting on your approval — the card above has the button",
  arm: "hold the card's button to run it",
  evidence: "paste the log or attach a screenshot",
  triage: "drop the findings that aren't real, on the card above",
  annotate: "note what to change, per screen on the card above",
};

export function StageHint({ stage, onPaste }: {
  /** The stage the session is standing on, or null when it isn't in a flow. */
  stage: FlowStageShape | null;
  /** Drop text into the prompt box (a fenced log, ready to send). */
  onPaste: (text: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  if (!stage?.input) return null;
  return (
    <div className="flex items-center gap-2 px-1 pb-1 text-[10px] tracking-[0.1em] text-muted-foreground">
      <span className="shrink-0">{stage.label}{stage.gate ? " ◆" : ""}</span>
      <span className="min-w-0 truncate">{WANTS[stage.input] ?? ""}</span>
      {stage.input === "evidence" && (
        <button
          type="button"
          disabled={busy}
          className="ml-auto shrink-0 border border-border px-1.5 py-0.5 hover:bg-accent"
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
