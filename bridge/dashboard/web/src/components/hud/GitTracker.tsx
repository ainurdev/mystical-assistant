import { ArrowDown, ArrowUp, ArrowUpDown, Check, Cloud, GitBranch, GitMerge, Laptop, SquarePen, TriangleAlert } from "lucide-react";
import type { Pipe, Track } from "../../lib/gitpipe";

/* The Git tab's hero: your work tracked like a parcel, on this Mac -> committed
   -> on origin. A sentence says where it is, one line the next hop, and the
   buttons are the hops (the panel passes what each does; Commit only opens the
   message box). The lit stretch of the line runs up to the stop it waits at.
   Incoming work from origin is amber (--warn), never --ask: that colour means
   "waits on you". Diverged, the three stops become a FORK: your lane and
   origin's joining at a merge node, with Merge / Merge & push and one line
   saying what the merge's dry run found (/design-first git-diverged).
   Class names are gt-*, this panel's only. */
const ICON = { mac: Laptop, branch: GitBranch, origin: Cloud } as const;
export type Verb = "Commit" | "Publish" | "Push" | "Pull" | "Merge" | "Merge & push";
const VERB = { Commit: Check, Publish: ArrowUp, Push: ArrowUp, Pull: ArrowDown, Merge: GitMerge, "Merge & push": ArrowUpDown } as const;
// Half way along the gap after the stop the work waits at; landed fills the line.
const LIT = { "-1": 100, 0: 25, 1: 75, 2: 100 } as const;

/** Diverged: the counts and the dry run (undefined testing, null couldn't tell, [] clean, files = clash). */
export type Fork = { up: number; down: number; changed: number; upstream: string; clash: string[] | null | undefined };

export function GitTracker({ t, p, loading, busy, fork, onAction }: {
  t: Track; p: Pipe; loading?: boolean; busy: boolean; fork?: Fork | null;
  onAction: (verb: Verb, n: number) => void;
}) {
  const a = loading ? null : p.action;
  const alt = loading ? null : p.alt;
  const fk = loading ? null : fork;
  const clash = fk?.clash?.length ?? 0;
  // Landed: lit only across the leading run of ok stops.
  let run = 0;
  while (run < 3 && t.stops[run].tone === "ok") run++;
  const lit = t.at === -1 ? Math.max(0, (run - 1) * 50) : LIT[t.at];
  const num = (n: number) => (n > 99 ? "99+" : n);
  // A clash turns both merges into hand-offs: the pen says "opens a session", the title what it will do.
  const button = (v: Verb, n: number, cls: string) => {
    const merge = v === "Merge" || v === "Merge & push";
    const Icon = merge && clash ? SquarePen : VERB[v];
    const title = !merge || !fk ? undefined
      : clash ? `Opens a new session with the merge as an unsent draft; it ${v === "Merge" ? "stops before pushing" : "pushes at the end"}`
      : v === "Merge" ? `Merge ${fk.upstream}'s ${fk.down} into this branch here. Pushing stays a separate step.`
      : `Merge ${fk.upstream}'s ${fk.down} in, then push all ${n} to origin`;
    return (
      <button key={v} type="button" className={`gt-btn ${cls}`} title={title} disabled={busy}
        onClick={() => onAction(v === "Push" ? "Publish" : v, n)}>
        <Icon size={13} strokeWidth={2.4} aria-hidden /><span>{v === "Merge & push" ? v : `${v} ${num(n)}`}</span>
      </button>
    );
  };
  // The dry run's verdict, so a press is never a surprise.
  const chk = !fk ? null
    : fk.clash === undefined ? { tone: "", text: "Testing the merge…" }
    : fk.clash === null ? { tone: "", text: "Couldn't test the merge first; a clash would be undone" }
    : clash ? { tone: "warn", text: `${clash === 1 ? "1 file clashes" : `${clash} files clash`} with origin's ${fk.down}` }
    : { tone: "ok", text: fk.changed ? `Merges cleanly; your ${fk.changed === 1 ? "edit stays" : `${fk.changed} edits stay`} put` : "Merges cleanly, nothing clashes" };
  return (
    <section className={`gt-trk${loading ? " load" : ""}`}
      aria-label={loading ? "Reading git" : `${t.say}. ${t.next}${chk ? `. ${chk.text}` : ""}`}>
      <div className="gt-say">{loading ? "Reading…" : t.say}</div>
      <div className="gt-next">{loading ? "" : t.next}</div>
      {fk ? (
        <div className="gt-fork" aria-hidden>
          <span className="gt-lane me"><b>This Mac</b><span>{fk.up} yours</span></span>
          <i className="gt-node me"><Laptop size={13} strokeWidth={2} /></i>
          <i className="gt-rail me" />
          <i className="gt-node them"><Cloud size={13} strokeWidth={2} /></i>
          <i className="gt-rail them" />
          <svg className="gt-join" width="46" height="88" viewBox="0 0 46 88">
            <path d="M0 27 C20 27 16 44 26 44" stroke="var(--acc)" />
            <path d="M0 61 C20 61 16 44 26 44" stroke="var(--warn)" />
          </svg>
          <i className={`gt-mnode${clash ? " clash" : ""}`}>{clash ? <TriangleAlert size={14} strokeWidth={2.2} /> : <GitMerge size={14} strokeWidth={2.4} />}</i>
          <span className="gt-lane them"><b>Origin</b><span>{fk.down} new</span></span>
          <span className="gt-mlbl">{clash ? `${clash} clash` : "Merge"}</span>
        </div>
      ) : (
        <div className="gt-steps">
          <span className="gt-ln"><b style={{ width: loading ? 0 : `${lit}%` }} /></span>
          {t.stops.map((s, i) => {
            const Icon = ICON[s.key];
            // Landed (-1) counts only the stops that really are ok: "not pushed" and "not checked" are not.
            const done = !loading && (t.at === -1 ? s.tone === "ok" : i < t.at || s.tone === "ok");
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
      )}
      {a && (
        <div className="gt-bt">
          {button(a.verb, a.n, `pri ${a.tone}`)}
          {t.then && button("Commit", t.then.n, "soft")}
          {alt && button(alt.verb, alt.n, "soft")}
        </div>
      )}
      {chk && <div className={`gt-chk ${chk.tone}`}>{chk.tone === "ok" ? <Check size={12} strokeWidth={2.4} /> : <TriangleAlert size={12} strokeWidth={2.2} />}<span title={chk.text}>{chk.text}</span></div>}
    </section>
  );
}
