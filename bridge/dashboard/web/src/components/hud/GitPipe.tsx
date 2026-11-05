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

export function GitPipe({ sync, changed, hasUpstream, say, right, busy, onAction }: {
  sync: PipeSync; changed: number; hasUpstream: boolean;
  /** replaces the computed line while the status is still loading */
  say?: string;
  /** the top line's right end: how fresh origin is, or what's being checked */
  right?: ReactNode;
  busy: boolean;
  onAction: (verb: "Commit" | "Publish" | "Pull", n: number) => void;
}) {
  const p = pipe(sync, changed, hasUpstream);
  const line = say ?? p.say;
  const a = p.action;
  const label = `${line}${a ? `. ${a.verb} ${a.n} available` : ""}`;
  const gapFlows = (g: 0 | 1) => p.flows.filter((f) => f.gap === g);
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
              <div key={s.key} className={`gpp-st${s.hot ? " hot" : ""}${s.warm ? " warm" : ""}`}>
                <div className="gpp-big"><Icon size={13} strokeWidth={2} aria-hidden />
                  <b className={s.big === "✓" && !s.hot ? "ok" : ""}>{s.big}</b></div>
                <span>{s.sub}</span>
              </div>
            );
            return i < 2 ? [st, <Gap key={`g${i}`} flows={gapFlows(i as 0 | 1)} />] : [st];
          })}
        </div>
        {a && Verb ? (
          <>
            <button type="button" className={`gpp-btn ${a.tone} g${a.gap}`} disabled={busy} onClick={() => onAction(a.verb, a.n)}>
              <Verb size={12} strokeWidth={2.6} aria-hidden />{a.verb} {a.n > 99 ? "99+" : a.n}
            </button>
            <i className={`gpp-tick ${a.tone} g${a.gap} l`} aria-hidden /><i className={`gpp-tick ${a.tone} g${a.gap} r`} aria-hidden />
          </>
        ) : <div className="gpp-none">Nothing to move</div>}
      </div>
    </RailHero>
  );
}
