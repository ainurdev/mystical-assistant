import { ArrowDown, ArrowUp, Check, Cloud, GitBranch, Laptop } from "lucide-react";
import type { Pipe, Track } from "../../lib/gitpipe";

/* The Git tab's hero: your work tracked like a parcel, on this Mac -> committed
   -> on origin. A sentence says where it is, one line the next hop, and the
   buttons are the hops (the panel passes what each does; Commit only opens the
   message box). The lit stretch of the line runs up to the stop it waits at.
   Incoming work from origin is amber (--warn), never --ask: that colour means
   "waits on you". Class names are gt-*, this panel's only. */
const ICON = { mac: Laptop, branch: GitBranch, origin: Cloud } as const;
const VERB = { Commit: Check, Publish: ArrowUp, Pull: ArrowDown } as const;
// Half way along the gap after the stop the work waits at; landed fills the line.
const LIT = { "-1": 100, 0: 25, 1: 75, 2: 100 } as const;

export function GitTracker({ t, p, loading, busy, title, onAction }: {
  t: Track; p: Pipe; loading?: boolean; busy: boolean;
  /** hover text for the primary (diverged Pull opens a session) */
  title?: string;
  onAction: (verb: "Commit" | "Publish" | "Pull", n: number) => void;
}) {
  const a = loading ? null : p.action;
  const pu = loading ? null : p.push;
  const Verb = a ? VERB[a.verb] : null;
  const num = (n: number) => (n > 99 ? "99+" : n);
  return (
    <section className={`gt-trk${loading ? " load" : ""}`} aria-label={loading ? "Reading git" : `${t.say}. ${t.next}`}>
      <div className="gt-say">{loading ? "Reading…" : t.say}</div>
      <div className="gt-next">{loading ? "" : t.next}</div>
      <div className="gt-steps">
        <span className="gt-ln"><b style={{ width: loading ? 0 : `${LIT[t.at]}%` }} /></span>
        {t.stops.map((s, i) => {
          const Icon = ICON[s.key];
          const done = !loading && (t.at === -1 || i < t.at || s.tone === "ok");
          const on = !loading && i === t.at;
          return (
            <span key={s.key} className={`gt-s${on ? ` on ${s.tone === "warn" ? "warn" : ""}` : done ? " done" : ""}`}>
              <i><Icon size={13} strokeWidth={2} aria-hidden /></i>
              <b>{s.label}</b>
              <span className={loading ? "" : s.tone} title={loading ? undefined : s.value}>{loading ? "" : s.value}</span>
            </span>
          );
        })}
      </div>
      {(a || pu) && Verb && a && (
        <div className="gt-bt">
          <button type="button" className={`gt-btn pri ${a.tone}`} title={title} disabled={busy} onClick={() => onAction(a.verb, a.n)}>
            <Verb size={13} strokeWidth={2.4} aria-hidden /><span>{a.verb} {num(a.n)}</span>
          </button>
          {pu && (
            <button type="button" className="gt-btn soft" disabled={busy} onClick={() => onAction("Publish", pu.n)}>
              <ArrowUp size={13} strokeWidth={2.4} aria-hidden /><span>{pu.verb} {num(pu.n)}</span>
            </button>
          )}
        </div>
      )}
    </section>
  );
}
