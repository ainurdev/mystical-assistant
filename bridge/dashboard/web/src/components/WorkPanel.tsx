import { useCallback, useEffect, useState } from "react";
import { useRefSession, workCall, workGet } from "../lib/readapi";
import { Dialog } from "./DesignSystem";

// The project's work list (bridge/worklist.py): what's going to be worked on, what's being worked on,
// and what's done. Agents fill it when you ask, so this is mostly for reading and small edits. Same file
// in both apps; onAsk sends words to the open chat's agent, onOpen opens a chat. A run (bridge/workrun.py)
// shows on top: starting one is here because only you can, and landing one is here because only you should.

type Source = { kind?: string; ref?: string; url?: string } | null;
type Item = {
  id: string; title: string; detail: string; source: Source; depends_on: string[]; state: string; note: string; group: string;
  helper?: string; session_id?: string;
};
type Run = {
  id: string; chat: string; chat_title: string; state: "running" | "paused" | "finished"; branch: string; into: string; parallel: number;
  summary?: string; paused_why?: string; dirty?: boolean; items: string[]; merged: number;
};
type Listing = { items: Item[]; project: string; runs?: Run[] };

const errorOf = (e: unknown) => (e instanceof Error ? e.message : "That didn't work.");
const GROUPS: { id: string; label: string }[] = [
  { id: "doing", label: "In progress" },
  { id: "review", label: "In review" },
  { id: "blocked", label: "Blocked" },
  { id: "next", label: "Up next" },
  { id: "here", label: "Done in this chat" },
  { id: "later", label: "Not in this run" },
  { id: "done", label: "Already done" },
  { id: "dropped", label: "Dropped" },
];
const ASK_HINT = "Open Linear issues tagged backend, or paste your notes";

function RunCard({ run, session, onRun, onOpen }: { run: Run; session: string | null; onRun: (path: string) => void; onOpen?: (id: string) => void }) {
  const [sure, setSure] = useState(false);
  const here = run.chat === session;
  const merged = `${run.merged} item${run.merged === 1 ? "" : "s"} merged`;
  return (
    <section className="wl-run" data-state={run.state} aria-live="polite">
      <div className="au-top">
        <b>{run.state === "running" ? "Run going" : run.state === "paused" ? "Run paused" : "Run finished"}</b>
        <small>{merged}</small>
      </div>
      <small className="wl-branch">{run.branch}</small>
      {run.state !== "finished" ? <small>Up to {run.parallel} at once. Managed in {here ? "this chat" : onOpen ? <button type="button" className="au-link" onClick={() => onOpen(run.chat)}>{run.chat_title || "another chat"}</button> : run.chat_title || "another chat"}.</small> : null}
      {run.paused_why ? <small className="wl-note">{run.paused_why}</small> : null}
      {run.summary ? (
        run.summary.length > 200
          ? <details className="wl-more"><summary>{run.summary.slice(0, 160).trimEnd()}…</summary><small>{run.summary}</small></details>
          : <small>{run.summary}</small>
      ) : null}
      {run.state === "finished" ? <small>Your branch hasn't moved. Merging is local, and nothing is pushed.</small> : null}
      <div className="wl-acts">
        {run.state === "running" ? <button type="button" className="dg-btn" onClick={() => onRun("pause")}>Pause</button> : null}
        {run.state === "paused" ? <button type="button" className="dg-send" disabled={!session} onClick={() => onRun("resume")}>{here ? "Resume" : "Take over here"}</button> : null}
        {run.state !== "finished" ? <button type="button" className="dg-btn" onClick={() => onRun("stop")}>Stop helpers</button> : null}
        {run.state === "paused" ? <button type="button" className="dg-btn" onClick={() => onRun("end")}>End the run</button> : null}
        {run.state === "finished" ? <button type="button" className="dg-send" disabled={!run.merged} onClick={() => onRun("land")}>Merge into your branch</button> : null}
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

function Row({ item, first, onEdit, onMove, onOpen }: { item: Item; first: boolean; onEdit: (body: Record<string, unknown>, path?: string) => void; onMove: (up: boolean) => void; onOpen?: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState(item.title);
  const [detail, setDetail] = useState(item.detail);
  const [sure, setSure] = useState(false);
  const live = item.state === "doing" || item.state === "review";
  const source = item.source;
  return (
    <li className="wl-item" data-state={item.state}>
      <div className="wl-top">
        <i className="wl-dot" />
        <span className="wl-id">{item.id}</span>
        <button type="button" className="wl-title" aria-expanded={open} onClick={() => setOpen((v) => !v)}>{item.title}</button>
      </div>
      {source?.ref || source?.url ? (
        <small>{source.url ? <a className="au-link" href={source.url} target="_blank" rel="noreferrer">{source.kind ? `${source.kind} ` : ""}{source.ref || source.url}</a> : `${source.kind ? `${source.kind} ` : ""}${source.ref}`}</small>
      ) : null}
      {item.depends_on.length ? <small>After {item.depends_on.join(", ")}</small> : null}
      {item.note ? <small className={item.state === "blocked" ? "wl-note" : undefined}>{item.note}</small> : null}
      {live && item.session_id ? <small>{item.helper}{onOpen ? <> · <button type="button" className="au-link" onClick={() => onOpen(item.session_id!)}>open its chat</button></> : null}</small> : null}
      {open ? (
        <div className="wl-open">
          <label className="ds-f"><span>Title</span><input value={title} onChange={(e) => setTitle(e.target.value)} /></label>
          <label className="ds-f"><span>Detail</span><textarea rows={4} value={detail} onChange={(e) => setDetail(e.target.value)} /></label>
          <div className="wl-acts">
            <button type="button" className="dg-btn" disabled={!title.trim()} onClick={() => { onEdit({ items: [{ id: item.id, title, detail }] }); setOpen(false); }}>Save</button>
            {item.state === "todo" ? <button type="button" className="dg-btn" disabled={first} onClick={() => onMove(true)}>Move up</button> : null}
            {!live && item.state !== "done" ? <button type="button" className="dg-btn" onClick={() => onEdit({ items: [{ id: item.id, state: "done" }] })}>Mark done</button> : null}
            {item.state === "done" || item.state === "dropped" || item.state === "blocked" ? <button type="button" className="dg-btn" onClick={() => onEdit({ items: [{ id: item.id, state: "todo" }] })}>Back to the list</button> : null}
            {!live ? (sure
              ? <button type="button" className="dg-btn dg-danger" onClick={() => onEdit({ ids: [item.id] }, "remove")}>Really delete</button>
              : <button type="button" className="dg-btn" onClick={() => setSure(true)}>Delete</button>) : null}
          </div>
        </div>
      ) : null}
    </li>
  );
}

export function WorkPanel({ project, chat, onAsk, onOpen }: { project?: string | null; chat?: string | null; onAsk?: (text: string) => void; onOpen?: (sessionId: string) => void }) {
  // The dashboard's rail sits outside the chat's scope, so it says which chat; the Mini App's page reads it.
  const scoped = useRefSession();
  const session = chat ?? scoped;
  const [data, setData] = useState<Listing | null>(null);
  const [error, setError] = useState("");
  const [title, setTitle] = useState("");
  const [ask, setAsk] = useState("");
  const [starting, setStarting] = useState(false);
  const load = useCallback(() => {
    workGet<Listing>(session, project).then((r) => { setData(r); setError(""); }, (e) => setError(errorOf(e)));
  }, [session, project]);
  useEffect(() => {
    load();
    const t = window.setInterval(load, 3000);
    return () => window.clearInterval(t);
  }, [load]);
  const call = (path: string, body: Record<string, unknown>) => {
    workCall<Listing>(path, session, project, body).then(setData, (e) => setError(errorOf(e)));
  };
  const add = () => {
    const t = title.trim();
    if (!t) return;
    setTitle("");
    call("add", { items: [{ title: t }] });
  };
  const move = (item: Item) => {
    const todo = (data?.items ?? []).filter((i) => i.state === "todo").map((i) => i.id);
    const at = todo.indexOf(item.id);
    if (at > 0) { [todo[at - 1], todo[at]] = [todo[at], todo[at - 1]]; call("reorder", { ids: todo }); }
  };
  const items = data?.items ?? [];
  const runs = data?.runs ?? [];
  const going = runs.some((r) => r.state !== "finished");
  const upNext = items.filter((i) => i.group === "next");
  return (
    <div className="ds wl">
      <div className="au-head">
        <h4 className="ds-h">Work list{data ? ` · ${data.project}` : ""}</h4>
        {!going && upNext.length ? <button type="button" className="dg-send" disabled={!session} title={session ? undefined : "Open a chat: its agent manages the run"} onClick={() => setStarting(true)}>Run</button> : null}
      </div>
      {error ? <p className="ds-err" role="alert">{error}</p> : null}
      {runs.map((r) => <RunCard key={r.id} run={r} session={session} onOpen={onOpen} onRun={(path) => call(`run/${path}`, { run: r.id })} />)}
      {starting ? <Starter items={upNext} onClose={() => setStarting(false)} onStart={(ids, parallel) => { setStarting(false); call("run/start", { ids, parallel }); }} /> : null}
      <form className="wl-add" onSubmit={(e) => { e.preventDefault(); add(); }}>
        <input value={title} aria-label="New task" placeholder="Add a task" onChange={(e) => setTitle(e.target.value)} />
        <button type="submit" className="dg-btn" disabled={!title.trim()}>Add</button>
      </form>
      {onAsk && session ? (
        <form className="wl-ask" onSubmit={(e) => { e.preventDefault(); if (ask.trim()) { onAsk(`Update the work list with work_list: ${ask.trim()}`); setAsk(""); } }}>
          <label className="ds-f"><span>Or ask this chat's agent to fill it or refresh it</span>
            <textarea rows={2} value={ask} placeholder={ASK_HINT} onChange={(e) => setAsk(e.target.value)} />
          </label>
          <button type="submit" className="dg-btn" disabled={!ask.trim()}>Ask</button>
        </form>
      ) : null}
      {data && !items.length ? <p className="dg-empty">Nothing yet. Add tasks here, or ask an agent to bring them in from a tracker or your notes. Agents only change this list when you ask.</p> : null}
      {GROUPS.map((g) => {
        const rows = items.filter((i) => i.group === g.id);
        if (!rows.length) return null;
        return (
          <section key={g.id} className="wl-group">
            <h5><span>{g.label}</span><span>{rows.length}</span></h5>
            <ul>{rows.map((i, n) => <Row key={i.id} item={i} first={n === 0} onOpen={onOpen} onMove={() => move(i)} onEdit={(body, path) => call(path ?? "update", body)} />)}</ul>
          </section>
        );
      })}
    </div>
  );
}
