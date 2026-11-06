import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import {
  Bookmark, ChevronRight, File, FileText, Folder, FolderOpen, Image as ImageIcon, Trash2, TriangleAlert, X,
} from "lucide-react";
import { at, isStaleBridge } from "../../lib/agenttoolsapi";
import {
  OPEN_MYSTICAL, deleteAsk, groupEntries, imageUrl, isMarkdown, keepWorks, plural, soleFolder, type DirEntry, type DirListing, type DirScope,
} from "../../lib/mysticaldir";
import { ago } from "../../lib/surfaces";
import { Markdown } from "../Markdown";
import { askConfirm } from "../ui/Ask";
import { fmtBytes } from "./MoveDock";
import { StaleBridge } from "./AgentToolsBits";

/* The .MYSTICAL panel: a project's .mystical folder by kind (bridge/mystical_dir.py), from
   the right rail's FILES row and SETTINGS ▸ SYSTEM ▸ STORAGE. A window over whatever's
   open, so both places reach the one thing. Listing a folder costs a walk of it, so each
   opens on demand. Delete asks; images ask with what it costs old chats; bridge kind has no
   delete at all. Nothing here clears itself: the one bulk action lists first. */

const STALE_DAYS = 30;

function Thumb({ e, scope }: { e: DirEntry; scope: DirScope }) {
  const [broken, setBroken] = useState(false);
  if (e.preview === "image" && !broken) {
    return <img className="my-thumb" src={imageUrl(e.path, scope)} alt="" loading="lazy" onError={() => setBroken(true)} />;
  }
  const Icon = e.preview === "image" ? ImageIcon : e.preview === "text" ? FileText : File;
  return <span className="my-ico"><Icon size={13} strokeWidth={1.7} aria-hidden /></span>;
}

function EntryRow({ e, scope, depth, loaded, open, onToggle, onRead, onKeep, onDelete }: {
  e: DirEntry; scope: DirScope; depth: number; loaded: Map<string, DirListing | string>; open: Set<string>;
  onToggle: (e: DirEntry) => void; onRead: (e: DirEntry) => void; onKeep: (e: DirEntry) => void; onDelete: (e: DirEntry) => void;
}) {
  const isOpen = e.dir && open.has(e.path);
  const inner = isOpen ? loaded.get(e.path) : undefined;
  const can = e.dir || e.preview !== "none";
  const main = (
    <>
      {e.dir
        ? <span className="my-ico">{isOpen ? <FolderOpen size={13} strokeWidth={1.7} aria-hidden /> : <Folder size={13} strokeWidth={1.7} aria-hidden />}</span>
        : <Thumb e={e} scope={scope} />}
      <span className="my-name" title={e.path}>{e.name}{e.dir ? "/" : ""}</span>
    </>
  );
  return (
    <>
      <div className="my-row" style={{ paddingLeft: depth * 16 }}>
        <span className="my-lead">
          {can
            ? <button type="button" className="my-main" aria-expanded={e.dir ? isOpen : undefined} onClick={() => (e.dir ? onToggle(e) : onRead(e))}>{main}</button>
            : <span className="my-main" data-plain>{main}</span>}
          {e.keep && <span className="ma-tag" data-tone="ok" title="Clearing leaves this alone">KEPT</span>}
        </span>
        <span className="my-size">{fmtBytes(e.bytes)}</span>
        <span className="my-age" title={new Date(e.at * 1000).toLocaleString()}>{ago(e.at) || "—"}</span>
        <span className="my-acts">
          {keepWorks(e) && (
            <button type="button" className="my-act" data-on={e.keep || undefined} aria-pressed={e.keep}
              title={e.keep ? "Clearing leaves this alone. Click to stop keeping it." : "Keep: clearing leaves this alone"} aria-label={`Keep ${e.name}`} onClick={() => onKeep(e)}>
              <Bookmark size={12} aria-hidden />
            </button>
          )}
          {e.deletable && (
            <button type="button" className="my-act" data-danger title="Delete" aria-label={`Delete ${e.name}`} onClick={() => onDelete(e)}><Trash2 size={12} aria-hidden /></button>
          )}
        </span>
      </div>
      {isOpen && (inner === undefined
        ? <div className="my-note" role="status" style={{ paddingLeft: (depth + 1) * 16 }}>Reading…</div>
        : typeof inner === "string"
          ? <div className="my-note" data-err role="alert" style={{ paddingLeft: (depth + 1) * 16 }}>{inner}</div>
          : inner.entries.length === 0
            ? <div className="my-note" style={{ paddingLeft: (depth + 1) * 16 }}>Empty.</div>
            : inner.entries.map((x) => <EntryRow key={x.path} e={x} scope={scope} depth={depth + 1} loaded={loaded} open={open} onToggle={onToggle} onRead={onRead} onKeep={onKeep} onDelete={onDelete} />))}
    </>
  );
}

function Reader({ entry, scope, onClose }: { entry: DirEntry; scope: DirScope; onClose: () => void }) {
  const [text, setText] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const shut = useRef<HTMLButtonElement>(null);
  useEffect(() => { shut.current?.focus(); }, []);
  useEffect(() => {
    if (entry.preview !== "text") return;
    let live = true;
    at.dirRead(scope, entry.path).then((r) => { if (live) setText(r.text); }, (e: Error) => { if (live) setErr(e.message); });
    return () => { live = false; };
  }, [entry, scope]);
  let body: ReactNode;
  if (entry.preview === "image") body = <img className="my-full" src={imageUrl(entry.path, scope)} alt={entry.name} />;
  else if (err) body = <p className="ma-report-err">It can&apos;t be read: {err}.</p>;
  else if (text === null) body = <p className="ma-report-wait" role="status">Reading…</p>;
  else if (!text) body = <p className="ma-report-wait">This file is empty.</p>;
  else if (isMarkdown(entry.name)) body = <Markdown className="leading-relaxed">{text}</Markdown>;
  else body = <pre className="my-pre">{text}</pre>;
  return (
    <div className="my-scrim" data-top onClick={onClose}>
      <div className="ma-report" role="dialog" aria-modal="true" aria-label={entry.name} onClick={(e) => e.stopPropagation()}>
        <div className="ma-report-head">
          <FileText size={14} strokeWidth={2} aria-hidden />
          <b>{entry.name}</b>
          <span className="ma-report-path" title={entry.path}>.mystical/{entry.path}</span>
          <button ref={shut} type="button" className="ma-link" onClick={onClose} aria-label={`Close ${entry.name}`}><X size={15} aria-hidden /></button>
        </div>
        <div className="ma-report-body">{body}</div>
      </div>
    </div>
  );
}

function ClearAsk({ paths, busy, onCancel, onClear }: { paths: string[]; busy: boolean; onCancel: () => void; onClear: () => void }) {
  const cancel = useRef<HTMLButtonElement>(null);
  useEffect(() => { cancel.current?.focus(); }, []);
  return (
    <div className="my-scrim" data-top onClick={() => { if (!busy) onCancel(); }}>
      <div className="my-ask" role="dialog" aria-modal="true" aria-labelledby="my-ask-t" onClick={(e) => e.stopPropagation()}>
        <div id="my-ask-t" className="my-ask-t">Clear {plural(paths.length, "thing")} older than {STALE_DAYS} days?</div>
        <p>From scratch and other, and only these. Anything marked keep stays. It doesn&apos;t go to the Trash.</p>
        <ul className="my-ask-list">{paths.map((p) => <li key={p}><code>{p}</code></li>)}</ul>
        <div className="at-formfoot">
          <button ref={cancel} type="button" className="at-btn" data-quiet disabled={busy} onClick={onCancel}>Cancel</button>
          <button type="button" className="at-btn" data-danger disabled={busy} onClick={onClear}>{busy ? "Clearing…" : `Delete ${plural(paths.length, "thing")}`}</button>
        </div>
      </div>
    </div>
  );
}

function EmptyDir() {
  return (
    <div className="my-empty">
      <FolderOpen size={26} strokeWidth={1.2} aria-hidden />
      <b>Nothing in .mystical yet.</b>
      <p>It fills up as agents work here, and git never sees it.</p>
      <ul>
        <li><code>images/</code> pictures in your messages</li>
        <li><code>docs/</code> reports written to be read</li>
        <li><code>drafts/</code> design drafts and mockups</li>
        <li><code>scratch/</code> throwaway scripts and probes</li>
      </ul>
    </div>
  );
}

function Panel({ start, projects, onClose }: { start: DirScope; projects: { rel: string; name: string }[]; onClose: () => void }) {
  const [scope, setScope] = useState<DirScope>(start);
  const [list, setList] = useState<DirListing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [openGroups, setOpenGroups] = useState<Set<string>>(new Set());
  const [openDirs, setOpenDirs] = useState<Set<string>>(new Set());
  const [loaded, setLoaded] = useState<Map<string, DirListing | string>>(new Map());
  const [reading, setReading] = useState<DirEntry | null>(null);
  const [asking, setAsking] = useState(false);
  const [clearing, setClearing] = useState(false);
  const shut = useRef<HTMLButtonElement>(null);
  const confirming = useRef(0);

  const readDir = useCallback((path: string) => {
    setLoaded((m) => { const n = new Map(m); if (typeof n.get(path) === "string") n.delete(path); return n; });
    at.dir(scope, path).then(
      (r) => setLoaded((m) => new Map(m).set(path, r)),
      (e: Error) => setLoaded((m) => new Map(m).set(path, e.message)),
    );
  }, [scope]);
  const load = useCallback(() => {
    setError(null);
    return at.dir(scope).then((r) => { setList(r); return r; }, (e: Error) => { setError(e.message); return null; });
  }, [scope]);
  /** After a change: what's open is read again, so sizes and rows are all true. */
  const reload = useCallback(() => {
    void load();
    openDirs.forEach(readDir);
  }, [load, readDir, openDirs]);

  useEffect(() => {
    setList(null); setLoaded(new Map()); setOpenDirs(new Set()); setOpenGroups(new Set()); setDone(null); setProblem(null);
    void load();
  }, [load]);
  useEffect(() => { shut.current?.focus(); }, []);

  // Over everything, so Escape shuts the top thing, and a question over this panel shuts
  // first by itself (lib/ui/Ask handles its own key).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || confirming.current) return;
      e.stopPropagation();
      if (reading) setReading(null);
      else if (asking) { if (!clearing) setAsking(false); }
      else onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [reading, asking, clearing, onClose]);

  const toggleDir = (e: DirEntry) => {
    const n = new Set(openDirs);
    if (n.has(e.path)) n.delete(e.path);
    else { n.add(e.path); readDir(e.path); }
    setOpenDirs(n);
  };
  const toggleGroup = (kind: string, sole: DirEntry | null) => {
    const n = new Set(openGroups);
    if (n.has(kind)) n.delete(kind);
    else {
      n.add(kind);
      if (sole && !openDirs.has(sole.path)) {
        readDir(sole.path);
        setOpenDirs(new Set(openDirs).add(sole.path));
      }
    }
    setOpenGroups(n);
  };
  const keep = (e: DirEntry) => {
    setProblem(null);
    at.dirKeep(scope, e.path, !e.keep).then(reload, (err: Error) => setProblem(err.message));
  };
  const remove = async (e: DirEntry) => {
    const ask = deleteAsk(e);
    confirming.current += 1;
    const yes = await askConfirm(ask.text, { ok: ask.ok, danger: true });
    confirming.current -= 1;
    if (!yes) return;
    setProblem(null);
    at.dirDelete(scope, e.path, ask.confirm).then(() => { setDone(`Deleted ${e.name}, ${fmtBytes(e.bytes)}.`); reload(); }, (err: Error) => setProblem(err.message));
  };
  const clear = () => {
    setClearing(true);
    setProblem(null);
    at.dirClear(scope, STALE_DAYS).then(
      (r) => { setDone(r.removed ? `Cleared ${plural(r.removed, "thing")}, ${fmtBytes(r.freed)}.` : "Nothing was cleared."); setAsking(false); reload(); },
      (err: Error) => { setProblem(err.message); setAsking(false); },
    ).finally(() => setClearing(false));
  };

  const groups = list ? groupEntries(list) : [];
  const stale = list?.stale ?? [];
  const max = Math.max(1, ...groups.map((g) => g.bytes));
  const rows = (es: DirEntry[]) => es.map((e) => (
    <EntryRow key={e.path} e={e} scope={scope} depth={0} loaded={loaded} open={openDirs} onToggle={toggleDir} onRead={setReading} onKeep={keep} onDelete={(x) => void remove(x)} />
  ));
  const projectValue = scope.project ?? "";

  let body: ReactNode;
  if (isStaleBridge(error)) body = <StaleBridge what=".mystical" />;
  else if (error === "no project") body = <div className="my-empty"><FolderOpen size={26} strokeWidth={1.2} aria-hidden /><b>Pick a project.</b><p>Each project has its own .mystical folder.</p></div>;
  else if (error) body = <div className="ma-set-err" role="alert">Couldn&apos;t read the folder: {error} <button type="button" className="ma-link" onClick={() => void load()}>try again</button></div>;
  else if (!list) body = <div className="ma-set-note" role="status">Reading the folder…</div>;
  else if (!groups.length) body = <EmptyDir />;
  else {
    body = groups.map((g) => {
      const on = openGroups.has(g.kind);
      const sole = soleFolder(g);
      const inner = sole && on ? loaded.get(sole.path) : undefined;
      return (
        <section key={g.kind} className="my-group" data-open={on || undefined}>
          <button type="button" className="my-grouphead" aria-expanded={on} onClick={() => toggleGroup(g.kind, sole)}>
            <ChevronRight size={12} aria-hidden className="at-chev" />
            <b>{g.label}</b>
            <span className="my-groupabout">{g.about}</span>
            <span className="my-bar" aria-hidden><i style={{ width: `${Math.max(2, (g.bytes / max) * 100)}%` }} /></span>
            <span className="my-count">{plural(g.files, "file")}</span>
            <span className="my-size">{fmtBytes(g.bytes)}</span>
          </button>
          {on && (
            <div className="my-rows">
              {sole
                ? (inner === undefined ? <div className="my-note" role="status">Reading…</div>
                  : typeof inner === "string" ? <div className="my-note" data-err role="alert">{inner}</div>
                  : inner.entries.length === 0 ? <div className="my-note">Empty.</div>
                  : rows(inner.entries))
                : rows(g.entries)}
            </div>
          )}
        </section>
      );
    });
  }

  // No portal: it sits beside SETTINGS in App's own stacking context, under the HUD's asks.
  return (
    <div className="my-scrim" onClick={onClose}>
      <div className="panel my-panel" role="dialog" aria-modal="true" aria-label=".mystical folder" onClick={(e) => e.stopPropagation()}>
        <div className="my-head">
          <span className="my-title">.mystical</span>
          {projects.length > 0
            ? (
              <select className="ma-input" value={projectValue} aria-label="Project"
                onChange={(e) => setScope({ project: e.target.value || null, session: e.target.value ? null : start.session })}>
                {!scope.project && <option value="">{start.session ? "this chat's project" : "Pick a project"}</option>}
                {projects.map((p) => <option key={p.rel} value={p.rel}>{p.name}</option>)}
              </select>
            )
            : null}
          <span style={{ flex: 1 }} />
          {list && <span className="my-total"><b>{fmtBytes(list.total)}</b></span>}
          <button ref={shut} type="button" className="ma-link" aria-label="Close" onClick={onClose}><X size={15} aria-hidden /></button>
        </div>
        {list?.root && <div className="my-root" title={list.root}><code>{list.root}/.mystical</code></div>}
        {(problem || done) && (
          <div className="my-msgs">
            {problem && <div className="ma-set-err" role="alert">{problem}</div>}
            {done && <div className="my-done" role="status">{done}</div>}
          </div>
        )}
        <div className="mscroll my-body">{body}</div>
        {list && groups.length > 0 && (
          <div className="my-foot">
            <span className="my-footnote">{stale.length ? `${plural(stale.length, "thing")} in scratch and other ${stale.length === 1 ? "is" : "are"} older than ${STALE_DAYS} days.` : `Nothing in scratch or other is older than ${STALE_DAYS} days.`}</span>
            <button type="button" className="at-btn" disabled={!stale.length} onClick={() => setAsking(true)}><TriangleAlert size={12} aria-hidden />Clear scratch and other older than {STALE_DAYS} days</button>
          </div>
        )}
      </div>
      {reading && <div onClick={(e) => e.stopPropagation()}><Reader entry={reading} scope={scope} onClose={() => setReading(null)} /></div>}
      {asking && <div onClick={(e) => e.stopPropagation()}><ClearAsk paths={stale} busy={clearing} onCancel={() => setAsking(false)} onClear={clear} /></div>}
    </div>
  );
}

/** The one window: App holds this, and openMysticalPanel asks it. */
export function MysticalHost({ projects }: { projects: { rel: string; name: string }[] }) {
  const [start, setStart] = useState<DirScope | null>(null);
  useEffect(() => {
    const open = (e: Event) => setStart((e as CustomEvent<DirScope>).detail);
    window.addEventListener(OPEN_MYSTICAL, open);
    return () => window.removeEventListener(OPEN_MYSTICAL, open);
  }, []);
  if (!start) return null;
  return <Panel key={`${start.project ?? ""}:${start.session ?? ""}`} start={start} projects={projects} onClose={() => setStart(null)} />;
}
