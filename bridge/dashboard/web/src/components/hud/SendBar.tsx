import { useState } from "react";
import { Send } from "lucide-react";
import type { Teammate } from "../../api";
import { Avatar } from "./TeamPanel";

/* "Send this session to <person>" pinned at the Team tab's foot. The roster comes
   online-first; the default pick is the first (an online person if any). The person
   is a native select under the pill, so it is keyboard- and screen-reader-ready. */
export function SendBar({ roster, sessionTitle, onSend }: { roster: Teammate[]; sessionTitle: string; onSend: (t: Teammate) => void }) {
  const [pick, setPick] = useState<string | null>(null);
  const to = roster.find((t) => t.id === pick) ?? roster[0];
  return (
    <div className="tf-send">
      <span className="tf-lbl">Send this session to</span>
      <label className="tf-to">
        <Avatar id={to.id} name={to.name} src={to.avatarUrl} size={18} />
        <span className="tf-nm">{to.name.trim().split(/\s+/)[0]}</span>
        <select aria-label="Send to" value={to.id} onChange={(e) => setPick(e.target.value)}>
          {roster.map((t) => <option key={t.id} value={t.id}>{t.name}{t.online ? " · on now" : ""}</option>)}
        </select>
      </label>
      <button type="button" className="tf-go" title={`Send “${sessionTitle}” to ${to.name}`} aria-label={`Send “${sessionTitle}” to ${to.name}`} onClick={() => onSend(to)}>
        <Send size={15} strokeWidth={2} />
      </button>
    </div>
  );
}
