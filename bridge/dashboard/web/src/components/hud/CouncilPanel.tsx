import { Fragment, useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowUp, Check, MessageSquare, Play, RotateCw, Send, Settings, Square, X } from "lucide-react";
import { api, type CouncilBrief, type CouncilFinding } from "../../api";
import { agreed, answered, coin, coinName, columns, hero, reviewerName, reviewers, rollWhy, rules, who } from "../../lib/council";
import { ICON_BODY } from "../../lib/fileicons.gen";
import { openSettings } from "../../lib/opensettings";
import { notify } from "./Notifications";
import { FRAME, RULE } from "./SessionPanel";

/* The COUNCIL tab (docs/superpowers/specs/council-tab.md; design:
   .mystical/design-drafts/council-tab, A · SCOREBOARD). The score leads: a
   230px board with the number, a column per round climbing to the bar's dashed
   line, and the two pass rules. The reviewers sit under it as a roll call
   (design: council-reviewers, B · ROLL CALL): a coin per account at one height
   for any count, and a line naming only who sat out or didn't answer. Or, when
   a stopped run has a finding they keep raising, that finding and your two ways
   out. Then the list: before a run what it would review, during and after one
   the whole run as To fix, Fixed and Answered (council.py ledger), most urgent
   first. Its one or two moves are pinned under it.
   It polls bridge/council.py's brief(): every 3 s while a run reviews or
   fixes, every 15 s otherwise, and only then `full`, whose git read is what
   RUN would review and what PUSH would send. Every read also goes up to App
   (onBrief), so a tap here moves the rail tile at once. Styles under COUNCIL
   TAB in index.css. */

const STALE = /^(HTTP 404|not found)$/i;     // a bridge from before the council
const SAY: Record<string, string> = {
  running: "The session is running. Try again when its turn ends.",
  busy: "The council is already running.",
  nothing: "Nothing to review: no commits or changes ahead of origin.",
  action: "The council has moved on, so that can't be done now.",
};
const SEV = { must: "MUST", should: "SHOULD", nit: "NIT" } as const;
const H = 72;   // px a 10 reaches in the chart
const LINE = { fill: "none", stroke: "currentColor", strokeLinecap: "round", strokeLinejoin: "round" } as const;
// Claude's mark is simple-icons' (as the PROFILE chip's); Codex's is the mockup's hexagon prompt. Settings' Council fold wears them through Mark.
// shortcut: Gemini's, Kimi's and opencode's are the mockup's stand-in glyphs; swap in their own once the icon set has them.
const MARK: Record<string, ReactNode> = {
  claude: <svg viewBox="0 0 24 24" width={12} height={12} aria-hidden dangerouslySetInnerHTML={{ __html: ICON_BODY["si:claude"] }} />,
  codex: (
    <svg viewBox="0 0 24 24" width={13} height={13} aria-hidden fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 2.5 20.5 7.3v9.4L12 21.5 3.5 16.7V7.3Z" /><path d="m9 9.5 3 2.5-3 2.5M13 15h3" />
    </svg>
  ),
  gemini: <svg viewBox="0 0 24 24" width={13} height={13} aria-hidden><path fill="currentColor" d="M12 2c.6 5.3 4.7 9.4 10 10-5.3.6-9.4 4.7-10 10-.6-5.3-4.7-9.4-10-10 5.3-.6 9.4-4.7 10-10Z" /></svg>,
  kimi: <svg viewBox="0 0 24 24" width={12} height={12} aria-hidden {...LINE} strokeWidth={2.6}><path d="M7 4v16M17 4l-7 8 7 8" /></svg>,
  opencode: <svg viewBox="0 0 24 24" width={13} height={13} aria-hidden {...LINE} strokeWidth={2.4}><path d="M8 7 3.5 12 8 17M16 7l4.5 5-4.5 5" /></svg>,
};
/** An agent's mark on its plate; an agent with no glyph wears its initial. */
export const Mark = ({ agent, dim }: { agent: string; dim?: boolean }) =>
  <span className={`cn-mk ${agent}${dim ? " no" : ""}`} aria-hidden>{MARK[agent] ?? agent.charAt(0).toUpperCase()}</span>;
const NOTE = <>Each round your reviewers read it fresh. <b>The session that wrote it</b> gets what they found as one prompt, fixes it or answers why not, and they read it again.</>;

const live = (c: CouncilBrief | null) => c?.status === "reviewing" || c?.status === "fixing";
const at = (f: CouncilFinding) => (f.line == null ? f.file : `${f.file}:${f.line}`);
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
// A finding you sided with the session on never blocks again: it reads settled.
const stateOf = (f: CouncilFinding) => (f.dismissed ? "settled" : f.state);

/** A finding: its marks, one per reviewer that answered (lit for those that flagged it), and "2/3". */
function Finding({ f, ran, seats, right }: { f: CouncilFinding; ran: string[]; seats: CouncilBrief["seats"]; right?: ReactNode }) {
  const st = stateOf(f);
  const n = f.by.filter((k) => ran.includes(k)).length;
  return (
    <div className={`cn-fd${st === "fixed" ? " done" : ""}`}>
      <span className={`cn-sev ${f.sev}`}>{SEV[f.sev]}</span>
      <div className="cn-w">
        <div className="cn-t" title={f.title}>{f.title}</div>
        <div className="cn-s">
          <code>{at(f)}</code>
          {ran.length > 0 && <span className="cr-who">
            <span className="cr-by">{ran.map((k) => <Mark key={k} agent={who(k, seats[k]).agent} dim={!f.by.includes(k)} />)}</span>
            <span className={`cr-n${agreed(f, ran) ? " maj" : ""}`}>{n}/{ran.length}<span className="sr-only"> reviewers flagged it</span></span>
          </span>}
        </div>
        {f.answer && <div className="cn-ans">Session: {f.answer}</div>}
      </div>
      {/* in the run's list the group says the state: the row says its round (green ✓ fixed, yellow still open) */}
      {right ?? <span className="cn-fst" data-st={st}>{st === "fixed" && <Check size={12} strokeWidth={2.8} />}{f.round == null ? st : st === "settled" ? `settled · R${f.round}` : `R${f.round}`}</span>}
    </div>
  );
}

export function CouncilPanel({ sid, project, branch, busy, initial = null, onBrief, onOpenChat, onSend, onPushed }: {
  sid: string | null;
  /** What GIT's PUSH pushes: Push N commits and Push anyway are that push. */
  project: string | null;
  branch?: string;
  /** The session is running a turn: RUN waits for it to end. */
  busy: boolean;
  /** App's last light read of this run, so the board draws before the first poll lands. */
  initial?: CouncilBrief | null;
  /** Every brief read here, for the rail tile. */
  onBrief?: (c: CouncilBrief) => void;
  /** The chat at its latest turn, as TURNS' latest button takes you. */
  onOpenChat: () => void;
  /** To this session's chat: one piece of advice. */
  onSend?: (text: string) => void;
  /** A push from here ended: App re-reads the git status. */
  onPushed?: () => void;
}) {
  const [c, setC] = useState<CouncilBrief | null>(initial);
  const [fail, setFail] = useState("");
  const [doing, setDoing] = useState("");                             // the move in flight
  const [sent, setSent] = useState<Set<string>>(() => new Set());     // advice sent one at a time
  const [nonce, setNonce] = useState(0);                              // bumped: read now
  // Bumped on both sides of every move. The server is threaded and brief() takes
  // its snapshot before a full read's git runs, so a read begun before a move
  // ends can answer after it with the state from before (Send all live again,
  // a side taken undone). Only a read begun after the move may land.
  const gen = useRef(0);
  const tell = useRef(onBrief);
  tell.current = onBrief;
  const on = live(c);

  // An answer without the material (an action's, a light poll's) keeps the one a full read brought.
  const land = (b: CouncilBrief) => {
    setC((p) => ("material" in b || !p ? b : { ...b, material: p.material }));
    setFail("");
    tell.current?.(b);
  };
  useEffect(() => {
    if (!sid) return;
    let alive = true, t = 0;
    // `full` runs git, so only while no run moves; a run that moves is read lightly and often.
    // The next read is set when this one ends, so a slow full read never stacks a second git run.
    const read = () => {
      const g = gen.current;
      api.council(sid, !on)
        .then((b) => { if (alive && g === gen.current) land(b); }, (e: Error) => { if (alive && g === gen.current) setFail(e.message); })
        .finally(() => { if (alive) t = window.setTimeout(read, on ? 3000 : 15000); });
    };
    read();
    return () => { alive = false; window.clearTimeout(t); };
  }, [sid, on, nonce]);

  const act = async (action: string, key?: string) => {
    if (!sid) return;
    setDoing(action);
    gen.current++;
    try {
      land(await api.councilAct(sid, action, key));
    } catch (e) {
      const m = (e as Error).message;
      notify("error", STALE.test(m) ? "Restart the bridge to use the council." : SAY[m] ?? m);
    } finally { gen.current++; setDoing(""); }   // no await between the answer and here: no read lands in between
  };
  const n = c?.material?.commits.length ?? 0;
  // GIT's push (GitPanel sync("push")): the same call on the same project and branch.
  const push = async () => {
    if (!project) return;
    setDoing("push");
    try {
      const r = await api.gitPush(project, branch || undefined);
      notify(r.ok ? "info" : "error", r.ok ? `Pushed ${plural(n, "commit")}.` : r.output || "Push refused.");
    } catch (e) { notify("error", (e as Error).message); }
    finally { setDoing(""); onPushed?.(); setNonce((x) => x + 1); }
  };
  // One piece of advice, in the shape Send all's lines take (council.py _line).
  const sendOne = (f: CouncilFinding) => {
    onSend?.(`[council advice]\n1. ${f.sev.toUpperCase()} · ${at(f)} · ${f.by.length} of ${c ? answered(c).length : 0} · ${f.title}`);
    setSent((s) => new Set(s).add(`${at(f)} ${f.title}`));
  };

  const frame = (body: ReactNode) => (
    <div className="panel gp cn" style={FRAME}>
      <div className="gp-head">
        <span className="gp-title">COUNCIL</span>
        {branch && <span className="gp-branch" title={branch}><i>⎇</i><span>{branch}</span></span>}
        {on && c && <span className="cn-pill acc">R{c.round}/{c.max_rounds}</span>}
        <button className="gp-ib" title="council settings" aria-label="council settings" onClick={() => openSettings("aimgmt")}>
          <Settings size={13} />
        </button>
      </div>
      <div style={RULE} />
      {body}
    </div>
  );
  if (!sid) return frame(<div className="cn-none">Open a session to review its work.</div>);
  if (STALE.test(fail)) return frame(<div className="cn-none">Restart the bridge to use the council.</div>);
  if (!c) return frame(<div className="cn-none">{fail ? `Couldn't read the council — ${fail}` : "Reading…"}</div>);

  const h = hero(c);
  const r = rules(c);
  const cols = columns(c);
  const last = c.rounds[c.rounds.length - 1];
  const ran = answered(c);                       // a finding's marks and "2/3" count these
  const m = c.material;
  const stuck = c.status === "stopped" ? c.stuck : null;
  const dis = !!doing;
  const runHint = busy ? "Waits for this session's turn to end." : m === null ? SAY.nothing : "";
  const bar = c.bar.toFixed(1);

  const board = (
    <section className={`cn-sb ${{ dim: "idle", acc: "", ok: "ok", ask: "ask" }[h.tone]}`}>
      <div className="cn-top">
        <div className="cn-n">
          {c.score == null ? <><span aria-hidden>–.–</span><span className="sr-only">no score yet</span></> : c.score.toFixed(1)}
          <small>/10</small>
        </div>
        <div className="cn-st">
          <span className={`cn-pill ${h.tone}`}>
            {on && <span className="cn-pulse" />}{h.tone === "ok" && <Check size={10} strokeWidth={3} />}{h.pill}
          </span>
          <div className="cn-l1" title={h.l1}>{h.l1}</div>
          <div className="cn-l2">{h.l2}</div>
        </div>
      </div>
      <div className="cn-chart" role="img"
        aria-label={`bar ${bar}: ${cols.map((k) => `${k.n} ${k.v?.toFixed(1) ?? (k.cls === "now" ? "reviewing" : "not run")}`).join(", ")}`}>
        <span className="cn-bl" style={{ bottom: 15 + (c.bar / 10) * H }}><span>BAR {bar}</span></span>
        {cols.map((k) => (
          <div key={k.n} className={`cn-c ${k.cls}`}>
            <b>{k.v != null ? k.v.toFixed(1) : k.cls === "now" ? "…" : " "}</b>
            <i style={{ height: k.v != null ? (k.v / 10) * H : k.cls === "now" ? (c.bar / 10) * H : 4 }} />
            <em>{k.n}</em>
          </div>
        ))}
      </div>
      <div className="cn-rule">
        <span className={r.avg == null ? "" : r.avg ? "y" : "no"}>
          {r.avg === false ? <X size={11} strokeWidth={2.6} /> : <Check size={11} strokeWidth={2.6} />}
          <em>{r.avg == null ? `average ≥ ${bar}` : `average ${c.score?.toFixed(1)}`}</em>
        </span>
        <span className={r.shared == null ? "" : r.shared ? "y" : "no"}>
          {r.shared === false ? <X size={11} strokeWidth={2.6} /> : <Check size={11} strokeWidth={2.6} />}
          <em>{r.shared === false ? `${last?.blocking} agreed must-fix` : "no agreed must-fix"}</em>
        </span>
      </div>
    </section>
  );

  const why = rollWhy(c);
  const seats = (
    <>
      <div className="cr-roll" role="list" aria-label="Reviewers">
        {reviewers(c).map(([k, s]) => {
          const w = who(k, s), look = coin(s, c.status === "passed");
          return (
            <div key={k} role="listitem" className={`cr-coin${look.cls && ` ${look.cls}`}`}
              title={[reviewerName(w), s.summary || s.error].filter(Boolean).join(" — ")}>
              <Mark agent={w.agent} />
              <b>{look.mid === "spin" ? <span className="cn-spin" role="img" aria-label="reading" /> : look.mid}</b>
              <em>{coinName(w)}</em>
            </div>
          );
        })}
      </div>
      <div className="cr-why">
        {why.odd.length ? why.odd.map((o, i) => <Fragment key={i}>{i > 0 && " · "}<b>{o.name}</b> {o.text}</Fragment>) : why.note}
      </div>
    </>
  );

  const needs = stuck && (
    <div className="cn-needs">
      <div className="k">THEY DISAGREE · {stuck.rounds + 1} ROUNDS</div>
      <div className="q">{stuck.finding.title}</div>
      <code className="m">{at(stuck.finding)} · {stuck.finding.by.length} of {ran.length} reviewers</code>
      {stuck.answer && <div className="cn-ans">Session: {stuck.answer}</div>}
      <div className="o">
        <button className="cn-btn soft sm grow" disabled={dis} onClick={() => void act("side", stuck.finding.id)}>Side with the session</button>
        <button className="cn-btn ghost sm grow" disabled={dis} onClick={() => void act("fix", stuck.finding.id)}>Fix it anyway</button>
      </div>
    </div>
  );

  let list: ReactNode = null;
  if (c.status === "idle") {
    list = (
      <>
        <div className="cn-lbl">IT WILL REVIEW
          {m && <span className="r">{plural(m.commits.length, "commit")} · {plural(m.files, "file")} · <span className="add">+{m.add}</span> <span className="del">−{m.del}</span></span>}
        </div>
        {!!m?.commits.length && (
          <div className="cn-rows">
            {m.commits.map(([sha, subject]) => (
              <div key={sha} className="cn-r1"><i /><span title={subject}>{subject}</span><code>{sha}</code></div>
            ))}
          </div>
        )}
        <div className="cn-note">{runHint || NOTE}</div>
      </>
    );
  } else {
    // A run: one list across its rounds (council.py ledger), each group most urgent first.
    // Passed, what's left to fix is advice: Send each, or Send all. The finding they keep
    // raising sits in its own card above, so the list leaves it out.
    const toFix = stuck ? c.to_fix.filter((f) => f.id !== stuck.finding.id) : c.to_fix;
    const groups = ([[stuck ? "Also to fix" : "To fix", toFix], ["Fixed", c.fixed], ["Answered", c.answered]] as const)
      .filter(([, fs]) => fs.length);
    const advice = c.status === "passed";
    const marks = (f: CouncilFinding) => answered(c, c.rounds.find((r) => r.n === f.round));
    list = groups.length ? groups.map(([label, fs]) => (
      <Fragment key={label}>
        <div className="cn-lbl"><span className="caps">{label}</span> <span className="n">{fs.length}</span>
          {advice && fs === toFix && (
            <button className="cn-btn ghost sm r" disabled={dis || c.advice_sent} onClick={() => void act("advice")}>
              <Send size={11} strokeWidth={2} />{c.advice_sent ? "Sent" : "Send all"}
            </button>
          )}
        </div>
        <div className="cn-rows">
          {fs.map((f) => {
            const done = sent.has(`${at(f)} ${f.title}`);
            return <Finding key={f.id} f={f} ran={marks(f)} seats={c.seats} right={advice && fs === toFix && onSend ? (
              <button className="cn-btn ghost sm" disabled={done} onClick={() => sendOne(f)}><Send size={11} strokeWidth={2} />{done ? "Sent" : "Send"}</button>
            ) : undefined} />;
          })}
        </div>
      </Fragment>
    )) : advice ? <div className="cn-note">Nothing left to fix.</div> : live(c) ? <div className="cn-note">{NOTE}</div> : null;
  }

  const pushBtn = (label: string, cls: string) => (
    <button className={`cn-btn ${cls}`} disabled={dis || !project || !n} title={m !== undefined && !n ? "Nothing to push" : undefined}
      onClick={() => void push()}>
      <ArrowUp size={13} strokeWidth={2.4} />{doing === "push" ? "Pushing…" : label}
    </button>
  );
  const foot = on ? (
    <>
      <button className="cn-btn soft grow" onClick={onOpenChat}><MessageSquare size={13} />Open the chat</button>
      <button className="cn-btn ghost" disabled={dis} onClick={() => void act("stop")}><Square size={12} />Stop</button>
    </>
  ) : c.status === "passed" ? (
    <>
      {pushBtn(m === undefined ? "Push" : `Push ${plural(n, "commit")}`, "pri grow")}
      <button className="cn-btn ghost" disabled={dis || !!runHint} title={runHint || undefined} onClick={() => void act("run")}>
        <RotateCw size={13} />Again
      </button>
    </>
  ) : c.status === "stopped" ? (
    <>
      {/* it may read at once, so like RUN it waits for the session's turn (council.act refuses too) */}
      <button className="cn-btn ask grow" disabled={dis || busy} title={busy ? "Waits for this session's turn to end." : undefined}
        onClick={() => void act("more")}>
        <RotateCw size={13} />2 more rounds
      </button>
      {pushBtn("Push anyway", "ghost")}
    </>
  ) : (
    <button className="cn-btn pri grow" disabled={dis || !!runHint} title={runHint || undefined} onClick={() => void act("run")}>
      <Play size={12} fill="currentColor" />Run council
    </button>
  );

  return frame(
    <>
      {board}
      {needs || seats}
      <div className="cn-list mscroll">{list}</div>
      <div className="cn-foot">{foot}</div>
    </>,
  );
}
