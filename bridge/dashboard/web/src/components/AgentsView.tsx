import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ArrowRight, ChevronDown, ChevronLeft, ChevronRight, CircleCheck, Clock, FileText, LoaderCircle, MessageSquare, Pin, Search, Square, SquareTerminal, TriangleAlert, Users } from "lucide-react";
import { api } from "../api";
import { Markdown } from "./Markdown";
import { ago, KIND_WORD, MAIN, sayTo, span, STATUS_WORD, stopAsk, treeRows, type AgentDetail, type Status, type Step, type Team, type TeamAgent, type TeamMessage } from "../lib/agentteam";

// A chat's sub-agents as a team (bridge/agent_team.py): the tree on the left, what you're watching in the
// middle, what they said to each other on the right. It's a mode of one chat, behind the header's
// CHAT / AGENTS switch, and takes the chat's own column: Mystical's sidebars and other chats don't change.
//
// The box at the foot talks to the main agent, because nothing else can be talked to: Claude Code lets
// only the main agent message or stop its sub-agents. So "to one agent" and "stop one agent" are requests
// to the main agent, and the hint under the box says what will happen before you send.

const ICON = { size: 12, strokeWidth: 2, "aria-hidden": true } as const;
const STATUS_ICON: Record<Status, ReactNode> = { running: <LoaderCircle {...ICON} />, waiting: <Clock {...ICON} />, done: <CircleCheck {...ICON} />, failed: <TriangleAlert {...ICON} /> };
const errorOf = (e: unknown) => (e instanceof Error ? e.message : "That didn't work.");
const clock = (sec: number) => (sec ? new Date(sec * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "");
const MAX_PINS = 6;
type Target = { id: string; name: string; group?: boolean };
type Filter = "all" | Status | "pinned";
type Talk = "all" | "report" | "problem" | "you";

const Tag = ({ status, word = true }: { status: Status; word?: boolean }) => (
  <span className="tm-st" data-s={status} title={STATUS_WORD[status]}>{STATUS_ICON[status]}{word ? STATUS_WORD[status] : <span className="sr-only">{STATUS_WORD[status]}</span>}</span>
);

function Diff({ diff }: { diff: NonNullable<Step["diff"]> }) {
  const name = diff.path.split("/").slice(-2).join("/");
  return (
    <div className="tm-diff">
      <div className="tm-diff-f"><FileText size={12} aria-hidden /><b title={diff.path}>{name}</b><span>{diff.new ? "new file · " : ""}+{diff.added}{diff.removed ? ` −${diff.removed}` : ""}</span></div>
      <pre>{diff.lines.map((l, i) => <span key={i} data-k={l.k}>{l.k === "a" ? "+ " : l.k === "r" ? "− " : "  "}{l.t || " "}</span>)}{diff.more ? <span data-k="c">  … {diff.more} more line{diff.more === 1 ? "" : "s"}</span> : null}</pre>
    </div>
  );
}

function StepRow({ step, withDiff }: { step: Step; withDiff: boolean }) {
  if (step.kind === "say") return <p className="tm-said">{step.text}</p>;
  const icon = step.kind === "run" ? <SquareTerminal {...ICON} /> : step.kind === "agent" ? <Users {...ICON} /> : step.kind === "message" ? <MessageSquare {...ICON} /> : <FileText {...ICON} />;
  return (
    <>
      <div className="tm-step" title={step.detail}>{icon}<span>{step.text}</span><small>{clock(step.at)}</small></div>
      {withDiff && step.diff ? <Diff diff={step.diff} /> : null}
    </>
  );
}

/** One agent's detail, kept fresh while it's working. */
function useDetail(sessionId: string, id: string | null, live: boolean): AgentDetail | null {
  const [d, setD] = useState<AgentDetail | null>(null);
  useEffect(() => {
    if (!id) { setD(null); return; }
    let on = true;
    const load = () => { api.agentTeamOne(sessionId, id).then((r) => { if (on) setD(r); }, () => {}); };
    load();
    const t = live ? window.setInterval(load, 2500) : 0;
    return () => { on = false; if (t) window.clearInterval(t); };
  }, [sessionId, id, live]);
  return d && d.id === id ? d : null;
}

function Monitor({ sessionId, agent, under, pinned, onFocus, onPin, onTalk }: {
  sessionId: string; agent: TeamAgent; under: string; pinned: boolean; onFocus: () => void; onPin: () => void; onTalk: () => void;
}) {
  const live = agent.status === "running" || agent.status === "waiting";
  const d = useDetail(sessionId, agent.id, live);
  const steps = (d?.steps ?? []).filter((s) => s.kind !== "say").slice(-3);
  const lastEdit = [...(d?.steps ?? [])].reverse().find((s) => s.diff);
  return (
    <article className="tm-mon" data-s={agent.status}>
      <header>
        <Tag status={agent.status} />
        <button type="button" className="tm-mon-name" onClick={onFocus} title="Focus this agent">{agent.name}</button>
        <button type="button" className="tm-ic" aria-label={`Message ${agent.name}`} title="Message" onClick={onTalk}><MessageSquare size={13} aria-hidden /></button>
        <button type="button" className="tm-ic" aria-pressed={pinned} aria-label={pinned ? `Unpin ${agent.name}` : `Pin ${agent.name}`} title={pinned ? "Unpin" : "Pin"} onClick={onPin}><Pin size={13} aria-hidden /></button>
      </header>
      <small>{under ? `under ${under} · ${span(agent.started, live ? Date.now() / 1000 : agent.updated)} · ` : "this chat's own agent · "}{agent.tools} step{agent.tools === 1 ? "" : "s"}</small>
      {agent.now ? <p className="tm-now">{agent.now}</p> : !live && d?.report ? <p className="tm-now tm-clamp">{d.report}</p> : null}
      {lastEdit?.diff ? <Diff diff={lastEdit.diff} /> : null}
      {steps.map((s, i) => <StepRow key={i} step={s} withDiff={false} />)}
    </article>
  );
}

function Focus({ sessionId, agent, team, pinned, onPin, onBack, onFocus, onTalk, onChat }: {
  sessionId: string; agent: TeamAgent; team: Team; pinned: boolean; onPin: () => void; onBack: () => void; onFocus: (id: string) => void; onTalk: () => void; onChat?: () => void;
}) {
  const live = agent.status === "running" || agent.status === "waiting";
  const d = useDetail(sessionId, agent.id, live);
  const kids = team.agents.filter((a) => a.parent === agent.id);
  const name = (id: string) => team.names?.[id] ?? id;
  const [whole, setWhole] = useState(false);
  return (
    <>
      <div className="tm-bar">
        <button type="button" className="tm-btn" onClick={onBack}><ChevronLeft size={13} aria-hidden />Watching</button>
        <span className="tm-gap" />
        <button type="button" className="tm-ic" aria-label={`Message ${agent.name}`} title="Message" onClick={onTalk}><MessageSquare size={14} aria-hidden /></button>
        <button type="button" className="tm-ic" aria-pressed={pinned} aria-label={pinned ? "Unpin" : "Pin"} title={pinned ? "Unpin" : "Pin"} onClick={onPin}><Pin size={14} aria-hidden /></button>
      </div>
      <div className="tm-scroll tm-focus">
        <h3><Tag status={agent.status} word={false} />{agent.name}{onChat ? <button type="button" className="tm-btn" onClick={onChat}><MessageSquare size={13} aria-hidden />Its chat</button> : null}</h3>
        <small>
          {agent.id === MAIN ? "this chat's own agent" : <>under <button type="button" className="tm-who" onClick={() => onFocus(agent.parent)}>{name(agent.parent)}</button></>}
          {" · "}{STATUS_WORD[agent.status].toLowerCase()}{agent.id === MAIN ? "" : ` · ${span(agent.started, live ? Date.now() / 1000 : agent.updated)}`} · {agent.tools} steps{agent.model ? ` · ${agent.model}` : ""}
        </small>
        {d?.brief ? (
          <section><h4>Its brief</h4><p className={`tm-brief${whole ? "" : " tm-clamp"}`}>{d.brief}</p>{d.brief.length > 320 ? <button type="button" className="tm-more" onClick={() => setWhole((v) => !v)}>{whole ? "Show less" : "Show all"}</button> : null}</section>
        ) : null}
        {agent.now ? <section><h4>Doing now</h4><p className="tm-now">{agent.now}</p></section> : null}
        {!live && d?.report ? <Report text={d.report} failed={agent.status === "failed"} /> : null}
        <section>
          <h4>Work{d?.earlier ? ` · the last ${d.steps.filter((s) => s.kind !== "say").length} of ${d.tools} steps` : ""}</h4>
          {!d ? <p className="tm-empty">Reading…</p> : null}
          {d && !d.steps.length ? <p className="tm-empty">Nothing yet.</p> : null}
          {(d?.steps ?? []).map((s, i) => <StepRow key={i} step={s} withDiff />)}
        </section>
        {kids.length ? (
          <section><h4>Started by it · {kids.length}</h4>
            {kids.map((k) => <button key={k.id} type="button" className="tm-kid" onClick={() => onFocus(k.id)}><Tag status={k.status} word={false} /><span>{k.name}</span><small>{k.now || STATUS_WORD[k.status].toLowerCase()}</small></button>)}
          </section>
        ) : null}
      </div>
    </>
  );
}

function Report({ text, failed }: { text: string; failed: boolean }) {
  const [open, setOpen] = useState(false);
  const long = text.length > 500;
  return (
    <section><h4>{failed ? "How it ended" : "Its report"}</h4>
      <div className={`tm-report tm-md${long && !open ? " tm-short" : ""}`}><Markdown>{text}</Markdown></div>
      {long ? <button type="button" className="tm-more" onClick={() => setOpen((v) => !v)}>{open ? "Show less" : "Show all"}</button> : null}
    </section>
  );
}

function Message({ m, name, onFocus }: { m: TeamMessage; name: (id: string) => string; onFocus: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  const long = m.text.length > 280;
  const who = (id: string) => (id === "you" ? <span className="tm-who" data-you="">You</span> : <button type="button" className="tm-who" onClick={() => onFocus(id)}>{name(id)}</button>);
  return (
    <div className="tm-msg" data-kind={m.kind}>
      <div className="tm-msg-h"><span className="tm-kind">{KIND_WORD[m.kind]}</span><small>{clock(m.at)}</small></div>
      <div className="tm-msg-w">{who(m.from)}<span>to</span>{who(m.to)}</div>
      <div className={`tm-md${long && !open ? " tm-short" : ""}`}><Markdown>{m.text}</Markdown></div>
      {long ? <button type="button" className="tm-more" onClick={() => setOpen((v) => !v)}>{open ? "Show less" : "Show all"}</button> : null}
    </div>
  );
}

export function AgentsView({ sessionId, top, running, onSay, onStop, onChat }: {
  sessionId: string; top: number; running: boolean; onSay: (text: string) => void; onStop: () => void; onChat: () => void;
}) {
  const [team, setTeam] = useState<Team | null>(null);
  const [error, setError] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [talk, setTalk] = useState<Talk>("all");
  const [shut, setShut] = useState<Set<string>>(new Set());
  const [folds, setFolds] = useState<Set<string>>(new Set());
  const [focus, setFocus] = useState<string | null>(null);
  const [find, setFind] = useState<string | null>(null);
  const pinKey = `mystical.agent-pins.${sessionId}`;
  const [pins, setPins] = useState<string[]>(() => { try { return JSON.parse(localStorage.getItem(pinKey) || "null") ?? [MAIN]; } catch { return [MAIN]; } });
  useEffect(() => { try { localStorage.setItem(pinKey, JSON.stringify(pins)); } catch { /* private mode */ } }, [pins, pinKey]);
  const [to, setTo] = useState<Target>({ id: MAIN, name: "Main agent" });
  const [text, setText] = useState("");
  const [menu, setMenu] = useState<"" | "to" | "stop" | "all">("");
  const [said, setSaid] = useState("");
  const box = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    let on = true;
    const load = () => { api.agentTeam(sessionId).then((r) => { if (on) { setTeam(r); setError(""); } }, (e) => { if (on) setError(errorOf(e)); }); };
    load();
    const t = window.setInterval(load, 2000);
    return () => { on = false; window.clearInterval(t); };
  }, [sessionId]);

  const agents = useMemo(() => team?.agents ?? [], [team]);
  const mainRow: TeamAgent | null = useMemo(() => (team?.main ? { ...team.main, parent: "", depth: 0, status: team.main.status === "running" ? (team.main.now.startsWith("Waiting") ? "waiting" : "running") : "done" } : null), [team]);
  const byId = useMemo(() => new Map<string, TeamAgent>([...(mainRow ? [[MAIN, mainRow] as const] : []), ...agents.map((a) => [a.id, a] as const)]), [agents, mainRow]);
  const name = useCallback((id: string) => team?.names?.[id] ?? (id === MAIN ? "Main agent" : id), [team]);
  const q = (find ?? "").trim().toLowerCase();
  const show = useCallback((a: TeamAgent) => (q ? a.name.toLowerCase().includes(q) : filter === "all" ? true : filter === "pinned" ? pins.includes(a.id) : a.status === filter), [filter, pins, q]);
  const rows = useMemo(() => treeRows(agents, shut, q || filter !== "all" ? new Set(agents.map((a) => a.parent)) : folds, show), [agents, shut, folds, show, q, filter]);
  const flip = (set: Set<string>, id: string) => { const n = new Set(set); if (n.has(id)) n.delete(id); else n.add(id); return n; };
  const togglePin = (id: string) => setPins((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id].slice(-MAX_PINS)));
  const talkTo = (a: TeamAgent) => { setTo({ id: a.id, name: a.name }); box.current?.focus(); };
  const counts = team?.counts ?? {};
  const working = (counts.running ?? 0) + (counts.waiting ?? 0);
  const focused = focus ? byId.get(focus) ?? null : null;
  const watched = pins.map((id) => byId.get(id)).filter((a): a is TeamAgent => !!a);
  const messages = useMemo(() => [...(team?.messages ?? [])].filter((m) => talk === "all" || m.kind === talk).reverse().slice(0, 150), [team, talk]);
  const lead = focused && focused.id !== MAIN && agents.some((a) => a.parent === focused.id) ? focused : focused && focused.parent && focused.parent !== MAIN ? byId.get(focused.parent) ?? null : null;

  const send = () => {
    const words = text.trim();
    if (!words) return;
    onSay(sayTo(to, words));
    setText("");
    setSaid(to.id === MAIN ? "Sent to the main agent." : `Asked the main agent to pass it to ${to.name}.`);
  };
  const stopOne = (t: Target) => { setMenu(""); onSay(stopAsk(t)); setSaid(`Asked the main agent to stop ${t.name}${t.group ? " and its helpers" : ""}.`); };
  const hint = !running
    ? <><b>The main agent isn't working right now,</b> so sending this starts a new turn with it.</>
    : to.id === MAIN
      ? <><b>Nothing stops.</b> The main agent reads this at its next step and decides who needs to hear it.{working ? ` ${working} agent${working === 1 ? " keeps" : "s keep"} working.` : ""}</>
      : <><b>Nothing stops.</b> Mystical can't reach a sub-agent itself, so the main agent is asked to pass this to <b>{to.name}</b>{to.group ? " and its helpers" : ""} at its next step.</>;

  return (
    <div className="tm" style={{ paddingTop: top }}>
      <div className="tm-sum">
        <div><b>{working}</b>working</div>
        <div><b>{counts.done ?? 0}</b>done</div>
        {counts.failed ? <div data-warn=""><b>{counts.failed}</b>failed</div> : null}
        <div><b>{agents.length}</b>agents{team?.depth && team.depth > 1 ? `, ${team.depth} levels deep` : ""}</div>
        <span className="tm-gap" />
        {error ? <span className="tm-err" role="alert">{/not found|404/i.test(error) ? "Press ⟳ to load the Agents view: this bridge is running older code." : error}</span> : null}
      </div>
      <div className="tm-cols">
        <div className="tm-col">
          <div className="tm-bar">
            {find === null ? <><b>Agents</b><span className="tm-gap" /><button type="button" className="tm-ic" aria-label="Find an agent" onClick={() => setFind("")}><Search size={14} aria-hidden /></button></>
              : <input autoFocus className="tm-find" value={find} placeholder="Find an agent" aria-label="Find an agent" onChange={(e) => setFind(e.target.value)} onKeyDown={(e) => { if (e.key === "Escape") setFind(null); }} onBlur={() => { if (!find) setFind(null); }} />}
          </div>
          <div className="tm-chips" role="group" aria-label="Show">
            {([["all", `All ${agents.length}`], ["running", `Working ${counts.running ?? 0}`], ["waiting", `Waiting ${counts.waiting ?? 0}`], ["failed", `Failed ${counts.failed ?? 0}`], ["done", `Done ${counts.done ?? 0}`], ["pinned", `Pinned ${pins.length}`]] as [Filter, string][])
              .filter(([f]) => f === "all" || f === "pinned" || f === "running" || f === "done" || (counts[f as Status] ?? 0) > 0)
              .map(([f, label]) => <button key={f} type="button" aria-pressed={filter === f} onClick={() => setFilter(f)}>{label}</button>)}
          </div>
          <div className="tm-scroll">
            <ul className="tm-tree">
              {mainRow && !q && (filter === "all" || (filter === "pinned" && pins.includes(MAIN))) ? (
                <li data-s={mainRow.status} style={{ ["--d" as string]: 0 }}>
                  <div className={focus === MAIN ? "tm-sel" : undefined}>
                    <span className="tm-tw" />
                    <button type="button" className="tm-row" onClick={() => setFocus(MAIN)}><Tag status={mainRow.status} word={false} /><span className="tm-nm">Main agent</span><small>{working ? `${working} working` : ""}</small></button>
                    <button type="button" className="tm-ic" aria-pressed={pins.includes(MAIN)} aria-label="Pin the main agent" onClick={() => togglePin(MAIN)}><Pin size={12} aria-hidden /></button>
                  </div>
                </li>
              ) : null}
              {rows.map((r) => r.kind === "fold" ? (
                <li key={`fold:${r.id}`} style={{ ["--d" as string]: r.depth }}>
                  <div><span className="tm-tw" /><button type="button" className="tm-row tm-foldrow" onClick={() => setFolds((s) => flip(s, r.id))}><ChevronRight size={12} aria-hidden /><span className="tm-nm">{r.label}</span></button></div>
                </li>
              ) : (
                <li key={r.agent.id} data-s={r.agent.status} style={{ ["--d" as string]: r.depth }}>
                  <div className={focus === r.agent.id ? "tm-sel" : undefined}>
                    {r.kids ? <button type="button" className="tm-tw" aria-label={r.open ? "Fold" : "Unfold"} aria-expanded={r.open} onClick={() => setShut((s) => flip(s, r.agent.id))}>{r.open ? <ChevronDown size={12} aria-hidden /> : <ChevronRight size={12} aria-hidden />}</button> : <span className="tm-tw" />}
                    <button type="button" className="tm-row" onClick={() => setFocus(r.agent.id)} title={r.agent.now || undefined}>
                      <Tag status={r.agent.status} word={false} /><span className="tm-nm">{r.agent.name}</span>
                      <small>{r.kids ? `${r.working} of ${r.kids}` : r.agent.status === "running" ? span(r.agent.started, Date.now() / 1000) : r.agent.status === "failed" ? `failed ${ago(r.agent.updated)}` : ""}</small>
                    </button>
                    <button type="button" className="tm-ic" aria-pressed={pins.includes(r.agent.id)} aria-label={`Pin ${r.agent.name}`} onClick={() => togglePin(r.agent.id)}><Pin size={12} aria-hidden /></button>
                  </div>
                </li>
              ))}
            </ul>
            {team && !agents.length ? <p className="tm-empty">This chat's agent hasn't started any agents.</p> : null}
            {team && agents.length && !rows.length && filter !== "all" ? <p className="tm-empty">None like that.</p> : null}
          </div>
        </div>
        <div className="tm-col">
          {focused ? (
            <Focus sessionId={sessionId} agent={focused} team={team!} pinned={pins.includes(focused.id)} onPin={() => togglePin(focused.id)} onBack={() => setFocus(null)}
              onFocus={setFocus} onTalk={() => talkTo(focused)} onChat={focused.id === MAIN ? onChat : undefined} />
          ) : (
            <>
              <div className="tm-bar"><b>Watching</b><small>{watched.length} pinned</small></div>
              <div className="tm-scroll">
                <div className="tm-mons">
                  {watched.map((a) => <Monitor key={a.id} sessionId={sessionId} agent={a} under={a.id === MAIN ? "" : name(a.parent)} pinned onFocus={() => setFocus(a.id)} onPin={() => togglePin(a.id)} onTalk={() => talkTo(a)} />)}
                  {watched.length < MAX_PINS ? <div className="tm-slot">Pin an agent from the list to watch it here. Up to {MAX_PINS}.</div> : null}
                </div>
              </div>
            </>
          )}
        </div>
        <div className="tm-col">
          <div className="tm-bar">
            <b>Conversation</b><span className="tm-gap" />
            <span className="tm-seg" role="group" aria-label="Show">
              {([["all", "All"], ["report", "Reports"], ["problem", "Problems"], ["you", "Mine"]] as [Talk, string][]).map(([k, label]) => <button key={k} type="button" aria-pressed={talk === k} onClick={() => setTalk(k)}>{label}</button>)}
            </span>
          </div>
          <div className="tm-scroll">
            {messages.map((m, i) => <Message key={`${m.at}:${m.from}:${i}`} m={m} name={name} onFocus={(id) => setFocus(byId.has(id) ? id : null)} />)}
            {team && !messages.length ? <p className="tm-empty">Nothing like that yet.</p> : null}
          </div>
          <div className="tm-say">
            {menu === "all" ? (
              <div className="tm-warn" role="alertdialog" aria-label="Stop everything">
                <b>Stop everything?</b> This ends the turn. {working ? `All ${working} working agents stop where they are.` : "The main agent stops."} What finished agents wrote stays in your folder. Nothing is undone, and you can ask the main agent to carry on afterwards.
                <div className="tm-rowb"><button type="button" className="tm-btn tm-danger" onClick={() => { setMenu(""); onStop(); setSaid("Stopped."); }}>Stop {working ? `all ${working}` : "it"}</button><button type="button" className="tm-btn" onClick={() => setMenu("")}>Keep going</button></div>
              </div>
            ) : null}
            <div className="tm-sayto">
              <span>To</span>
              <span className="tm-anchor">
                <button type="button" className="tm-pick" aria-haspopup="listbox" aria-expanded={menu === "to"} onClick={() => setMenu(menu === "to" ? "" : "to")}><span className="tm-who">{to.name}{to.group ? " and its helpers" : ""}</span><ChevronDown size={12} aria-hidden /></button>
                {menu === "to" ? (
                  <div className="tm-pop" role="listbox">
                    <button type="button" role="option" aria-selected={to.id === MAIN} onClick={() => { setTo({ id: MAIN, name: "Main agent" }); setMenu(""); }}><b>Main agent</b><small>it decides who needs to hear it</small></button>
                    {focused && focused.id !== MAIN ? <button type="button" role="option" aria-selected={to.id === focused.id && !to.group} onClick={() => { setTo({ id: focused.id, name: focused.name }); setMenu(""); }}><b>{focused.name}</b><small>the agent you have open</small></button> : null}
                    {lead ? <button type="button" role="option" aria-selected={to.id === lead.id && !!to.group} onClick={() => { setTo({ id: lead.id, name: lead.name, group: true }); setMenu(""); }}><b>{lead.name}</b><small>and the agents it started</small></button> : null}
                    <small className="tm-pop-n">Open an agent to send to it.</small>
                  </div>
                ) : null}
              </span>
              <span className="tm-gap" />
              <span className="tm-anchor">
                <button type="button" className="tm-quiet" aria-haspopup="menu" aria-expanded={menu === "stop"} disabled={!running} onClick={() => setMenu(menu === "stop" ? "" : "stop")}><Square size={11} aria-hidden />Stop…</button>
                {menu === "stop" ? (
                  <div className="tm-pop tm-pop-r" role="menu">
                    {focused && focused.id !== MAIN && (focused.status === "running" || focused.status === "waiting") ? <button type="button" role="menuitem" onClick={() => stopOne({ id: focused.id, name: focused.name })}><b>{focused.name}</b><small>only this agent; the others carry on</small></button> : null}
                    {lead && (lead.status === "running" || lead.status === "waiting") ? <button type="button" role="menuitem" onClick={() => stopOne({ id: lead.id, name: lead.name, group: true })}><b>{lead.name} and its helpers</b><small>the others carry on</small></button> : null}
                    <button type="button" role="menuitem" className="tm-danger" onClick={() => setMenu("all")}><b>Everything</b><small>ends the turn{working ? `; all ${working} stop` : ""}</small></button>
                    <small className="tm-pop-n">One agent is stopped by asking the main agent to, at its next step.</small>
                  </div>
                ) : null}
              </span>
            </div>
            <form className="tm-saybox" onSubmit={(e) => { e.preventDefault(); send(); }}>
              <textarea ref={box} rows={2} value={text} placeholder="A thought, a correction, a new rule" aria-label="Say something" onChange={(e) => { setText(e.target.value); setSaid(""); }}
                onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }} />
              <button type="submit" className="tm-send" aria-label="Send" disabled={!text.trim()}><ArrowRight size={16} aria-hidden /></button>
            </form>
            <p className="tm-hint" role="status">{said ? <b>{said}</b> : hint}</p>
          </div>
        </div>
      </div>
    </div>
  );
}
