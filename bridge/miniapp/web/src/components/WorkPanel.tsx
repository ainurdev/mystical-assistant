import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowDown, ArrowUp, ArrowRight, Ban, Check, ChevronLeft, CircleCheck, Circle, Eye, Inbox, LoaderCircle, Pencil, Plus, Sparkles, Trash2, TriangleAlert } from "lucide-react";
import { useRefSession, workCall, WorkPicture, workGet, workSources } from "../lib/readapi";
import { wordDiff } from "../lib/worddiff";
import { Dialog } from "./DesignSystem";

// The project's work list (bridge/worklist.py) and its run (bridge/workrun.py). Same file in both apps.
//
// Every card says its state in words, with an icon and a colored edge, since "what's this doing?" is
// what the panel is for. Refining, editing and adding each take over the panel rather than expand in it:
// you always know which mode you're in, and the list never gets pushed around. It also keeps one scroller,
// the panel's: WebKitGTK, the Linux window's engine, holds a wheel gesture on a box that scrolls, even at
// its end, so a box that scrolls inside a list leaves the list stuck under the pointer (fitBox).

type Source = { kind?: string; ref?: string; url?: string } | null;
type Message = { role: "user" | "agent" | "error"; text: string; options?: string[]; proposal?: { title: string; detail: string }; used?: boolean };
type Item = {
  id: string; title: string; detail: string; source: Source; depends_on: string[]; state: string; note: string; group: string;
  helper?: string; session_id?: string; refining?: boolean; refine?: { messages: Message[] };
  report?: string; summary?: string; decisions?: string[]; unverified?: string[]; commit?: string | null;
  evidence?: { dir: string; files: number; pictures: string[] };
};
type Check = { state: "running" | "done" | "failed"; command?: string; ok?: boolean; new?: string[]; same?: number; passed?: number | null; failed?: number | null; failures?: string[]; code?: number; log?: string };
type Run = {
  id: string; chat: string; chat_title: string; state: "running" | "paused" | "finished"; branch: string; into: string; parallel: number;
  summary?: string; paused_why?: string; dirty?: boolean; items: string[]; merged: number;
  baseline?: Check; check?: Check; leftovers?: { path: string; why: string }[];
};
type Listing = { items: Item[]; project: string; runs?: Run[] };
type Screen = { k: "list" } | { k: "refine"; id: string } | { k: "edit"; id: string } | { k: "add"; tab: "write" | "bring" } | { k: "land"; run: string };
type Call = (path: string, body: Record<string, unknown>) => Promise<boolean>;

const ICON = { size: 13, strokeWidth: 2, "aria-hidden": true } as const;
const STATE: Record<string, { label: string; icon: ReactNode }> = {
  blocked: { label: "Needs you", icon: <TriangleAlert {...ICON} /> },
  doing: { label: "Working", icon: <LoaderCircle {...ICON} /> },
  review: { label: "In review", icon: <Eye {...ICON} /> },
  todo: { label: "Not started", icon: <Circle {...ICON} /> },
  done: { label: "Done", icon: <CircleCheck {...ICON} /> },
  dropped: { label: "Dropped", icon: <Ban {...ICON} /> },
};
const ORDER = ["blocked", "doing", "review", "todo", "done", "dropped"];
const GROUP_ORDER = ["blocked", "doing", "review", "next", "later", "here"];
const errorOf = (e: unknown) => (e instanceof Error ? e.message : "That didn't work.");

/** As tall as its text, so it never scrolls. */
const fitBox = (el: HTMLTextAreaElement | null) => {
  if (!el) return;
  el.style.height = "auto";
  el.style.height = `${el.scrollHeight + 2}px`;
};

const StateTag = ({ state, count }: { state: string; count?: number }) => (
  <span className="wl-st" data-s={state}>{STATE[state]?.icon}{count ?? STATE[state]?.label ?? state}</span>
);

function Head({ title, onBack }: { title: string; onBack: () => void }) {
  return <div className="wl-sheet-h"><button type="button" className="wl-ic" aria-label="Back to the list" onClick={onBack}><ChevronLeft size={16} aria-hidden /></button><b>{title}</b></div>;
}

/** What the finished branch's checks found, against where it started. */
function checkWords(c?: Check): { tone: "ok" | "warn" | "wait"; text: string } | null {
  if (!c) return null;
  if (c.state === "running") return { tone: "wait", text: "Running the checks on the whole branch…" };
  if (c.state === "failed") return { tone: "warn", text: "The checks couldn't finish, so this branch is unchecked." };
  const n = [c.passed != null ? `${c.passed} passed` : "", c.failed ? `${c.failed} failed` : ""].filter(Boolean).join(", ");
  if (c.ok) return { tone: "ok", text: `Checks: ${n || "passed"}${c.same ? `. The same ${c.same} failed where the run started, so none are new.` : "."}` };
  if (c.new?.length) return { tone: "warn", text: `Checks: ${n}. New failures: ${c.new.slice(0, 5).join(", ")}${c.new.length > 5 ? ` and ${c.new.length - 5} more` : ""}.` };
  return { tone: "warn", text: `The checks failed with exit code ${c.code}, and their output couldn't be read.${c.log ? ` See ${c.log}.` : ""}` };
}

function Evidence({ item, session }: { item: Item; session: string | null }) {
  const e = item.evidence;
  if (!e) return null;
  return (
    <div className="wl-ev">
      <small>{e.files} file{e.files === 1 ? "" : "s"} kept in {e.dir}</small>
      {e.pictures.length ? <div className="wl-pics">{e.pictures.map((p) => <WorkPicture key={p} session={session} path={p} alt={`From ${item.id}: ${p.split("/").pop()}`} />)}</div> : null}
    </div>
  );
}

/** What a helper said you'd want to know: decisions, what it couldn't check, then the whole reply. */
function Report({ item, session }: { item: Item; session: string | null }) {
  if (!item.report) return <Evidence item={item} session={session} />;
  return (
    <div className="wl-report">
      {item.decisions?.length ? <div><h6>Decisions to check</h6><ul>{item.decisions.map((d, i) => <li key={i}>{d}</li>)}</ul></div> : null}
      {item.unverified?.length ? <div data-warn=""><h6>Not verified</h6><ul>{item.unverified.map((d, i) => <li key={i}>{d}</li>)}</ul></div> : null}
      <Evidence item={item} session={session} />
      <details className="wl-full"><summary>The helper's full report</summary><p>{item.report}</p></details>
    </div>
  );
}

function Land({ run, items, session, onRun, onOpen, back }: { run: Run; items: Item[]; session: string | null; onRun: (path: string) => void; onOpen?: (id: string) => void; back: () => void }) {
  const inRun = items.filter((i) => run.items.includes(i.id));
  const done = inRun.filter((i) => i.state === "done");
  const rest = inRun.filter((i) => i.state !== "done");
  const check = checkWords(run.check);
  const bad = check?.tone === "warn";
  return (
    <div className="wl-sheet">
      <Head title={`Merge into ${run.into || "your branch"}`} onBack={back} />
      <div className="wl-sheet-b">
        <p className="wl-lede">From <span className="wl-branch">{run.branch}</span>. Merging is local, and nothing is pushed. Uncommitted work in your folder is left alone: git refuses rather than touch it.</p>
        {check ? <p className={`wl-check wl-${check.tone}`} role="status">{check.text}</p> : <p className="wl-check wl-warn">No check command is set for this project, so nothing checked the whole branch.</p>}
        {done.map((i) => (
          <div key={i.id} className="wl-land" data-s="done">
            <StateTag state="done" />
            <b>{i.title}</b>
            <small>{i.id}{i.session_id && onOpen ? <> · <button type="button" className="au-link" onClick={() => onOpen(i.session_id!)}>open its chat</button></> : null}</small>
            {i.summary ? <p>{i.summary}</p> : null}
            <Report item={i} session={session} />
          </div>
        ))}
        {rest.length ? <div className="wl-land-rest"><h6>Not in this merge</h6><ul>{rest.map((i) => <li key={i.id}>{i.id}: {i.title} ({STATE[i.state]?.label ?? i.state})</li>)}</ul></div> : null}
      </div>
      <div className="wl-sheet-f wl-row">
        <button type="button" className="dg-send wl-grow" disabled={!run.merged} onClick={() => { onRun("land"); back(); }}>{bad ? "Merge anyway" : `Merge ${done.length} task${done.length === 1 ? "" : "s"}`}</button>
        <button type="button" className="dg-btn" onClick={back}>Not yet</button>
      </div>
    </div>
  );
}

function RunCard({ run, session, onRun, onOpen, onLand }: { run: Run; session: string | null; onRun: (path: string) => void; onOpen?: (id: string) => void; onLand: () => void }) {
  const [sure, setSure] = useState(false);
  const check = checkWords(run.check);
  const here = run.chat === session;
  const n = `${run.merged} of ${run.items.length} merged`;
  return (
    <section className="wl-run" data-state={run.state} aria-live="polite">
      <div><b>{run.state === "running" ? "Run going" : run.state === "paused" ? "Run paused" : "Run finished"}</b> · {n}</div>
      <small className="wl-branch">{run.branch}{run.state !== "finished" ? ` · up to ${run.parallel} at once` : ""}</small>
      {run.state !== "finished" && !here ? <small>Managed in {onOpen ? <button type="button" className="au-link" onClick={() => onOpen(run.chat)}>{run.chat_title || "another chat"}</button> : run.chat_title || "another chat"}</small> : null}
      {run.paused_why ? <small className="wl-warn">{run.paused_why}</small> : null}
      {run.summary ? (run.summary.length > 200
        ? <details className="wl-more"><summary>{run.summary.slice(0, 160).trimEnd()}…</summary><small>{run.summary}</small></details>
        : <small>{run.summary}</small>) : null}
      {run.baseline?.state === "running" ? <small>Checking the starting point before the helpers begin…</small> : null}
      {check ? <small className={check.tone === "warn" ? "wl-warn" : undefined}>{check.text}</small> : null}
      {run.state === "finished" ? <small>Your branch hasn't moved. Merging is local, and nothing is pushed.</small> : null}
      {run.leftovers?.map((l) => <small key={l.path} className="wl-warn">Left behind: {l.path}. {l.why}</small>)}
      <div className="wl-row">
        {run.state === "running" ? <button type="button" className="dg-btn" onClick={() => onRun("pause")}>Pause</button> : null}
        {run.state === "paused" ? <button type="button" className="dg-send" disabled={!session} onClick={() => onRun("resume")}>{here ? "Resume" : "Take over here"}</button> : null}
        {run.state !== "finished" ? <button type="button" className="dg-btn" onClick={() => onRun("stop")}>Stop helpers</button> : null}
        {run.state === "paused" ? <button type="button" className="dg-btn" onClick={() => onRun("end")}>End the run</button> : null}
        {run.state === "finished" ? <button type="button" className="dg-send" disabled={!run.merged} onClick={onLand}>Review and merge</button> : null}
        {run.state === "finished" ? (sure
          ? <button type="button" className="dg-btn dg-danger" onClick={() => onRun("discard")}>Really discard the code</button>
          : <button type="button" className="dg-btn" onClick={() => setSure(true)}>Discard</button>) : null}
      </div>
    </section>
  );
}

function Starter({ items, onStart, onClose }: { items: Item[]; onStart: (ids: string[], parallel: number) => void; onClose: () => void }) {
  const [picked, setPicked] = useState(() => new Set(items.map((i) => i.id)));
  const [parallel, setParallel] = useState(2);
  const toggle = (id: string) => setPicked((p) => { const n = new Set(p); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  return (
    <Dialog title="Run the work list" onClose={onClose}>
      <div className="au-form">
        <p className="dg-empty">This chat's agent manages it. Each task gets a helper in its own worktree, and finished ones merge into a new branch from your last commit. Your branch doesn't move until you merge it, and uncommitted changes in your folder stay out.</p>
        <fieldset className="wl-pick">
          <legend>Tasks</legend>
          {items.map((i) => <label key={i.id}><input type="checkbox" checked={picked.has(i.id)} onChange={() => toggle(i.id)} /> <span>{i.title}</span></label>)}
        </fieldset>
        <div className="ds-f"><span>Helpers at once</span>
          <div className="ds-chips" role="radiogroup" aria-label="Helpers at once">
            {[1, 2, 3, 4, 5].map((n) => <button key={n} type="button" role="radio" aria-checked={parallel === n} className="dg-chip" onClick={() => setParallel(n)}>{n}</button>)}
          </div>
          <small className="au-hint">More is faster and uses your limits faster. Helpers can't go above this chat's permission level, and anything needing approval asks you.</small>
        </div>
        <div className="ds-do au-save">
          <button type="button" className="dg-send" disabled={!picked.size} onClick={() => onStart(items.filter((i) => picked.has(i.id)).map((i) => i.id), parallel)}>Start {picked.size} task{picked.size === 1 ? "" : "s"}</button>
          <button type="button" className="dg-btn" onClick={onClose}>Cancel</button>
        </div>
      </div>
    </Dialog>
  );
}

function Card({ item, session, canUp, canDown, activeRun, onOpen, call, go, onMove }: {
  item: Item; session: string | null; canUp: boolean; canDown: boolean; activeRun?: Run; onOpen?: (id: string) => void; call: Call; go: (s: Screen) => void; onMove: (up: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const [sure, setSure] = useState(false);
  const [answering, setAnswering] = useState(false);
  const [answer, setAnswer] = useState("");
  const todo = item.state === "todo";
  const live = item.state === "doing" || item.state === "review";
  const inRun = !!activeRun?.items.includes(item.id);
  const source = item.source;
  const talked = !!item.refine?.messages.length;
  const sendAnswer = async () => {
    if (await call("run/answer", { run: activeRun?.id, id: item.id, text: answer })) { setAnswer(""); setAnswering(false); }
  };
  return (
    <li className="wl-card" data-s={item.state}>
      <div className="wl-ch">
        <StateTag state={item.state} />
        {todo ? (
          <span className="wl-ord">
            <button type="button" className="wl-ic" aria-label={`Move ${item.title} up`} title="Move up" disabled={!canUp} onClick={() => onMove(true)}><ArrowUp size={14} aria-hidden /></button>
            <button type="button" className="wl-ic" aria-label={`Move ${item.title} down`} title="Move down" disabled={!canDown} onClick={() => onMove(false)}><ArrowDown size={14} aria-hidden /></button>
          </span>
        ) : null}
      </div>
      <button type="button" className="wl-title" aria-expanded={open} onClick={() => setOpen((v) => !v)}>{item.title}</button>
      {item.note ? <small className={item.state === "blocked" ? "wl-warn" : undefined}>{item.note}</small> : null}
      <small>
        {item.id}
        {item.group === "later" ? " · not in this run" : ""}
        {item.depends_on.length ? ` · after ${item.depends_on.join(", ")}` : ""}
        {item.session_id && onOpen ? <> · <button type="button" className="au-link" onClick={() => onOpen(item.session_id!)}>open its chat</button></> : null}
      </small>
      {source?.url || source?.ref ? <small>{source.url ? <a className="au-link" href={source.url} target="_blank" rel="noreferrer">{source.kind ? `${source.kind} ` : ""}{source.ref || source.url}</a> : `${source.kind ? `${source.kind} ` : ""}${source.ref}`}</small> : null}
      {item.state === "blocked" && inRun && !open ? <div className="wl-row"><button type="button" className="dg-btn" onClick={() => { setOpen(true); setAnswering(true); }}>Answer</button></div> : null}
      {open ? (
        <>
          {item.summary ? <p className="wl-detail wl-said">{item.summary}</p> : null}
          {item.detail ? <p className="wl-detail">{item.detail}</p> : null}
          <Report item={item} session={session} />
          {answering ? (
            <form onSubmit={(e) => { e.preventDefault(); void sendAnswer(); }}>
              <label className="wl-f"><span>What it needs to know</span><textarea ref={fitBox} rows={2} autoFocus value={answer} onChange={(e) => { setAnswer(e.target.value); fitBox(e.target); }} /></label>
              <div className="wl-row"><button type="submit" className="dg-send" disabled={!answer.trim()}>Send</button><button type="button" className="dg-btn" onClick={() => setAnswering(false)}>Cancel</button></div>
            </form>
          ) : (
            <div className="wl-row">
              {todo ? <button type="button" className="dg-send wl-i" onClick={() => go({ k: "refine", id: item.id })}><Sparkles size={13} aria-hidden />{talked ? "Keep refining" : "Refine"}</button> : null}
              {item.state === "blocked" && inRun ? <button type="button" className="dg-send" onClick={() => setAnswering(true)}>Answer</button> : null}
              <button type="button" className="dg-btn wl-i" onClick={() => go({ k: "edit", id: item.id })}><Pencil size={13} aria-hidden />Edit</button>
              {item.state === "done" || item.state === "dropped" || (item.state === "blocked" && !inRun) ? <button type="button" className="dg-btn" onClick={() => void call("update", { items: [{ id: item.id, state: "todo" }] })}>Back to the list</button> : null}
              <span className="wl-gap" />
              {!live && item.state !== "done" ? <button type="button" className="wl-ic" aria-label={`Mark ${item.title} done`} title="Mark done" onClick={() => void call("update", { items: [{ id: item.id, state: "done" }] })}><Check size={15} aria-hidden /></button> : null}
              {!live ? (sure
                ? <button type="button" className="dg-btn dg-danger" onClick={() => void call("remove", { ids: [item.id] })}>Really delete</button>
                : <button type="button" className="wl-ic" aria-label={`Delete ${item.title}`} title="Delete" onClick={() => setSure(true)}><Trash2 size={14} aria-hidden /></button>) : null}
            </div>
          )}
        </>
      ) : null}
    </li>
  );
}

function Diff({ before, after }: { before: string; after: string }) {
  return <>{wordDiff(before, after).map((p, i) => (p.kind === "add" ? <ins key={i}>{p.text}</ins> : p.kind === "del" ? <del key={i}>{p.text}</del> : <span key={i}>{p.text}</span>))}</>;
}

function Refine({ item, call, back }: { item: Item; call: Call; back: () => void }) {
  const [text, setText] = useState("");
  const [talking, setTalking] = useState(false);
  const box = useRef<HTMLTextAreaElement>(null);
  const end = useRef<HTMLDivElement>(null);
  const messages = item.refine?.messages ?? [];
  useEffect(() => { end.current?.scrollIntoView({ block: "nearest" }); }, [messages.length, item.refining]);
  const send = async (words: string) => {
    if (!words.trim() || item.refining) return;
    setTalking(false);
    if (await call("refine/send", { id: item.id, text: words })) { setText(""); if (box.current) { box.current.style.height = "auto"; } }
  };
  const lastAt = messages.length - 1;
  return (
    <div className="wl-sheet">
      <Head title={`Refine ${item.id}`} onBack={back} />
      <div className="wl-sheet-b">
        <div className="wl-was"><b>{item.title}</b>{item.detail ? <p>{item.detail}</p> : null}</div>
        {!messages.length ? <p className="wl-lede">Give an idea, correct something or ask a question. The agent can read the project, and the task only changes when you use a suggestion.</p> : null}
        {messages.map((m, i) => (
          <div key={i}>
            {m.role === "user" ? <p className="wl-me">{m.text}</p> : null}
            {m.role === "agent" && m.text ? <p className="wl-agent">{m.text}</p> : null}
            {m.role === "error" ? <p className="wl-warn wl-agent" role="alert">{m.text}</p> : null}
            {m.options?.length && i === lastAt && !item.refining ? <div className="wl-row wl-opts">{m.options.map((o) => <button key={o} type="button" className="dg-btn" onClick={() => void send(o)}>{o}</button>)}</div> : null}
            {m.proposal ? (
              <div className="wl-prop" data-used={m.used || undefined}>
                <h6>{m.used ? "Used" : "Suggested change"}</h6>
                {m.proposal.title !== item.title && !m.used ? <p className="wl-prop-t"><Diff before={item.title} after={m.proposal.title} /></p> : <p className="wl-prop-t">{m.proposal.title}</p>}
                {m.used ? <p>{m.proposal.detail}</p> : <p><Diff before={item.detail} after={m.proposal.detail} /></p>}
                {!m.used && i === lastAt && !talking ? (
                  <div className="wl-row">
                    <button type="button" className="dg-send" onClick={() => void call("refine/accept", { id: item.id, at: i })}>Use this</button>
                    <button type="button" className="dg-btn" onClick={() => { setTalking(true); box.current?.focus(); }}>Keep talking</button>
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>
        ))}
        {item.refining ? <p className="wl-think" role="status"><LoaderCircle size={13} aria-hidden />Reading the project and thinking…</p> : null}
        <div ref={end} className="wl-end" />
      </div>
      <form className="wl-sheet-f" onSubmit={(e) => { e.preventDefault(); void send(text); }}>
        <label className="wl-f"><span>Your idea, a correction, a question</span>
          <textarea ref={(el) => { box.current = el; fitBox(el); }} rows={2} value={text} placeholder="For example: only for PRs I opened"
            onChange={(e) => { setText(e.target.value); fitBox(e.target); }}
            onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void send(text); } }} />
        </label>
        <div className="wl-row">
          <button type="submit" className="dg-send wl-i" disabled={!text.trim() || item.refining}><ArrowRight size={13} aria-hidden />Send</button>
          <button type="button" className="dg-btn" onClick={back}>Done</button>
        </div>
      </form>
    </div>
  );
}

function After({ items, self, value, onChange }: { items: Item[]; self?: string; value: string[]; onChange: (v: string[]) => void }) {
  const others = items.filter((i) => i.id !== self && i.state !== "dropped" && (i.state !== "done" || value.includes(i.id)));
  if (!others.length) return null;
  return (
    <div className="wl-f"><span>Do this after <em>optional</em></span>
      <div className="wl-row wl-after">
        {others.map((i) => {
          const on = value.includes(i.id);
          return <button key={i.id} type="button" role="checkbox" aria-checked={on} className="dg-chip" title={i.title} onClick={() => onChange(on ? value.filter((x) => x !== i.id) : [...value, i.id])}>{i.id} · {i.title}</button>;
        })}
      </div>
    </div>
  );
}

function Edit({ item, items, call, back }: { item: Item; items: Item[]; call: Call; back: () => void }) {
  const [title, setTitle] = useState(item.title);
  const [detail, setDetail] = useState(item.detail);
  const [deps, setDeps] = useState(item.depends_on);
  return (
    <form className="wl-sheet" onSubmit={async (e) => { e.preventDefault(); if (await call("update", { items: [{ id: item.id, title, detail, depends_on: deps }] })) back(); }}>
      <div className="wl-editing"><Pencil size={14} aria-hidden /><b>Editing {item.id}</b><span>Not saved yet</span></div>
      <div className="wl-sheet-b">
        <label className="wl-f"><span>Title</span><input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} /></label>
        <label className="wl-f"><span>Details</span><textarea ref={fitBox} rows={4} value={detail} placeholder="Anything a helper would need to know" onChange={(e) => { setDetail(e.target.value); fitBox(e.target); }} /></label>
        <After items={items} self={item.id} value={deps} onChange={setDeps} />
      </div>
      <div className="wl-sheet-f wl-row">
        <button type="submit" className="dg-send wl-grow" disabled={!title.trim()}>Save</button>
        <button type="button" className="dg-btn" onClick={back}>Cancel</button>
      </div>
    </form>
  );
}

function Add({ tab, items, session, call, onAsk, back, setTab }: { tab: "write" | "bring"; items: Item[]; session: string | null; call: Call; onAsk?: (text: string) => void; back: () => void; setTab: (t: "write" | "bring") => void }) {
  const [title, setTitle] = useState("");
  const [detail, setDetail] = useState("");
  const [deps, setDeps] = useState<string[]>([]);
  const [from, setFrom] = useState("");
  const [sources, setSources] = useState<string[]>([]);
  const [what, setWhat] = useState("");
  useEffect(() => {
    workSources(session).then((s) => { setSources(s); setFrom((f) => f || s[0] || ""); }, () => setSources(["My notes"]));
  }, [session]);
  const notes = from === "My notes";
  const ask = () => {
    onAsk?.(`Update the work list with work_list, adding tasks ${notes ? "from these notes of mine" : `from ${from}`}. Keep what's already on it. ${what.trim()}`);
    back();
  };
  return (
    <form className="wl-sheet" onSubmit={async (e) => {
      e.preventDefault();
      if (tab === "bring") { if (what.trim() || !notes) ask(); return; }
      if (await call("add", { items: [{ title, detail, depends_on: deps }] })) back();
    }}>
      <Head title="Add to the list" onBack={back} />
      <div className="wl-sheet-b">
        <div className="wl-tabs" role="tablist">
          <button type="button" role="tab" aria-selected={tab === "write"} onClick={() => setTab("write")}>Write one</button>
          <button type="button" role="tab" aria-selected={tab === "bring"} onClick={() => setTab("bring")}>Bring in many</button>
        </div>
        {tab === "write" ? (
          <>
            <label className="wl-f"><span>Title</span><input autoFocus value={title} placeholder="What needs doing" onChange={(e) => setTitle(e.target.value)} /></label>
            <label className="wl-f"><span>Details <em>optional</em></span><textarea ref={fitBox} rows={4} value={detail} placeholder="Anything a helper would need to know" onChange={(e) => { setDetail(e.target.value); fitBox(e.target); }} /></label>
            <After items={items} value={deps} onChange={setDeps} />
          </>
        ) : (
          <>
            <p className="wl-lede">This chat's agent reads the source with the tools it has and adds the tasks. Anything already on the list keeps its state.</p>
            <div className="wl-f"><span>From</span>
              <div className="wl-row" role="radiogroup" aria-label="From">
                {sources.map((s) => <button key={s} type="button" role="radio" aria-checked={from === s} className="dg-chip" onClick={() => setFrom(s)}>{s}</button>)}
              </div>
            </div>
            <label className="wl-f"><span>{notes ? "Paste your notes" : "Which tasks"}</span><textarea ref={fitBox} rows={5} value={what} placeholder={notes ? "One task a line, or however you wrote them" : "Open issues tagged backend"} onChange={(e) => { setWhat(e.target.value); fitBox(e.target); }} /></label>
            {!session ? <p className="wl-warn wl-lede">Open a chat first: its agent does this.</p> : null}
          </>
        )}
      </div>
      <div className="wl-sheet-f wl-row">
        {tab === "write"
          ? <button type="submit" className="dg-send wl-grow" disabled={!title.trim()}>Add to list</button>
          : <button type="submit" className="dg-send wl-grow" disabled={!session || !onAsk || (notes && !what.trim())}>Ask the agent</button>}
        <button type="button" className="dg-btn" onClick={back}>Cancel</button>
      </div>
    </form>
  );
}

export function WorkPanel({ project, chat, onAsk, onOpen }: { project?: string | null; chat?: string | null; onAsk?: (text: string) => void; onOpen?: (sessionId: string) => void }) {
  // The dashboard's rail sits outside the chat's scope, so it says which chat; the Mini App's page reads it.
  const scoped = useRefSession();
  const session = chat ?? scoped;
  const [data, setData] = useState<Listing | null>(null);
  const [error, setError] = useState("");
  const [screen, setScreen] = useState<Screen>({ k: "list" });
  const [starting, setStarting] = useState(false);
  const load = useCallback(() => {
    workGet<Listing>(session, project).then((r) => { setData(r); setError(""); }, (e) => setError(errorOf(e)));
  }, [session, project]);
  const fast = screen.k === "refine";
  useEffect(() => {
    load();
    const t = window.setInterval(load, fast ? 1500 : 3000);
    return () => window.clearInterval(t);
  }, [load, fast]);
  const call: Call = async (path, body) => {
    try {
      const r = await workCall<Listing>(path, session, project, body);
      setData(r);
      setError("");
      return true;
    } catch (e) {
      setError(errorOf(e));
      return false;
    }
  };
  const items = data?.items ?? [];
  const runs = data?.runs ?? [];
  const activeRun = runs.find((r) => r.state !== "finished");
  const upNext = items.filter((i) => i.group === "next");
  const back = () => setScreen({ k: "list" });
  const failed = error ? <p className="ds-err wl-err" role="alert">{error}</p> : null;

  if (screen.k === "refine" || screen.k === "edit") {
    const item = items.find((i) => i.id === screen.id);
    if (item) return (
      <div className="ds wl" data-sheet="">
        {failed}
        {screen.k === "refine" ? <Refine item={item} call={call} back={back} /> : <Edit key={item.id} item={item} items={items} call={call} back={back} />}
      </div>
    );
  }
  if (screen.k === "land") {
    const run = runs.find((r) => r.id === screen.run);
    if (run) return (
      <div className="ds wl" data-sheet="">
        {failed}
        <Land run={run} items={items} session={session} onOpen={onOpen} back={back} onRun={(path) => void call(`run/${path}`, { run: run.id })} />
      </div>
    );
  }
  if (screen.k === "add") return (
    <div className="ds wl" data-sheet="">
      {failed}
      <Add tab={screen.tab} items={items} session={session} call={call} onAsk={onAsk} back={back} setTab={(tab) => setScreen({ k: "add", tab })} />
    </div>
  );

  const shown = items.filter((i) => GROUP_ORDER.includes(i.group)).sort((a, b) => GROUP_ORDER.indexOf(a.group) - GROUP_ORDER.indexOf(b.group));
  const earlier = items.filter((i) => !GROUP_ORDER.includes(i.group));
  const todoIds = items.filter((i) => i.state === "todo").map((i) => i.id);
  const move = (item: Item, up: boolean) => {
    const at = todoIds.indexOf(item.id), to = at + (up ? -1 : 1);
    if (at < 0 || to < 0 || to >= todoIds.length) return;
    const next = [...todoIds];
    [next[at], next[to]] = [next[to], next[at]];
    void call("reorder", { ids: next });
  };
  const card = (i: Item) => {
    const at = todoIds.indexOf(i.id);
    return <Card key={i.id} item={i} session={session} canUp={at > 0} canDown={at >= 0 && at < todoIds.length - 1} activeRun={activeRun} onOpen={onOpen} call={call} go={setScreen} onMove={(up) => move(i, up)} />;
  };
  const counts = ORDER.map((s) => [s, items.filter((i) => i.state === s).length] as const).filter(([, n]) => n);
  return (
    <div className="ds wl">
      <div className="wl-top">
        <b>Work list{data ? <span> · {data.project}</span> : null}</b>
        {!activeRun && upNext.length ? <button type="button" className="dg-send" disabled={!session} title={session ? undefined : "Open a chat: its agent manages the run"} onClick={() => setStarting(true)}>Run</button> : null}
      </div>
      {failed}
      {runs.map((r) => <RunCard key={r.id} run={r} session={session} onOpen={onOpen} onLand={() => setScreen({ k: "land", run: r.id })} onRun={(path) => void call(`run/${path}`, { run: r.id })} />)}
      {counts.length ? (
        <div className="wl-sum">
          <div className="wl-bar" aria-hidden>{counts.map(([s, n]) => <i key={s} data-s={s} style={{ flex: n }} />)}</div>
          <div className="wl-leg" role="group" aria-label="Tasks by state">{counts.map(([s, n]) => <span key={s} title={STATE[s].label} aria-label={`${n} ${STATE[s].label}`}><StateTag state={s} count={n} /></span>)}</div>
        </div>
      ) : null}
      <div className="wl-body">
        {data && !items.length ? <p className="dg-empty">Nothing yet. Add tasks yourself, or ask an agent to bring them in from a tracker or your notes. Agents only change this list when you ask.</p> : null}
        <ul className="wl-cards">{shown.map(card)}</ul>
        {earlier.length ? (
          <details className="wl-earlier"><summary>Earlier · {earlier.length}</summary><ul className="wl-cards">{earlier.map(card)}</ul></details>
        ) : null}
      </div>
      <div className="wl-dock">
        <button type="button" className="dg-btn wl-i" onClick={() => setScreen({ k: "add", tab: "write" })}><Plus size={14} aria-hidden />New task</button>
        <button type="button" className="dg-btn wl-i" onClick={() => setScreen({ k: "add", tab: "bring" })}><Inbox size={14} aria-hidden />Bring in</button>
      </div>
      {starting ? <Starter items={upNext} onClose={() => setStarting(false)} onStart={(ids, parallel) => { setStarting(false); void call("run/start", { ids, parallel }); }} /> : null}
    </div>
  );
}
