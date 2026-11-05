import { useEffect, useMemo, useState } from "react";
import { Check, Hand, Sparkles, Zap } from "lucide-react";
import { api } from "../../api";
import type { Turn } from "../../chat";
import { flowView, type Flow, type StationState } from "../../lib/flowview";
import { fmtTokens, dur } from "../../lib/week";
import { FRAME, RULE } from "./TurnsPanel";
import { RailHero } from "./RailHero";

const ZONE = 150_000;   // bridge/paths.py ZONE_TOKENS: the smart zone's edge
const SAY: Record<StationState, string> = { done: "done", now: "running now", you: "waits for you", auto: "starts by itself", next: "next" };

/** The FLOW tab (design: .mystical/design-drafts/skill-paths, r2-flow): the path
 *  this session is on as a map in the hero, one station per step, then who
 *  picked it, the finished steps folded, the running one as a card and the steps
 *  ahead. Reads GET /local/flow; the bridge owns the path, the panel only draws it. */
export function FlowPanel({ sessionId, turns, ctxTokens }: { sessionId: string | null; turns: Turn[]; ctxTokens?: number }) {
  const [flow, setFlow] = useState<Flow | null>(null);
  const [now, setNow] = useState(() => Date.now() / 1000);
  const running = turns.some((t) => t.status === "running");
  // A path moves mid-turn (StepDone) and again when the turn ends: read it on a turn's edges, and every few seconds while one runs.
  useEffect(() => {
    if (!sessionId) { setFlow(null); return; }
    let live = true;
    const read = () => api.getFlow(sessionId).then((r) => { if (live) setFlow(r.flow); }).catch(() => {});
    void read();
    if (!running) return () => { live = false; };
    const id = setInterval(() => { setNow(Date.now() / 1000); void read(); }, 3000);
    return () => { live = false; clearInterval(id); };
  }, [sessionId, running]);
  const v = useMemo(() => flowView(flow, turns), [flow, turns]);

  const head = (
    <>
      <div className="gp-head"><span className="gp-title">FLOW</span></div>
      <div style={RULE} />
    </>
  );
  if (!flow || !v.stations.length)
    return (
      <div className="panel gp tn" style={FRAME}>
        {head}
        <RailHero label="No path for this session" top={<span className="rh-k">no path</span>}>
          <div className="fl-none">no path for this session</div>
        </RailHero>
        <div className="tn-none">A path starts when a prompt fits one, or when you type a /mattpocock-skills command.</div>
      </div>
    );

  const at = v.stations.find((s) => s.state === "now") ?? v.stations.find((s) => s.state !== "done");
  const done = v.stations.filter((s) => s.state === "done");
  const ahead = v.stations.filter((s) => s.state === "you" || s.state === "auto" || s.state === "next");
  const cur = v.stations.find((s) => s.state === "now");
  const secs = v.nowTurn?.started ? Math.max(0, now - v.nowTurn.started) : null;
  const name = flow.path === "one" ? "one skill" : flow.path.replace(/-/g, " ");
  const label = `${name} path, step ${v.step} of ${v.total}: ${v.stations.map((s) => `${s.label} ${SAY[s.state]}`).join(", ")}. Auto ${flow.auto ? "on" : "held"}.`;
  const toggle = () => {
    const on = !flow.auto;
    setFlow({ ...flow, auto: on });
    api.setFlowAuto(sessionId!, on).catch(() => setFlow((f) => (f ? { ...f, auto: !on } : f)));
  };
  const pill = (who: "you" | "auto") => who === "you"
    ? <span className="fl-pill you"><Hand size={10} strokeWidth={2.2} aria-hidden /> YOU APPROVE</span>
    : <span className="fl-pill"><Zap size={10} strokeWidth={2.4} aria-hidden /> {flow.auto ? "AUTO" : "HELD"}</span>;

  return (
    <div className="panel gp tn" style={FRAME}>
      {head}
      <RailHero label={label} top={<>
        <span className="rh-k"><b>{name} path</b></span><span className="rh-k fl-n">· {v.step} of {v.total}</span>
        <button className={`fl-auto${flow.auto ? " on" : ""}`} aria-pressed={flow.auto}
          aria-label={flow.auto ? "Auto is on: each step starts by itself. Hold it" : "Auto is held: you start each step. Release it"}
          title={flow.auto ? "steps start by themselves; click to hold" : "held: you start each step; click to release"} onClick={toggle}>
          <Zap size={10} strokeWidth={2.4} aria-hidden /> AUTO
        </button>
      </>}>
        <ol className="fl-map" aria-hidden>
          {v.stations.map((s) => (
            <li key={s.key} className={`fl-st ${s.state}`}>
              <span className="fl-tag">{s.state === "you" ? "YOU" : s.state === "auto" ? <Zap size={9} strokeWidth={2.4} /> : null}</span>
              <i className="fl-mk">{s.state === "done" ? <Check size={11} strokeWidth={3} /> : null}</i>
              <span className="fl-lb">{s.label}</span>
            </li>
          ))}
        </ol>
        <div className="fl-cap">
          {cur ? <><i className="fl-dot" /><b>{cur.label}</b><span>{secs != null ? `${dur(secs)} running` : "running"}</span></>
            : at && at.state !== "done" ? <><b>{at.label}</b><span>{at.who === "you" ? "waits for you" : flow.auto ? "starts after this turn" : "held"}</span></>
            : <span>path complete</span>}
        </div>
      </RailHero>
      <div className="fl-body mscroll">
        <div className="fl-why"><Sparkles size={12} aria-hidden /><span><b>{v.by === "claude" ? "Claude picked this path:" : "A rule picked this path:"}</b> {v.why}</span></div>
        {done.map((s) => (
          <div key={s.key} className="fl-done"><Check size={12} strokeWidth={2.6} aria-hidden /><b>{s.label}</b>{s.skill && <span>{s.skill}</span>}</div>
        ))}
        {cur && (
          <div className="fl-now">
            <div className="t"><span className="n">{cur.label}</span>{cur.skill && <span className="cmd">/{cur.skill}</span>}
              {cur.who === "auto" && <span className="r fl-pill on"><Zap size={10} strokeWidth={2.4} aria-hidden /> BY ITSELF</span>}</div>
            {v.nowTurn?.activity && <div className="act"><i>now</i> {v.nowTurn.activity}</div>}
            <div className="chips">{cur.skill && <span className="fl-pill">{cur.skill}</span>}<span className="fl-pill">{v.nowTurn?.tools ?? 0} tools</span></div>
          </div>
        )}
        {ahead.filter((s) => s !== cur).map((s) => (
          <div key={s.key} className="fl-next"><span className="n">{s.label}</span><span className="d">{s.skill ? `/${s.skill}` : ""}</span>{pill(s.who)}</div>
        ))}
      </div>
      {ctxTokens != null && (
        <div className={`fl-zone${ctxTokens > ZONE ? " over" : ""}`}>
          CONTEXT {fmtTokens(ctxTokens)} / {fmtTokens(ZONE)}{ctxTokens > ZONE ? " · PAST THE SMART ZONE" : ""}
          <div className="bar"><i style={{ width: `${Math.min(100, (ctxTokens / ZONE) * 100)}%` }} /></div>
        </div>
      )}
    </div>
  );
}
