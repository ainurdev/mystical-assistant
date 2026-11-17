import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowDown, ArrowUp, ArrowRight, Check, ChevronDown, ChevronLeft, ChevronRight, Ellipsis, Inbox, ListPlus, LoaderCircle, MessageSquare, Pencil, Plus, SkipForward, Sparkles, Trash2, X } from "lucide-react";
import { useRefSession, workCall, workGet, workSources } from "../lib/readapi";
import { wordDiff } from "../lib/worddiff";
import { Markdown } from "./Markdown";

// The project's work: tasks (bridge/worklist.py), each built by a flow in a session of its own, in
// parts. Same file in both apps.
//
// One row per task, grouped by what it needs from you: Needs you, Building, Up next, Done (folded).
// Line 1 is a dot, the title and a bar per part; line 2 what it does now, or the question a part asks
// in amber with Answer. A started row opens its session; ▸ Start opens under an Up next row, where the
// flow and the branch are picked before anything starts (decided 2026-11-17, design A · Rows in
// .mystical/design-drafts/work-tickets). Refining, editing and adding each take over the panel rather
// than expand in it: you always know which mode you're in, and the list never gets pushed around. It
// also keeps one scroller, the panel's: WebKitGTK, the Linux window's engine, holds a wheel gesture on
// a box that scrolls, even at its end, so a box that scrolls inside a list leaves the list stuck under
// the pointer (fitBox).

type Source = { kind?: string; ref?: string; url?: string } | null;
type Message = { role: "user" | "agent" | "error"; text: string; options?: string[]; proposal?: { title: string; detail: string }; used?: boolean };
type Part = { n: string; title: string; status: string; session_id: string };
type Flow = "build" | "fix" | "design";
type Item = {
  id: string; title: string; detail: string; source: Source; depends_on: string[]; state: string; note: string; group: string;
  session_id?: string; refining?: boolean; refine?: { messages: Message[] };
  kind?: Flow; branch?: string; armed?: boolean; now?: string; parts?: Part[]; sessions?: string[];
};
/** A question waiting on you (the dashboard's Needs you list): its session, and what it asks. */
export type Asking = { subject: string; body: string };
type PlanStatus = "pending" | "in_progress" | "completed" | "skipped";
type PlanStep = { id: string; title: string; status: PlanStatus; detail?: string; note?: string; substeps?: { title: string; status: PlanStatus }[]; started_at?: number; done_at?: number };
type Plan = { steps: PlanStep[]; pending: { at: number; step: string; summary: string }[]; source: string; started?: number | null; updated?: number | null };
type Listing = { items: Item[]; project: string; plan?: Plan | null };
type Screen = { k: "plan-change"; step: string } | { k: "plan-ask"; step: string } | { k: "plan-whole" } | { k: "list" } | { k: "refine"; id: string } | { k: "edit"; id: string } | { k: "add"; tab: "write" | "bring" };
type Call = (path: string, body: Record<string, unknown>) => Promise<boolean>;

const STATE: Record<string, { label: string }> = {
  blocked: { label: "Needs you" }, doing: { label: "Working" }, review: { label: "In review" },
  todo: { label: "Not started" }, done: { label: "Done" }, dropped: { label: "Dropped" },
};
const GROUPS = [["needs", "Needs you"], ["building", "Building"], ["next", "Up next"], ["done", "Done"]] as const;
const errorOf = (e: unknown) => (e instanceof Error ? e.message : "That didn't work.");

/** As tall as its text, so it never scrolls. */
const fitBox = (el: HTMLTextAreaElement | null) => {
  if (!el) return;
  el.style.height = "auto";
  el.style.height = `${el.scrollHeight + 2}px`;
};

function Head({ title, onBack }: { title: string; onBack: () => void }) {
  return <div className="wl-sheet-h"><button type="button" className="wl-ic" aria-label="Back to the list" onClick={onBack}><ChevronLeft size={16} aria-hidden /></button><b>{title}</b></div>;
}

// ------- a task's row -----------------------------------------------------------------------

const FLOWS: { id: Flow; label: string; type: string; what: string }[] = [
  { id: "build", label: "Build", type: "feat", what: "Grills the plan, then splits it into parts. One part starts at once; more wait for your approval." },
  { id: "fix", label: "Fix", type: "fix", what: "Finds the cause and fixes it, then reviews the fix." },
  { id: "design", label: "Design", type: "feat", what: "Grills, then draws it for your approval before any part is built." },
];
// shortcut: a smaller copy of lib/kinds.ts's FIX and DESIGN rules, as the Mini App has no kinds.ts; a wrong guess costs one tap.
const guessFlow = (t: string): Flow =>
  /\b(bug|broken|fix|fail\w*|error|crash\w*|wrong|missing|twice|not working|doesn'?t work|can'?t|won'?t)\b/i.test(t) ? "fix"
    : /\b(re-?design|mock-?ups?|look and feel|restyle|layout)\b/i.test(t) ? "design" : "build";
// shortcut: the bridge's title_slug in short (no check-ref-format); the branch the session gets is the bridge's, and says so after.
const slug = (t: string) => {
  const s = t.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return (s.length > 40 ? s.slice(0, 41).replace(/-[^-]*$/, "") : s) || "task";
};

function Meter({ parts }: { parts: Part[] }) {
  const done = parts.filter((p) => p.status === "done").length;
  return (
    <>
      <span className="wl-m" aria-hidden>{parts.map((p) => <b key={p.n} data-p={p.status === "done" ? "ok" : p.status === "running" ? "run" : p.status === "fix" || p.status === "missing" ? "ask" : undefined} />)}</span>
      <span className="wl-n" aria-label={`${done} of ${parts.length} parts done`}>{done}/{parts.length}</span>
    </>
  );
}

function Start({ item, items, call, close }: { item: Item; items: Item[]; call: Call; close: () => void }) {
  const [kind, setKind] = useState<Flow>(() => item.kind ?? guessFlow(`${item.title} ${item.detail}`));
  const f = FLOWS.find((x) => x.id === kind)!;
  const waits = item.depends_on.filter((d) => items.find((i) => i.id === d)?.state !== "done");
  return (
    <div className="wl-start">
      <div className="wl-seg" role="radiogroup" aria-label="Flow">
        {FLOWS.map((x) => <button key={x.id} type="button" role="radio" aria-checked={kind === x.id} onClick={() => setKind(x.id)}>{x.label}</button>)}
      </div>
      <p className="wl-lede">New session on <b className="wl-branch">{f.type}/{slug(item.title)}</b>. {f.what}{waits.length ? ` It starts when ${waits.join(", ")} ${waits.length === 1 ? "is" : "are"} done.` : ""}</p>
      <div className="wl-row">
        <button type="button" className="dg-send wl-grow" onClick={async () => { if (await call("start", { id: item.id, kind })) close(); }}>{waits.length ? "Start after" : "Start"} {f.label.toLowerCase()}</button>
        <button type="button" className="dg-btn" onClick={close}>Cancel</button>
      </div>
    </div>
  );
}

function Row({ item, group, ask, items, canUp, canDown, onOpen, call, go, onMove }: {
  item: Item; group: string; ask?: Asking; items: Item[]; canUp: boolean; canDown: boolean; onOpen?: (id: string) => void; call: Call; go: (s: Screen) => void; onMove: (up: boolean) => void;
}) {
  const [open, setOpen] = useState<"" | "start" | "more">("");
  const [sure, setSure] = useState(false);
  const parts = item.parts ?? [];
  const sid = item.session_id;
  const source = item.source;
  const dot = group === "needs" ? "ask" : item.state === "review" ? "rev" : group === "building" ? "run" : group === "done" ? "ok" : "q";
  const asker = ask ? parts.find((p) => p.session_id === ask.subject) : undefined;
  const talked = !!item.refine?.messages.length;
  const waits = item.depends_on.filter((d) => items.find((i) => i.id === d)?.state !== "done");
  const toggle = () => (sid && onOpen ? onOpen(sid) : setOpen((v) => (v === "more" ? "" : "more")));
  return (
    <li className="wl-r" data-s={item.state} data-open={open || undefined}>
      <div className="wl-l1">
        <i className="wl-dot" data-d={dot} aria-hidden />
        <button type="button" className="wl-t" title={item.title} aria-expanded={sid ? undefined : open === "more"} onClick={toggle}>
          <span className="sr-only">{STATE[item.state]?.label ?? item.state}: </span>{item.title}
        </button>
        {parts.length ? <Meter parts={parts} /> : null}
        {group === "next" ? (item.armed
          ? <span className="wl-after">after {waits.join(", ") || "its blocker"}</span>
          : <button type="button" className="wl-play" aria-expanded={open === "start"} onClick={() => setOpen((v) => (v === "start" ? "" : "start"))}>▸ Start</button>) : null}
      </div>
      <div className={ask ? "wl-l2 wl-asks" : "wl-l2"}>
        {ask ? <span className="wl-w">{asker ? <em>#{asker.n} </em> : null}{ask.body}</span>
          : <span className={item.note && !item.now ? "wl-w wl-warn" : "wl-w"}>{item.now ?? (item.note || [item.id, source?.ref ? `${source.kind ?? ""} ${source.ref}`.trim() : "", item.armed && waits.length ? `starts when ${waits.join(", ")} ${waits.length === 1 ? "is" : "are"} done` : ""].filter(Boolean).join(" · "))}</span>}
        {ask && onOpen ? <button type="button" className="dg-btn wl-ans" onClick={() => onOpen(ask.subject)}>Answer</button> : null}
      </div>
      {open === "start" ? <Start item={item} items={items} call={call} close={() => setOpen("")} /> : null}
      {open === "more" ? (
        <div className="wl-start">
          {item.detail ? <p className="wl-detail">{item.detail}</p> : null}
          {source?.url ? <a className="au-link" href={source.url} target="_blank" rel="noreferrer">{source.kind ? `${source.kind} ` : ""}{source.ref || source.url}</a> : null}
          <div className="wl-row">
            {item.state === "todo" ? <button type="button" className="dg-send wl-i" onClick={() => go({ k: "refine", id: item.id })}><Sparkles size={13} aria-hidden />{talked ? "Keep refining" : "Refine"}</button> : null}
            <button type="button" className="dg-btn wl-i" onClick={() => go({ k: "edit", id: item.id })}><Pencil size={13} aria-hidden />Edit</button>
            {item.state === "done" || item.state === "dropped" || item.state === "blocked" ? <button type="button" className="dg-btn" onClick={() => void call("update", { items: [{ id: item.id, state: "todo" }] })}>Back to the list</button> : null}
            <span className="wl-gap" />
            {item.state === "todo" ? <>
              <button type="button" className="wl-ic" aria-label={`Move ${item.title} up`} title="Move up" disabled={!canUp} onClick={() => onMove(true)}><ArrowUp size={14} aria-hidden /></button>
              <button type="button" className="wl-ic" aria-label={`Move ${item.title} down`} title="Move down" disabled={!canDown} onClick={() => onMove(false)}><ArrowDown size={14} aria-hidden /></button>
            </> : null}
            {item.state !== "done" ? <button type="button" className="wl-ic" aria-label={`Mark ${item.title} done`} title="Mark done" onClick={() => void call("update", { items: [{ id: item.id, state: "done" }] })}><Check size={15} aria-hidden /></button> : null}
            {sure
              ? <button type="button" className="dg-btn dg-danger" onClick={() => void call("remove", { ids: [item.id] })}>Really delete</button>
              : <button type="button" className="wl-ic" aria-label={`Delete ${item.title}`} title="Delete" onClick={() => setSure(true)}><Trash2 size={14} aria-hidden /></button>}
          </div>
        </div>
      ) : null}
    </li>
  );
}

// ------- this chat's plan (bridge/chatplan.py) ------------------------------------------------

const hm = (sec?: number | null) => (sec ? new Date(sec * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "");
const settled = (s: PlanStatus) => s === "completed" || s === "skipped";
const PSTATE: Record<PlanStatus, string> = { pending: "todo", in_progress: "doing", completed: "done", skipped: "dropped" };

function Count({ subs }: { subs: { status: PlanStatus }[] }) {
  const done = subs.filter((x) => settled(x.status)).length;
  return <span className="pl-cnt" aria-label={`${done} of ${subs.length} sub-steps done`}><i><b style={{ width: `${(100 * done) / subs.length}%` }} /></i>{done} of {subs.length}</span>;
}

function PlanStepRow({ step, n, waiting, onPlan }: { step: PlanStep; n: number; waiting: string[]; onPlan: (kind: string, step: PlanStep) => void }) {
  const [open, setOpen] = useState(step.status === "in_progress");
  const [menu, setMenu] = useState(false);
  const [sure, setSure] = useState(false);
  const subs = step.substeps ?? [];
  const when = step.status === "completed" ? `Done ${hm(step.done_at)}` : step.status === "skipped" ? "Skipped" : step.status === "in_progress" ? `Since ${hm(step.started_at)}` : "";
  const more = !!(step.detail || subs.length);
  const act = (kind: string) => { setMenu(false); setSure(false); onPlan(kind, step); };
  return (
    <li className="pl-step" data-s={PSTATE[step.status]}>
      <span className="pl-dot" aria-hidden />
      <div className="pl-head">
        <button type="button" className="pl-title" aria-expanded={more ? open : undefined} onClick={() => more && setOpen((v) => !v)}>
          <span className="sr-only">Step {n}, {STATE[PSTATE[step.status]].label}: </span>{step.title}
        </button>
        <button type="button" className="wl-ic pl-more" aria-label={`Options for step ${n}`} aria-expanded={menu} onClick={() => { setMenu((v) => !v); setSure(false); }}><Ellipsis size={15} aria-hidden /></button>
      </div>
      {subs.length || when ? <small>{subs.length ? <Count subs={subs} /> : null}{when}</small> : null}
      {step.note ? <small className="pl-note">{step.note}</small> : null}
      {more && !open ? <button type="button" className="pl-exp" onClick={() => setOpen(true)}><ChevronRight size={12} aria-hidden />{[step.detail ? "Details" : "", subs.length ? `${subs.length} sub-step${subs.length === 1 ? "" : "s"}` : ""].filter(Boolean).join(" and ")}</button> : null}
      {open && step.detail ? <div className="pl-md"><Markdown>{step.detail}</Markdown></div> : null}
      {open && subs.length ? <ul className="pl-subs">{subs.map((x, i) => <li key={i} data-s={PSTATE[x.status]}><span className="pl-box" aria-hidden />{x.title}<span className="sr-only">, {STATE[PSTATE[x.status]].label}</span></li>)}</ul> : null}
      {waiting.map((w, i) => <div key={i} className="pl-mine"><b>Your change · waiting</b>{w}</div>)}
      {menu ? (
        <div className="pl-menu" role="menu">
          <button type="button" role="menuitem" onClick={() => act("change")}><Pencil size={14} aria-hidden />Change this step</button>
          <button type="button" role="menuitem" onClick={() => act("ask")}><MessageSquare size={14} aria-hidden />Ask about it</button>
          {step.status === "pending" ? <button type="button" role="menuitem" onClick={() => act("sooner")}><ArrowUp size={14} aria-hidden />Do it sooner</button> : null}
          <button type="button" role="menuitem" onClick={() => act("task")}><ListPlus size={14} aria-hidden />Make it a work list task</button>
          {!settled(step.status) ? (sure
            ? <button type="button" role="menuitem" className="pl-danger" onClick={() => act("skip")}><SkipForward size={14} aria-hidden />Really skip it</button>
            : <button type="button" role="menuitem" onClick={() => setSure(true)}><SkipForward size={14} aria-hidden />Skip it</button>) : null}
        </div>
      ) : null}
    </li>
  );
}

function PlanView({ plan, call, go }: { plan: Plan; call: Call; go: (s: Screen) => void }) {
  const [showDone, setShowDone] = useState(false);
  const [said, setSaid] = useState("");
  const steps = plan.steps;
  const done = steps.filter((s) => settled(s.status));
  const at = steps.findIndex((s) => s.status === "in_progress");
  const fold = done.length > 3 && !showDone;
  const firstOpen = steps.findIndex((s) => !settled(s.status));
  const shown = fold ? steps.filter((s) => !settled(s.status) || steps.indexOf(s) > firstOpen) : steps;
  const mins = plan.started ? Math.max(1, Math.round((Date.now() / 1000 - plan.started) / 60)) : 0;
  const lastDone = done.reduce((m, s) => Math.max(m, s.done_at ?? 0), 0);
  const onPlan = async (kind: string, step: PlanStep) => {
    setSaid("");
    if (kind === "change") go({ k: "plan-change", step: step.id });
    else if (kind === "ask") go({ k: "plan-ask", step: step.id });
    else if (kind === "task") { if (await call("plan/task", { step: step.id })) setSaid(`"${step.title}" is on the work list now.`); }
    else void call(`plan/${kind}`, { step: step.id });
  };
  const sent = plan.pending[plan.pending.length - 1];
  return (
    <section className="pl" aria-label="This chat's plan">
      <div className="pl-top">
        <b>This chat's plan</b>
        <small>{done.length} of {steps.length}{at >= 0 ? ` · on step ${at + 1}` : ""}{mins ? ` · ${mins < 120 ? `${mins} min` : `${Math.round(mins / 60)} h`} so far` : ""}</small>
      </div>
      {sent ? <p className="pl-sent" role="status"><b>Sent {hm(sent.at)},</b> waiting for the agent to update its plan.</p> : null}
      {said ? <p className="pl-sent" role="status">{said}</p> : null}
      <ol className="pl-steps">
        {fold ? (
          <li className="pl-step" data-s="done">
            <span className="pl-dot" aria-hidden />
            <div className="pl-head"><span className="pl-title">{done.length} steps done</span></div>
            <small>Last at {hm(lastDone)}</small>
            <button type="button" className="pl-exp" onClick={() => setShowDone(true)}><ChevronDown size={12} aria-hidden />Show them</button>
          </li>
        ) : null}
        {shown.map((s) => <PlanStepRow key={s.id} step={s} n={steps.indexOf(s) + 1} onPlan={(k, st) => void onPlan(k, st)}
          waiting={plan.pending.filter((p) => p.step === s.id).map((p) => p.summary)} />)}
      </ol>
      <div className="wl-row pl-actions"><button type="button" className="dg-btn wl-i" onClick={() => go({ k: "plan-whole" })}><MessageSquare size={13} aria-hidden />Change the plan</button></div>
    </section>
  );
}

const PLAN_NOTE = "The agent owns its plan, so this goes to it as a message from you, and the plan changes when it writes it again.";

function PlanChange({ step, n, call, back }: { step: PlanStep; n: number; call: Call; back: () => void }) {
  const [title, setTitle] = useState(step.title);
  const [detail, setDetail] = useState(step.detail ?? "");
  const [subs, setSubs] = useState(() => (step.substeps ?? []).map((x) => ({ ...x })));
  const [why, setWhy] = useState("");
  const [preview, setPreview] = useState(false);
  const move = (i: number, d: number) => setSubs((v) => { const n2 = [...v]; [n2[i], n2[i + d]] = [n2[i + d], n2[i]]; return n2; });
  return (
    <form className="wl-sheet" onSubmit={async (e) => { e.preventDefault(); if (await call("plan/change", { step: step.id, title, detail, substeps: subs.filter((x) => x.title.trim()), why })) back(); }}>
      <div className="wl-editing"><Pencil size={14} aria-hidden /><b>Changing step {n}</b><span>Not sent yet</span></div>
      <div className="wl-sheet-b">
        <label className="wl-f"><span>Step</span><input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} /></label>
        <div className="wl-f"><span>Description <em>Markdown</em></span>
          <div className="pl-mdtabs" role="tablist">
            <button type="button" role="tab" aria-selected={!preview} onClick={() => setPreview(false)}>Write</button>
            <button type="button" role="tab" aria-selected={preview} onClick={() => setPreview(true)}>Preview</button>
          </div>
          {preview ? <div className="pl-md">{detail.trim() ? <Markdown>{detail}</Markdown> : <span className="wl-lede">Nothing yet.</span>}</div>
            : <textarea ref={fitBox} rows={4} className="pl-code" value={detail} placeholder="What the step is, if the title isn't enough" onChange={(e) => { setDetail(e.target.value); fitBox(e.target); }} />}
        </div>
        <div className="wl-f"><span>Sub-steps</span>
          {subs.map((x, i) => (
            <div key={i} className="pl-se" data-s={PSTATE[x.status]}>
              <input value={x.title} aria-label={`Sub-step ${i + 1}`} onChange={(e) => setSubs((v) => v.map((y, j) => (j === i ? { ...y, title: e.target.value } : y)))} />
              <button type="button" className="wl-ic" aria-label="Move up" disabled={!i} onClick={() => move(i, -1)}><ArrowUp size={13} aria-hidden /></button>
              <button type="button" className="wl-ic" aria-label="Move down" disabled={i === subs.length - 1} onClick={() => move(i, 1)}><ArrowDown size={13} aria-hidden /></button>
              <button type="button" className="wl-ic" aria-label="Remove" onClick={() => setSubs((v) => v.filter((_, j) => j !== i))}><X size={13} aria-hidden /></button>
            </div>
          ))}
          <button type="button" className="dg-btn wl-i" onClick={() => setSubs((v) => [...v, { title: "", status: "pending" }])}><Plus size={13} aria-hidden />Add a sub-step</button>
        </div>
        <label className="wl-f"><span>Tell the agent <em>optional</em></span><textarea ref={fitBox} rows={2} value={why} placeholder="Why, or anything else it should know" onChange={(e) => { setWhy(e.target.value); fitBox(e.target); }} /></label>
        <p className="wl-lede">{PLAN_NOTE}</p>
      </div>
      <div className="wl-sheet-f wl-row"><button type="submit" className="dg-send wl-grow" disabled={!title.trim()}>Send to the agent</button><button type="button" className="dg-btn" onClick={back}>Cancel</button></div>
    </form>
  );
}

function PlanAsk({ step, n, call, back }: { step?: PlanStep; n?: number; call: Call; back: () => void }) {
  const [text, setText] = useState("");
  return (
    <form className="wl-sheet" onSubmit={async (e) => { e.preventDefault(); if (await call(step ? "plan/ask" : "plan/whole", { step: step?.id, text })) back(); }}>
      <Head title={step ? `Ask about step ${n}` : "Change the plan"} onBack={back} />
      <div className="wl-sheet-b">
        {step ? <div className="wl-was"><b>{step.title}</b></div> : null}
        <label className="wl-f"><span>{step ? "Your question" : "What should change"}</span>
          <textarea ref={fitBox} rows={3} autoFocus value={text} placeholder={step ? "Which tests will this run?" : "Commit after each step, not at the end"} onChange={(e) => { setText(e.target.value); fitBox(e.target); }} />
        </label>
        <p className="wl-lede">{step ? "It reaches the agent as a message from you, and it answers in the chat." : PLAN_NOTE}</p>
      </div>
      <div className="wl-sheet-f wl-row"><button type="submit" className="dg-send wl-grow" disabled={!text.trim()}>Send to the agent</button><button type="button" className="dg-btn" onClick={back}>Cancel</button></div>
    </form>
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
        <label className="wl-f"><span>Details</span><textarea ref={fitBox} rows={4} value={detail} placeholder="Anything its session would need to know" onChange={(e) => { setDetail(e.target.value); fitBox(e.target); }} /></label>
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
            <label className="wl-f"><span>Details <em>optional</em></span><textarea ref={fitBox} rows={4} value={detail} placeholder="Anything its session would need to know" onChange={(e) => { setDetail(e.target.value); fitBox(e.target); }} /></label>
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

export function WorkPanel({ project, chat, asking = [], onAsk, onOpen }: { project?: string | null; chat?: string | null; asking?: Asking[]; onAsk?: (text: string) => void; onOpen?: (sessionId: string) => void }) {
  // The dashboard's rail sits outside the chat's scope, so it says which chat; the Mini App's page reads it.
  const scoped = useRefSession();
  const session = chat ?? scoped;
  const [data, setData] = useState<Listing | null>(null);
  const [error, setError] = useState("");
  const [screen, setScreen] = useState<Screen>({ k: "list" });
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
      // A plan route answers with the plan alone; everything else, with the whole listing.
      setData((d) => (path.startsWith("plan/") ? (d ? { ...d, plan: r.plan ?? null } : d) : r));
      setError("");
      return true;
    } catch (e) {
      setError(errorOf(e));
      return false;
    }
  };
  const items = data?.items ?? [];
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
  if (screen.k === "plan-change" || screen.k === "plan-ask" || screen.k === "plan-whole") {
    const steps = data?.plan?.steps ?? [];
    const step = screen.k === "plan-whole" ? undefined : steps.find((s) => s.id === screen.step);
    const n = step ? steps.indexOf(step) + 1 : undefined;
    if (screen.k === "plan-whole" || step) return (
      <div className="ds wl" data-sheet="">
        {failed}
        {screen.k === "plan-change" && step ? <PlanChange key={step.id} step={step} n={n!} call={call} back={back} /> : <PlanAsk step={step} n={n} call={call} back={back} />}
      </div>
    );
  }
  if (screen.k === "add") return (
    <div className="ds wl" data-sheet="">
      {failed}
      <Add tab={screen.tab} items={items} session={session} call={call} onAsk={onAsk} back={back} setTab={(tab) => setScreen({ k: "add", tab })} />
    </div>
  );

  // A task whose session, part or merge asks you something moves to Needs you, with the question.
  const askOf = (i: Item) => asking.find((a) => i.sessions?.includes(a.subject));
  const groupOf = (i: Item) => (askOf(i) ? "needs" : i.group);
  const todoIds = items.filter((i) => i.state === "todo").map((i) => i.id);
  const move = (item: Item, up: boolean) => {
    const at = todoIds.indexOf(item.id), to = at + (up ? -1 : 1);
    if (at < 0 || to < 0 || to >= todoIds.length) return;
    const next = [...todoIds];
    [next[at], next[to]] = [next[to], next[at]];
    void call("reorder", { ids: next });
  };
  const row = (i: Item) => {
    const at = todoIds.indexOf(i.id);
    return <Row key={i.id} item={i} group={groupOf(i)} ask={askOf(i)} items={items} canUp={at > 0} canDown={at >= 0 && at < todoIds.length - 1} onOpen={onOpen} call={call} go={setScreen} onMove={(up) => move(i, up)} />;
  };
  return (
    <div className="ds wl">
      <div className="wl-top"><b>Work{data ? <span> · {data.project}</span> : null}</b></div>
      {failed}
      {data?.plan?.steps.length ? <PlanView plan={data.plan} call={call} go={setScreen} /> : null}
      {data?.plan?.steps.length ? <div className="wl-top wl-sub"><b>Project tasks</b></div> : null}
      <div className="wl-body">
        {data && !items.length ? <p className="dg-empty">Nothing yet. Add tasks yourself, or ask an agent to bring them in from a tracker or your notes. Agents only change this list when you ask, and only you start a task.</p> : null}
        {GROUPS.map(([g, label]) => {
          const rows = items.filter((i) => groupOf(i) === g);
          if (!rows.length) return null;
          const list = <ul className="wl-rows">{rows.map(row)}</ul>;
          return g === "done"
            ? <details key={g} className="wl-g-done"><summary className="wl-g">{label} <i>{rows.length}</i><ChevronRight size={13} aria-hidden /></summary>{list}</details>
            : <section key={g} aria-label={label}><h3 className="wl-g" data-g={g}>{label} <i>{rows.length}</i></h3>{list}</section>;
        })}
      </div>
      <div className="wl-dock">
        <button type="button" className="dg-btn wl-i" onClick={() => setScreen({ k: "add", tab: "write" })}><Plus size={14} aria-hidden />New task</button>
        <button type="button" className="dg-btn wl-i" onClick={() => setScreen({ k: "add", tab: "bring" })}><Inbox size={14} aria-hidden />Bring in</button>
      </div>
    </div>
  );
}
