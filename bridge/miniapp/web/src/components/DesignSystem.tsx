import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { FEELS, PAIRS, mix, sampleDoc, warnings, type Spec } from "../lib/designsystem";
import { frameDoc } from "../lib/designframe";
import { designCall, useRefSession } from "../lib/readapi";
import { FileRef } from "./FileRef";

// The top of the design tab (bridge/design_system.py): what this project has, and how to get a
// design system, by making one, linking one or importing one. Agents read the same things through
// design_context, so what's listed here is what they work from. Same file in both apps.

type System = { kind: string; name: string; path: string; note: string };
type Link = { id: string; name: string; source: string; url: boolean };
type Found = {
  systems: System[]; links: Link[]; css: { path: string; vars: number; lines: number }[]; css_total: number;
  components: { name: string; path: string }[]; components_total: number; tokens_total: number;
  colors: { name: string; value: string }[]; guess: { accent?: string; ground?: string; ink?: string; radius?: number; font?: string }; has_doc: boolean;
};
type Preview = { name: string; source: string; docs: string[]; tokens: number; components: number; files: number; url: boolean; colors: string[]; useful: boolean };

const KIND: Record<string, string> = { doc: "DOC", tailwind: "TW", shadcn: "UI", tokens: "TOK", storybook: "SB", skill: "SK", imported: "IMP", claude: "CD" };
const errorOf = (e: unknown) => (e instanceof Error ? e.message : "That didn't work.");

function Dialog({ title, onClose, children, wide }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  useEffect(() => {
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [onClose]);
  return createPortal(
    <div className="ds-back" onPointerDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="ds-dialog" data-wide={wide || undefined} role="dialog" aria-modal="true" aria-label={title}>
        <header><h3>{title}</h3><button type="button" className="dg-btn" onClick={onClose}>Close</button></header>
        {children}
      </div>
    </div>, document.body);
}

function Create({ session, guess, hasDoc, onDone, onClose }: { session: string; guess: Found["guess"]; hasDoc: boolean; onDone: (said: string) => void; onClose: () => void }) {
  const fromCode = !!(guess.accent || guess.ground);
  const [spec, setSpec] = useState<Spec>(() => {
    const base = FEELS.Calm;
    const pair = PAIRS.find((p) => p.id === base.pair)!;
    return { ...base, name: "", about: "", feel: [], avoid: "", heading: guess.font || pair.heading, body: guess.font || pair.body, size: 16,
      accent: guess.accent || base.accent, ground: guess.ground || base.ground, ink: guess.ink || base.ink, radius: guess.radius ?? base.radius };
  });
  const [replace, setReplace] = useState(false);
  const [error, setError] = useState("");
  const set = (patch: Partial<Spec>) => setSpec((s) => ({ ...s, ...patch }));
  const setPair = (id: string) => { const p = PAIRS.find((x) => x.id === id)!; set({ pair: id, heading: p.heading, body: p.body }); };
  const pickFeel = (name: string) => {
    const p = FEELS[name], f = PAIRS.find((x) => x.id === p.pair)!;
    setSpec((s) => ({ ...s, ...p, heading: f.heading, body: f.body, feel: [name.toLowerCase()] }));
  };
  // The quieter colours follow the three you choose, unless a starting point already set them.
  const setBase = (patch: Partial<Spec>) => setSpec((s) => {
    const n = { ...s, ...patch };
    return { ...n, muted: mix(n.ink, n.ground, 0.38), line: mix(n.ground, n.ink, 0.14), surface: mix(n.ground, n.ink, contrastDark(n.ground) ? 0.06 : 0) };
  });
  const problems = warnings(spec);
  const doc = useMemo(() => frameDoc(sampleDoc(spec)), [spec]);
  const save = async () => {
    setError("");
    try {
      await designCall(session, "design-system-create", { spec, replace });
      onDone("DESIGN.md is written. It's yours to commit, and agents read it from now on.");
    } catch (e) {
      if (/already has/.test(errorOf(e))) { setReplace(true); setError("This project already has a DESIGN.md. Press Replace to overwrite it."); }
      else setError(errorOf(e));
    }
  };
  return (
    <Dialog title="Create a design system" onClose={onClose} wide>
      <div className="ds-create">
        <div className="ds-form">
          {fromCode && !spec.feel.length ? <p className="ds-hint">Started from the colours already in this project's CSS.</p> : null}
          <label className="ds-f"><span>Name</span><input value={spec.name} placeholder="Morning Loaf" onChange={(e) => set({ name: e.target.value })} /></label>
          <label className="ds-f"><span>What it's for, in a line</span><input value={spec.about} placeholder="Ordering bread before you wake up" onChange={(e) => set({ about: e.target.value })} /></label>
          <div className="ds-f"><span>How should it feel?</span>
            <div className="ds-chips" role="group">
              {Object.keys(FEELS).map((n) => <button key={n} type="button" className="dg-chip" aria-pressed={spec.feel.includes(n.toLowerCase())} onClick={() => pickFeel(n)}>{n}</button>)}
            </div>
          </div>
          <div className="ds-f"><span>Colours</span>
            <div className="ds-colors">
              <label><input type="color" value={spec.accent} onChange={(e) => set({ accent: e.target.value })} />Accent</label>
              <label><input type="color" value={spec.ground} onChange={(e) => setBase({ ground: e.target.value })} />Background</label>
              <label><input type="color" value={spec.ink} onChange={(e) => setBase({ ink: e.target.value })} />Text</label>
            </div>
          </div>
          {problems.length ? <ul className="ds-warn" role="status">{problems.map((p) => <li key={p}>⚠ {p}</li>)}</ul> : null}
          <label className="ds-f"><span>Fonts</span>
            <select value={spec.pair} onChange={(e) => setPair(e.target.value)}>{PAIRS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}</select>
          </label>
          <div className="ds-two">
            <label className="ds-f"><span>Corners: {spec.radius}px</span><input type="range" min={0} max={24} value={spec.radius} onChange={(e) => set({ radius: Number(e.target.value) })} /></label>
            <label className="ds-f"><span>Text size: {spec.size}px</span><input type="range" min={13} max={19} value={spec.size} onChange={(e) => set({ size: Number(e.target.value) })} /></label>
          </div>
          <div className="ds-f"><span>Spacing</span>
            <div className="ds-chips" role="radiogroup">
              {(["tight", "regular", "roomy"] as const).map((d) => <button key={d} type="button" role="radio" aria-checked={spec.density === d} className="dg-chip" onClick={() => set({ density: d })}>{d[0].toUpperCase()}{d.slice(1)}</button>)}
            </div>
          </div>
          <label className="ds-f"><span>Anything to avoid? One per line</span><textarea rows={2} value={spec.avoid} placeholder="Purple gradients" onChange={(e) => set({ avoid: e.target.value })} /></label>
          {error ? <p className="ds-err" role="alert">{error}</p> : null}
          <div className="ds-actions">
            <button type="button" className="dg-send" disabled={!spec.name.trim()} onClick={() => void save()}>{replace ? "Replace DESIGN.md" : hasDoc ? "Write it (asks before replacing)" : "Write DESIGN.md"}</button>
            {!spec.name.trim() ? <small>Give it a name first.</small> : <small>It goes at the project's root, for you to commit.</small>}
          </div>
        </div>
        <iframe className="ds-sample" title="Preview" sandbox="allow-scripts" srcDoc={doc} />
      </div>
    </Dialog>
  );
}

const contrastDark = (hex: string) => parseInt(hex.slice(1, 3), 16) < 90;

function Bring({ session, onDone, onClose }: { session: string; onDone: (said: string) => void; onClose: () => void }) {
  const [source, setSource] = useState("");
  const [seen, setSeen] = useState<Preview | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const act = async (doing: string, f: () => Promise<void>) => {
    setBusy(doing);
    setError("");
    try { await f(); } catch (e) { setError(errorOf(e)); }
    setBusy("");
  };
  const check = () => void act("Looking…", async () => { setSeen(await designCall<Preview>(session, "design-system-preview", { source })); });
  return (
    <Dialog title="Link or import a design system" onClose={onClose}>
      <form className="ds-source" onSubmit={(e) => { e.preventDefault(); if (source.trim()) check(); }}>
        <label className="ds-f"><span>Where is it?</span><input value={source} autoFocus placeholder="A folder or file in your projects, or a web address" onChange={(e) => { setSource(e.target.value); setSeen(null); }} /></label>
        <button type="submit" className="dg-btn" disabled={!source.trim() || !!busy}>{busy || "Look"}</button>
      </form>
      {error ? <p className="ds-err" role="alert">{error}</p> : null}
      {seen ? (
        <>
          <div className="ds-seen">
            <b>{seen.name}</b>
            <span>{[seen.docs.length ? `${seen.docs.join(", ")}` : "", seen.tokens ? `${seen.tokens} variables` : "", seen.components ? `${seen.components} component${seen.components === 1 ? "" : "s"}` : "", seen.url ? "" : `${seen.files} file${seen.files === 1 ? "" : "s"}`].filter(Boolean).join(" · ")}</span>
            {seen.colors.length ? <div className="ds-swatches">{seen.colors.map((c) => <i key={c} title={c} style={{ background: c }} />)}</div> : null}
            {!seen.useful ? <p className="ds-err">There's no design document, tokens or components there.</p> : null}
          </div>
          <div className="ds-choice">
            <div>
              <h4>Link it</h4>
              <p>Nothing is added to this project. Agents read it from where it is{seen.url ? ", from a copy saved outside this project" : ", so its changes reach them"}.</p>
              <button type="button" className="dg-send" disabled={!seen.useful || !!busy} onClick={() => void act("Linking…", async () => { await designCall(session, "design-system-link", { source }); onDone(`Linked ${seen.name}. Nothing in this project changed.`); })}>Link</button>
            </div>
            <div>
              <h4>Import it</h4>
              <p>Copies it into <code>design-system/</code> in this project, for you to commit and change.</p>
              <button type="button" className="dg-btn" disabled={!seen.useful || !!busy} onClick={() => void act("Importing…", async () => { const r = await designCall<{ path: string; files: number }>(session, "design-system-import", { source }); onDone(`Imported ${r.files} ${r.files === 1 ? "file" : "files"} to ${r.path}.`); })}>Import</button>
            </div>
          </div>
        </>
      ) : null}
    </Dialog>
  );
}

const DRAFT = "Read design_context and this project's CSS and components, then write a short DESIGN.md at the project's root from what's really there: the tokens in use, type, spacing, what it should feel like and what to avoid. Show me what you found before writing it, and point out anything inconsistent.";

export function DesignSystem({ onAsk, view }: { onAsk?: (text: string) => void; view?: (path: string, line?: number, at?: { x: number; y: number }) => void }) {
  const session = useRefSession();
  const [found, setFound] = useState<Found | null>(null);
  const [error, setError] = useState("");
  const [said, setSaid] = useState("");
  const [dialog, setDialog] = useState<"create" | "bring" | null>(null);
  const [q, setQ] = useState("");
  const load = useCallback(() => {
    if (!session) return;
    designCall<Found>(session, "design-system").then((r) => { setFound(r); setError(""); }, (e) => setError(errorOf(e)));
  }, [session]);
  useEffect(load, [load]);
  const done = (text: string) => { setDialog(null); setSaid(text); load(); };
  const unlink = (id: string) => { void designCall(session ?? "", "design-system-unlink", { id }).then(load, (e) => setError(errorOf(e))); };
  const comps = useMemo(() => (found?.components ?? []).filter((c) => !q || c.name.toLowerCase().includes(q.toLowerCase())), [found, q]);
  if (!session) return <p className="dg-empty">Open a chat in a project to see its design system.</p>;
  if (error) return <p className="ds-err" role="alert">{error}</p>;
  if (!found) return <p className="dg-empty">Looking through this project…</p>;
  const none = !found.systems.length && !found.links.length;
  return (
    <div className="ds">
      <section>
        <h4 className="ds-h">Design system</h4>
        {none ? <p className="dg-empty">This project doesn't have one yet, so agents work from the CSS alone{found.tokens_total ? "" : ", and there's little of it to go on"}.</p> : null}
        <ul className="ds-list">
          {found.systems.map((s) => (
            <li key={`${s.kind}${s.path}`}>
              <span className="ds-tag">{KIND[s.kind] ?? "•"}</span>
              <span className="ds-what"><b>{s.path ? <FileRef address={s.path} md={s.path} onView={view}>{s.name}</FileRef> : s.name}</b><small>{s.note}</small></span>
            </li>
          ))}
          {found.links.map((l) => (
            <li key={l.id}>
              <span className="ds-tag">LINK</span>
              <span className="ds-what"><b>{l.name}</b><small title={l.source}>Linked, not in this project: {l.source}</small></span>
              <button type="button" className="dg-btn" onClick={() => unlink(l.id)}>Unlink</button>
            </li>
          ))}
        </ul>
        <div className="ds-do">
          <button type="button" className="dg-send" onClick={() => setDialog("create")}>Create</button>
          <button type="button" className="dg-btn" onClick={() => setDialog("bring")}>Link or import</button>
          {onAsk ? <button type="button" className="dg-btn" title="An agent reads the code and writes DESIGN.md from what's really there" onClick={() => { onAsk(DRAFT); setSaid("Asked the agent to draft one from the code."); }}>Draft from code</button> : null}
        </div>
        {said ? <p className="ds-said" role="status">{said}</p> : null}
      </section>
      {found.colors.length ? (
        <section>
          <h4 className="ds-h">Colours found</h4>
          <div className="ds-swatches">{found.colors.map((c) => <i key={c.name} title={`${c.name}: ${c.value}`} style={{ background: c.value }} />)}</div>
        </section>
      ) : null}
      <details className="ds-more">
        <summary>CSS files <span>{found.css_total}, {found.tokens_total} variables</span></summary>
        {found.css.length ? (
          <ul className="ds-files">
            {found.css.map((c) => <li key={c.path}><FileRef address={c.path} md={c.path} onView={view}><span className="ds-path" title={c.path}>{c.path}</span></FileRef><small>{c.vars ? `${c.vars} var${c.vars === 1 ? "" : "s"}` : `${c.lines} lines`}</small></li>)}
            {found.css_total > found.css.length ? <li><small>and {found.css_total - found.css.length} more</small></li> : null}
          </ul>
        ) : <p className="dg-empty">None found.</p>}
      </details>
      <details className="ds-more">
        <summary>Components <span>{found.components_total}</span></summary>
        {found.components.length > 12 ? <input className="ds-find" type="search" placeholder="Find a component" aria-label="Find a component" value={q} onChange={(e) => setQ(e.target.value)} /> : null}
        {found.components.length ? (
          <ul className="ds-files">
            {comps.map((c) => <li key={c.path}><FileRef address={c.path} md={c.path} onView={view}><span className="ds-path" title={c.path}>{c.name}</span></FileRef></li>)}
            {found.components_total > found.components.length && !q ? <li><small>and {found.components_total - found.components.length} more</small></li> : null}
          </ul>
        ) : <p className="dg-empty">None found.</p>}
      </details>
      {dialog === "create" ? <Create session={session} guess={found.guess} hasDoc={found.has_doc} onDone={done} onClose={() => setDialog(null)} /> : null}
      {dialog === "bring" ? <Bring session={session} onDone={done} onClose={() => setDialog(null)} /> : null}
    </div>
  );
}
