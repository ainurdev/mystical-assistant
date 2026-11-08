import { useCallback, useEffect, useMemo, useState } from "react";
import { byGroup, docParts, outlinePrompt, writePrompt, type DocPage } from "../lib/docparts";
import { designCall, useRefSession } from "../lib/readapi";
import { DataView } from "./DataView";
import { Dialog } from "./DesignSystem";
import { Markdown } from "./Markdown";

// The Docs tab (bridge/project_docs.py): a project's generated docs and whatever Markdown it already
// has. Nothing is written unless you ask, and what wasn't generated says it's unchecked. Asking
// goes to the chat you're in, so you can watch and steer it. Same file in both apps.

type Found = { path: string; name: string; folder: string };
type Gen = { title: string; folder: string; hidden: boolean; pages: DocPage[] };
type Listing = { found: Found[]; generated: Gen | null };
type Open = { title: string; id?: string; path?: string; found?: boolean; changed?: string[] };

const errorOf = (e: unknown) => (e instanceof Error ? e.message : "That didn't work.");

function Reader({ open, session, onClose }: { open: Open; session: string; onClose: () => void }) {
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    designCall<{ text: string }>(session, "doc-read", open.id ? { id: open.id } : { path: open.path }).then((r) => setText(r.text), (e) => setError(errorOf(e)));
  }, [session, open]);
  const parts = useMemo(() => (text === null ? [] : docParts(text)), [text]);
  return (
    <Dialog title={open.title} onClose={onClose} wide>
      <div className="dc-read">
        {open.found ? <p className="dc-warn" role="note">⚠ Found in the project, and nobody has checked it against the code, so it might not be accurate.</p> : null}
        {open.changed?.length ? <p className="dc-warn" role="note">⚠ {open.changed.length} of the files this page is about changed since it was written: {open.changed.slice(0, 4).join(", ")}.</p> : null}
        {error ? <p className="ds-err" role="alert">{error}</p> : null}
        {text === null && !error ? <p className="dg-empty">Opening…</p> : null}
        {parts.map((p, i) => ("view" in p ? <DataView key={i} ev={p.view} /> : <Markdown key={i}>{p.md}</Markdown>))}
      </div>
    </Dialog>
  );
}

export function DocsPanel({ onAsk }: { onAsk?: (text: string) => void }) {
  const session = useRefSession();
  const [data, setData] = useState<Listing | null>(null);
  const [error, setError] = useState("");
  const [open, setOpen] = useState<Open | null>(null);
  const [choosing, setChoosing] = useState(false);
  const [where, setWhere] = useState<"hidden" | "project">("hidden");
  const [folder, setFolder] = useState("docs");
  const [said, setSaid] = useState("");
  const [showFound, setShowFound] = useState(false);
  const load = useCallback(() => {
    if (!session) return;
    designCall<Listing>(session, "docs").then((r) => { setData(r); setError(""); }, (e) => setError(errorOf(e)));
  }, [session]);
  // The agent writes pages as you watch, so the contents keep up.
  useEffect(() => {
    load();
    const t = window.setInterval(load, 6000);
    return () => window.clearInterval(t);
  }, [load]);
  const ask = (text: string, note: string) => { onAsk?.(text); setSaid(note); };
  if (!session) return <div className="ds"><p className="dg-empty">Open a chat in a project to see its docs.</p></div>;
  const gen = data?.generated;
  const unwritten = gen?.pages.filter((p) => !p.written) ?? [];
  const stale = gen?.pages.filter((p) => p.written && p.changed.length) ?? [];
  const foundList = (
    <ul className="dc-found">
      {(data?.found ?? []).map((f) => (
        <li key={f.path}><button type="button" className="dc-page" title={f.path} onClick={() => setOpen({ title: f.path, path: f.path, found: true })}>{f.folder ? `${f.folder}/` : ""}{f.name}</button></li>
      ))}
    </ul>
  );
  return (
    <div className="ds dc">
      <div className="au-head">
        <h4 className="ds-h">{gen?.title || "Docs"}</h4>
        {gen ? <small className="dc-where" title={gen.folder}>{gen.hidden ? "Hidden" : gen.folder}</small> : null}
      </div>
      {error ? <p className="ds-err" role="alert">{error}</p> : null}
      {!data && !error ? <p className="dg-empty">Looking through this project…</p> : null}
      {said ? <p className="ds-said" role="status">{said}</p> : null}
      {data && !gen ? (
        <>
          <p className="dg-empty">{data.found.length ? "Nothing's been generated for this project. The documents below were found in it, and nobody has checked them, so they might not be accurate." : "This project has no docs yet."}</p>
          {onAsk ? <button type="button" className="dg-send" onClick={() => setChoosing(true)}>Generate docs</button> : null}
        </>
      ) : null}
      {gen ? (
        <>
          <div className="ds-do dc-do">
            {onAsk && unwritten.length ? <button type="button" className="dg-send" onClick={() => ask(writePrompt(unwritten.map((p) => p.id)), `Asked the agent to write ${unwritten.length} page${unwritten.length === 1 ? "" : "s"}. They appear here as they're done.`)}>Write {unwritten.length === gen.pages.length ? "all" : `the other ${unwritten.length}`}</button> : null}
            {onAsk && stale.length ? <button type="button" className="dg-btn" onClick={() => ask(writePrompt(stale.map((p) => p.id)), `Asked the agent to update ${stale.length} page${stale.length === 1 ? "" : "s"}.`)}>Update {stale.length} out of date</button> : null}
            {onAsk ? <button type="button" className="dg-btn" onClick={() => setChoosing(true)}>Redo contents</button> : null}
          </div>
          {byGroup(gen.pages).map((g) => (
            <section key={g.group} className="dc-group">
              {g.group ? <h5>{g.group}</h5> : null}
              <ul>
                {g.pages.map((p) => (
                  <li key={p.id} data-unwritten={!p.written || undefined}>
                    {p.written ? <button type="button" className="dc-page" title={p.summary} onClick={() => setOpen({ title: p.title, id: p.id, changed: p.changed })}>{p.title}</button> : <span className="dc-page" title={p.summary}>{p.title}</span>}
                    {!p.written && onAsk ? <button type="button" className="au-link" onClick={() => ask(writePrompt([p.id]), `Asked the agent to write ${p.title}.`)}>Write</button> : null}
                    {p.written && p.changed.length ? <small className="dc-stale" title={p.changed.join(", ")}>⚠ files changed</small> : null}
                    {p.summary ? <small>{p.summary}</small> : null}
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </>
      ) : null}
      {data?.found.length ? (
        gen ? (
          <details className="ds-more" open={showFound} onToggle={(e) => setShowFound(e.currentTarget.open)}>
            <summary>Also in the project <span>{data.found.length}, unchecked</span></summary>
            {foundList}
          </details>
        ) : foundList
      ) : null}
      {open ? <Reader open={open} session={session} onClose={() => setOpen(null)} /> : null}
      {choosing ? (
        <Dialog title="Generate docs" onClose={() => setChoosing(false)}>
          <div className="au-form">
            <p className="dc-intro">An agent reads the project and proposes a table of contents, which shows up here. You look it over, then have it write all the pages or just some.</p>
            <div className="ds-f"><span>Where should they live?</span>
              <div className="ds-chips" role="radiogroup">
                <button type="button" role="radio" aria-checked={where === "hidden"} className="dg-chip" onClick={() => setWhere("hidden")}>Hidden, in .mystical</button>
                <button type="button" role="radio" aria-checked={where === "project"} className="dg-chip" onClick={() => setWhere("project")}>In the project</button>
              </div>
              <small className="au-hint">{where === "hidden" ? "Only you and your agents see them, and they never reach git." : "Plain Markdown in a folder, for you to commit and share."}</small>
            </div>
            {where === "project" ? <label className="ds-f"><span>Folder</span><input value={folder} onChange={(e) => setFolder(e.target.value)} /></label> : null}
            <div className="ds-do au-save">
              <button type="button" className="dg-send" disabled={where === "project" && !folder.trim()} onClick={() => { setChoosing(false); ask(outlinePrompt(where === "hidden" ? "hidden" : folder.trim()), "Asked the agent to read the project and propose the contents. It'll appear here."); }}>Start with the contents</button>
            </div>
          </div>
        </Dialog>
      ) : null}
    </div>
  );
}
