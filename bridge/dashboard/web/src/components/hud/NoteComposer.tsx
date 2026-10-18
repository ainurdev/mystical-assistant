import { useEffect, useState, type KeyboardEvent } from "react";
import { api } from "../../api";

/** The changelog's SEND NOTE form: a one-line title and some text for every install
 *  (docs/superpowers/specs/notif-updates.md). One tap commits docs/notes.md in
 *  the platform checkout and pushes it, like SHIP; the bridge rolls a refused
 *  push back, so a failure leaves nothing behind. Four lines, not an editor. */
export function NoteComposer({ onSent, onCancel, onError }: { onSent: () => void; onCancel: () => void; onError: (msg: string) => void }) {
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [sending, setSending] = useState(false);
  const [up, setUp] = useState({ branch: "master", ahead: 0 });   // the rail's update poll: what the push carries
  useEffect(() => {
    let live = true;
    api.update().then((u) => { if (live) setUp({ branch: u.branch || "master", ahead: u.ahead ?? 0 }); }, () => { /* the hint keeps its defaults */ });
    return () => { live = false; };
  }, []);
  const send = () => {
    if (!title.trim() || sending) return;
    setSending(true);
    api.noteUpdate(title.trim(), body).then((r) => {
      setSending(false);
      if (r.ok) onSent(); else onError(r.output || "the push was refused");
    }, (e: Error) => { setSending(false); onError(e.message); });
  };
  const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); onCancel(); } };
  const waiting = up.ahead > 0 ? ` · with ${up.ahead} commit${up.ahead === 1 ? "" : "s"} already waiting` : "";
  return (
    <div className="ntf-compose" onKeyDown={onKey}>
      <div className="lbl">A NOTE FOR EVERY INSTALL</div>
      <input autoFocus maxLength={80} value={title} onChange={(e) => setTitle(e.target.value)}
        placeholder="Re-enter the Rivendell token after this update" aria-label="title" />
      <textarea rows={4} maxLength={600} value={body} onChange={(e) => setBody(e.target.value)} aria-label="note"
        placeholder="What changed and what to do about it. Plain text; it lands in the changelog of every Mystical that pulls it." />
      <div className="foot">
        <button className="ntf-btn pri" disabled={!title.trim() || sending} onClick={send}>{sending ? "SENDING…" : "SEND NOTE"}</button>
        <button className="ntf-btn ghost" onClick={onCancel}>Cancel</button>
        <span style={{ flex: 1 }} />
        <span className="hint">commits docs/notes.md · pushes ⎇ {up.branch}{waiting}</span>
      </div>
    </div>
  );
}
