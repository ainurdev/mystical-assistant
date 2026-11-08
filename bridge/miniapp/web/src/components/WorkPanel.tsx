import { useCallback, useEffect, useState } from "react";
import { useRefSession, workCall, workGet } from "../lib/readapi";

// The project's work list (bridge/worklist.py): what's going to be worked on, what's being worked on,
// and what's done. Agents fill it when you ask, so this is mostly for reading and small edits. Same file
// in both apps; onAsk sends words to the open chat's agent, onOpen opens a chat.

type Source = { kind?: string; ref?: string; url?: string } | null;
type Item = {
  id: string; title: string; detail: string; source: Source; depends_on: string[]; state: string; note: string; group: string;
};
type Listing = { items: Item[]; project: string };

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

function Row({ item, first, onEdit, onMove }: { item: Item; first: boolean; onEdit: (body: Record<string, unknown>, path?: string) => void; onMove: (up: boolean) => void }) {
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

export function WorkPanel({ project, onAsk }: { project?: string | null; onAsk?: (text: string) => void; onOpen?: (sessionId: string) => void }) {
  const session = useRefSession();
  const [data, setData] = useState<Listing | null>(null);
  const [error, setError] = useState("");
  const [title, setTitle] = useState("");
  const [ask, setAsk] = useState("");
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
  return (
    <div className="ds wl">
      <div className="au-head"><h4 className="ds-h">Work list{data ? ` · ${data.project}` : ""}</h4></div>
      {error ? <p className="ds-err" role="alert">{error}</p> : null}
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
            <ul>{rows.map((i, n) => <Row key={i.id} item={i} first={n === 0} onMove={() => move(i)} onEdit={(body, path) => call(path ?? "update", body)} />)}</ul>
          </section>
        );
      })}
    </div>
  );
}
