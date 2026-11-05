import type { ReactNode } from "react";
import { ArrowDown, ArrowUp, Cloud, GitBranch, GitCommitHorizontal, Laptop } from "lucide-react";
import { pipe, type Flow, type PipeSync } from "../../lib/gitpipe";
import { RailHero } from "./RailHero";

/* The Git tab's hero: Mac -> branch -> origin, with the one move that closes the
   first open gap laid across it. The button never decides anything: the panel
   passes what each verb does (Commit only opens the message box). */
const ICON = { mac: Laptop, branch: GitBranch, origin: Cloud } as const;
const VERB = { Commit: GitCommitHorizontal, Publish: ArrowUp, Pull: ArrowDown } as const;

// Dotted arrows flowing along a gap; two of them (one each way) when diverged.
function Gap({ flows }: { flows: Flow[] }) {
  const ys = flows.length === 2 ? [21, 33] : [27];
  return (
    <svg className="gpp-gap" width="28" height="54" viewBox="0 0 28 54" aria-hidden>
      {flows.length === 0 && <line x1="3" y1="27" x2="25" y2="27" className="gpp-calm" opacity={0.35} />}
      {flows.map((f, i) => {
        const [x1, x2] = f.dir > 0 ? [4, 22] : [24, 6];
        const y = ys[i];
        return (
          <g key={i} className={`gpp-fl ${f.tone}`}>
            <line x1={x1} y1={y} x2={x2} y2={y} className="gpp-dash" />
            <path d={`M${x2 - 4 * f.dir} ${y - 3.5} L${x2 + f.dir} ${y} L${x2 - 4 * f.dir} ${y + 3.5}`} />
          </g>
        );
      })}
    </svg>
  );
}

export function GitPipe({ sync, changed, hasUpstream, unchecked, where, loading, right, busy, onAction }: {
  sync: PipeSync; changed: number; hasUpstream: boolean; unchecked: boolean;
  /** the upstream's name when it is not origin/<same branch> */
  where?: string;
  /** the status has not arrived: no station claims anything yet */
  loading?: boolean;
  /** the top line's right end: how fresh origin is, or what's being checked */
  right?: ReactNode;
  busy: boolean;
  onAction: (verb: "Commit" | "Publish" | "Pull", n: number) => void;
}) {
  const p = pipe(sync, changed, hasUpstream, unchecked, where);
  const line = loading ? "reading…" : p.say;
  const a = loading ? null : p.action;
  const pu = loading ? null : p.push;
  const label = `${line}${a ? `. ${a.verb} ${a.n} available` : ""}`;
  const gapFlows = (g: 0 | 1) => loading ? [] : p.flows.filter((f) => f.gap === g);
  const title = a?.verb === "Pull" && sync.kind === "diverged" ? `Opens a session to bring origin's ${a.n} commits in` : undefined;
  const Verb = a ? VERB[a.verb] : null;
  // Bold the first count in the sentence, as drawn.
  const m = /^(\d+\+?(?: files?| commits?)?)(.*)$/.exec(line);
  return (
    <RailHero label={label} top={<>
      <span className="gpp-say">{m ? <><b>{m[1]}</b>{m[2]}</> : line}</span>
      {right && <span className="gpp-right">{right}</span>}
    </>}>
      <div className="gpp">
        <div className="gpp-row">
          {p.stations.flatMap((s, i) => {
            const Icon = ICON[s.key];
            const st = (
              <div key={s.key} className={`gpp-st${s.hot && !loading ? " hot" : ""}${s.warm && !loading ? " warm" : ""}`}>
                <div className="gpp-big"><Icon size={13} strokeWidth={2} aria-hidden />
                  {!loading && <b className={s.big === "✓" && !s.hot ? "ok" : ""}>{s.big}</b>}</div>
                <span title={loading ? undefined : s.sub}>{loading ? "" : s.sub}</span>
              </div>
            );
            return i < 2 ? [st, <Gap key={`g${i}`} flows={gapFlows(i as 0 | 1)} />] : [st];
          })}
        </div>
        {a && Verb ? (
          <>
            <button type="button" className={`gpp-btn ${a.tone} g${a.gap}`} title={title} disabled={busy} onClick={() => onAction(a.verb, a.n)}>
              <Verb size={12} strokeWidth={2.6} aria-hidden />{a.verb} {a.n > 99 ? "99+" : a.n}
            </button>
            <i className={`gpp-tick ${a.tone} g${a.gap} l`} aria-hidden /><i className={`gpp-tick ${a.tone} g${a.gap} r`} aria-hidden />
          </>
        ) : !loading && <div className="gpp-none">Nothing to move</div>}
        {pu && <button type="button" className="gpp-sec" disabled={busy} onClick={() => onAction("Publish", pu.n)}>{pu.verb} {pu.n > 99 ? "99+" : pu.n}</button>}
      </div>
    </RailHero>
  );
}
