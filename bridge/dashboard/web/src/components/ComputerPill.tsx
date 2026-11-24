import { useState } from "react";
import { MonitorCog } from "lucide-react";
import { api } from "../api";
import type { Turn } from "../chat";
import { driving } from "../lib/computer";

/* The DRIVING strip of .mystical/design-drafts/computer-use (2 · Driving), as a
   pill in the row above the prompt box, beside the goal and wait pills. STOP
   drops the chat's apps, frees the desktop and interrupts the turn; Esc on the
   Mac does the same. */
export function ComputerPill({ sessionId, turns }: { sessionId: string; turns: Turn[] }) {
  const [stopping, setStopping] = useState(false);
  const d = driving(turns);
  if (!d) return null;
  const stop = () => {
    setStopping(true);
    void api.setComputer(sessionId, { stop: true }).catch(() => {}).finally(() => setStopping(false));
  };
  return (
    <div className="cu-pill" title="This chat is controlling your Mac. Esc on the Mac stops it too.">
      <span className="cu-pulse" aria-hidden />
      <MonitorCog size={11} strokeWidth={2.2} aria-hidden style={{ flex: "none" }} />
      <span className="cu-dl caps">Driving</span>
      {d.apps.slice(0, 3).map((a) => <span key={a} className="cu-chip">{a}</span>)}
      {d.apps.length > 3 && <span className="pill-desc" style={{ color: "var(--txl)" }}>+{d.apps.length - 3}</span>}
      <span className="pill-desc" style={{ flex: "none", color: "var(--txl)" }}>· {d.actions} action{d.actions === 1 ? "" : "s"}</span>
      <button type="button" className="cu-stop caps" onClick={stop} disabled={stopping} title="Stop: drop its apps and interrupt the turn">
        Stop <span className="cu-kc">Esc</span>
      </button>
    </div>
  );
}
