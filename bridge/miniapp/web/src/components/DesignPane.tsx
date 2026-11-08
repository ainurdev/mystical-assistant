import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Columns2, Eraser, MessageSquare, Monitor, MousePointer2, Pencil, Smartphone, SlidersHorizontal, Tablet, X } from "lucide-react";
import {
  ASPECTS, commentsMessage, frameDoc, remixMessage,
  type DesignBoard, type DesignComment,
} from "../lib/designframe";
import { designCall, uploadImage, useRefSession } from "../lib/readapi";
import { DesignSystem } from "./DesignSystem";

// The right half of the design-chat view (bridge/design_board.py): the page in its sandboxed frame
// (lib/designframe), the tools for pointing at it, and what you've said so far. It polls, so an
// agent's edits to the file appear on their own. Same file in both apps; each shell supplies
// onSend, and the chat beside it (dashboard) or behind it (phone).

type Tool = "cursor" | "comment" | "draw" | "tweak";
type Side = "comments" | "tweak" | "remix" | "critique" | "refs";
type Picked = { selector: string; about: string; styles: Record<string, string>; rect?: number[] };
type Editing = { comment: DesignComment; left: number; top: number; fresh: boolean };
type Critique = { state: string; error?: string; verdict?: string; scores?: Record<string, number>; fixes?: { where: string; fix: string }[] };
type Reference = { id: string; name: string; note?: string; url?: string; path?: string; style?: Record<string, unknown> };

const WIDTHS = { desktop: 0, tablet: 820, phone: 390 };
const TWEAKS: { prop: string; label: string; css: string; color?: boolean }[] = [
  { prop: "fontSize", label: "Size", css: "font-size" }, { prop: "fontWeight", label: "Weight", css: "font-weight" },
  { prop: "lineHeight", label: "Line height", css: "line-height" }, { prop: "letterSpacing", label: "Tracking", css: "letter-spacing" },
  { prop: "color", label: "Text", css: "color", color: true }, { prop: "backgroundColor", label: "Fill", css: "background-color", color: true },
  { prop: "padding", label: "Padding", css: "padding" }, { prop: "margin", label: "Margin", css: "margin" },
  { prop: "borderRadius", label: "Radius", css: "border-radius" }, { prop: "gap", label: "Gap", css: "gap" },
];
const toHex = (c: string) => {
  const m = c.match(/[\d.]+/g);
  if (!m || m.length < 3) return /^#[0-9a-f]{6}$/i.test(c) ? c : "#000000";
  return `#${m.slice(0, 3).map((v) => Math.round(+v).toString(16).padStart(2, "0")).join("")}`;
};
const newId = () => `c${Date.now()}${Math.floor(Math.random() * 1000)}`;

export function DesignPane({ board: boardId, onClose, onSend, chrome }: {
  board: string;
  onClose: () => void;
  /** Hand a message to the agent. Steers a running turn where the surface can. */
  onSend: (text: string) => Promise<string | void> | string | void;
  /** Anything the shell needs in the toolbar, like a window's own controls. */
  chrome?: ReactNode;
}) {
  const session = useRefSession();
  const [meta, setMeta] = useState<DesignBoard | null>(null);
  const [page, setPage] = useState("");
  const [html, setHtml] = useState<string | null>(null);
  const [hash, setHash] = useState("");
  const [version, setVersion] = useState(0);
  const [versions, setVersions] = useState<number[]>([]);
  const [comments, setComments] = useState<DesignComment[]>([]);
  const [missing, setMissing] = useState(false);
  const [error, setError] = useState("");
  const [tool, setTool] = useState<Tool>("cursor");
  const [width, setWidth] = useState<keyof typeof WIDTHS>("desktop");
  const [theme, setTheme] = useState("");
  const [side, setSide] = useState<Side | null>("comments");
  const [editing, setEditing] = useState<Editing | null>(null);
  const [note, setNote] = useState("");
  const [said, setSaid] = useState("");
  const [picked, setPicked] = useState<Picked & { x: number; y: number } | null>(null);
  const [vars, setVars] = useState<Record<string, string>>({});
  const [compareTo, setCompareTo] = useState<number | null>(null);
  const [before, setBefore] = useState<string | null>(null);
  const [split, setSplit] = useState(50);
  const [picks, setPicks] = useState<Record<string, string>>({});
  const [remixNote, setRemixNote] = useState("");
  const [critique, setCritique] = useState<Critique | null>(null);
  const [refs, setRefs] = useState<Reference[]>([]);
  const [refUrl, setRefUrl] = useState("");
  const frame = useRef<HTMLIFrameElement>(null);
  const beforeFrame = useRef<HTMLIFrameElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const scrollAt = useRef({ x: 0, y: 0 });
  const have = useRef("");
  const answered = useRef(0);
  const [silent, setSilent] = useState(false);

  const tell = useCallback((text: string) => {
    setSaid(text);
    window.setTimeout(() => setSaid((s) => (s === text ? "" : s)), 4000);
  }, []);
  const call = useCallback(<T,>(path: string, body: Record<string, unknown> = {}) => designCall<T>(session ?? "", path, { board: boardId, ...body }), [session, boardId]);

  // ---- the board, kept current ---------------------------------------------------------
  useEffect(() => {
    if (!session) return;
    let live = true;
    const tick = () => {
      call<DesignBoard & { comments: DesignComment[]; page?: string; html?: string; hash?: string; version?: number; versions?: number[]; missing?: boolean }>("design", { page: page || undefined, have: have.current })
        .then((r) => {
          if (!live) return;
          setError("");
          setMeta({ id: r.id, title: r.title, pages: r.pages, updated: r.updated });
          setComments(r.comments);
          setMissing(!!r.missing);
          if (r.page && !page) setPage(r.page);
          if (r.versions) setVersions(r.versions);
          if (r.version) setVersion(r.version);
          if (r.html !== undefined && r.hash) { have.current = r.hash; setHash(r.hash); setHtml(r.html); }
        }, (e) => { if (live) setError(e instanceof Error ? e.message : "Couldn't read the board."); });
    };
    tick();
    const t = window.setInterval(tick, 1500);
    return () => { live = false; window.clearInterval(t); };
  }, [session, call, page]);

  const doc = useMemo(() => (html === null ? "" : frameDoc(html)), [html]);
  const beforeDoc = useMemo(() => (before === null ? "" : frameDoc(before)), [before]);

  // ---- talking to the frame -------------------------------------------------------------
  const post = (m: Record<string, unknown>, to = frame.current) => to?.contentWindow?.postMessage({ mystical: 1, ...m }, "*");
  const mine = useMemo(() => comments.filter((c) => c.page === page), [comments, page]);
  const sendMarks = useCallback(() => {
    const marks = mine.filter((c) => c.kind !== "tweak").map((c, i) => ({ id: c.id, n: i + 1, x: c.x, y: c.y, points: c.points, sent: c.status === "sent" }));
    const tweaks = mine.filter((c) => c.kind === "tweak" && c.status !== "sent")
      .flatMap((c) => (c.changes ?? []).map((ch) => ({ selector: c.selector, prop: ch.prop, to: ch.to })));
    post({ t: "marks", marks, tweaks });
  }, [mine]);
  useEffect(sendMarks, [sendMarks]);
  useEffect(() => { post({ t: "tool", tool }); }, [tool]);
  useEffect(() => { post({ t: "theme", v: theme }); post({ t: "theme", v: theme }, beforeFrame.current); }, [theme]);

  const saveComment = useCallback(async (c: DesignComment) => {
    const r = await call<{ comments: DesignComment[] }>("design-comments", { put: c });
    setComments(r.comments);
  }, [call]);

  const openEditor = useCallback((comment: DesignComment, cx: number, cy: number, fresh: boolean) => {
    const box = frame.current?.getBoundingClientRect();
    const scale = box && frame.current ? box.width / (frame.current.offsetWidth || box.width) : 1;
    const left = Math.max(8, Math.min((box?.left ?? 0) + cx * scale + 10, window.innerWidth - 300));
    const top = Math.max(8, Math.min((box?.top ?? 0) + cy * scale + 10, window.innerHeight - 190));
    setEditing({ comment, left, top, fresh });
  }, []);

  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      const m = e.data as Record<string, unknown> & { el?: Picked };
      if (!m || m.mystical !== 1) return;
      if (e.source === beforeFrame.current?.contentWindow) {
        if (m.t === "ready") { post({ t: "theme", v: theme }, beforeFrame.current); post({ t: "scroll", ...scrollAt.current }, beforeFrame.current); }
        return;
      }
      if (e.source !== frame.current?.contentWindow) return;
      answered.current = Date.now();
      setSilent(false);
      if (m.t === "ready") {
        setVars((m.vars as Record<string, string>) ?? {});
        post({ t: "tool", tool });
        post({ t: "theme", v: theme });
        post({ t: "scroll", ...scrollAt.current });
        sendMarks();
      } else if (m.t === "scrolled") {
        scrollAt.current = { x: Number(m.x) || 0, y: Number(m.y) || 0 };
        post({ t: "scroll", ...scrollAt.current }, beforeFrame.current);
      } else if (m.t === "pick" && m.el) {
        openEditor({ id: newId(), kind: "comment", page, text: "", x: Number(m.x), y: Number(m.y), status: "open", selector: String(m.el.selector), about: String(m.el.about), styles: m.el.styles }, Number(m.cx), Number(m.cy), true);
      } else if (m.t === "stroke" && m.el) {
        const comment: DesignComment = { id: newId(), kind: "draw", page, text: "", x: Number(m.x), y: Number(m.y), status: "open", selector: String(m.el.selector), about: String(m.el.about), points: m.points as number[][] };
        // A drawing stands by itself: it's kept now, and its words are optional.
        void saveComment(comment);
        openEditor(comment, Number(m.cx), Number(m.cy), false);
      } else if (m.t === "mark") {
        const c = comments.find((x) => x.id === m.id);
        if (c) openEditor(c, Number(m.cx), Number(m.cy), false);
      } else if (m.t === "select" && m.el) {
        setPicked({ selector: String(m.el.selector), about: String(m.el.about), styles: m.el.styles, x: Number(m.x), y: Number(m.y) });
        setSide("tweak");
      } else if (m.t === "link") {
        const href = String(m.href ?? "");
        const hit = meta?.pages.find((p) => p.name === href || p.file.endsWith(href.replace(/^\.\//, "")));
        if (hit) goTo(hit.name); else tell(`That link goes to ${href.slice(0, 60)}, which isn't a page on this board.`);
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  });

  // A page that left for somewhere else stops answering.
  const loaded = () => {
    const at = Date.now();
    window.setTimeout(() => { if (answered.current < at) setSilent(true); }, 2500);
  };

  const goTo = (name: string) => {
    have.current = "";
    scrollAt.current = { x: 0, y: 0 };
    setHtml(null);
    setCompareTo(null);
    setPicked(null);
    setPage(name);
  };

  const finishEdit = async (text: string) => {
    if (!editing) return;
    const { comment, fresh } = editing;
    setEditing(null);
    if (fresh && !text.trim()) return;       // a click with no words is nothing; a drawing is kept already
    // Changing what you said makes it news again.
    await saveComment({ ...comment, text, status: comment.status === "sent" && text !== comment.text ? "open" : comment.status });
  };
  const dropComment = async (id: string) => {
    setEditing(null);
    const r = await call<{ comments: DesignComment[] }>("design-comments", { drop: id });
    setComments(r.comments);
  };

  // ---- saying it to the agent -----------------------------------------------------------
  const open = comments.filter((c) => c.status !== "sent");
  const send = async (text: string, ids: string[] = []) => {
    const out = await onSend(text);
    if (ids.length) {
      const r = await call<{ comments: DesignComment[] }>("design-comments", { sent: ids });
      setComments(r.comments);
    }
    tell(typeof out === "string" ? out : "Sent to the agent");
  };
  const sendComments = () => {
    if (!meta || !open.length) return;
    void send(commentsMessage(meta, comments, note), open.map((c) => c.id));
    setNote("");
  };

  // ---- tweak ----------------------------------------------------------------------------
  const tweak = (selector: string, about: string, css: string, from: string, to: string) => {
    post({ t: "style", selector, prop: css, value: to });
    const cur = comments.find((c) => c.kind === "tweak" && c.selector === selector && c.page === page && c.status !== "sent");
    const others = (cur?.changes ?? []).filter((ch) => ch.prop !== css);
    const first = (cur?.changes ?? []).find((ch) => ch.prop === css)?.from ?? from;
    void saveComment({
      id: cur?.id ?? newId(), kind: "tweak", page, text: cur?.text ?? "", x: picked?.x ?? 0, y: picked?.y ?? 0, status: "open",
      selector, about, changes: [...others, { prop: css, from: first, to }],
    });
  };

  // ---- before and after -----------------------------------------------------------------
  useEffect(() => {
    if (compareTo === null) { setBefore(null); return; }
    call<{ html: string }>("design-version", { page, version: compareTo }).then((r) => setBefore(r.html), () => setBefore(null));
  }, [compareTo, page, call]);

  // ---- critic and references ------------------------------------------------------------
  const askCritic = (fresh: boolean) => {
    call<Critique>("design-critique", { page, fresh }).then(setCritique, (e) => setCritique({ state: "failed", error: e instanceof Error ? e.message : "It failed." }));
  };
  useEffect(() => {
    if (critique?.state !== "running") return;
    const t = window.setInterval(() => askCritic(false), 3000);
    return () => window.clearInterval(t);
  });
  useEffect(() => {
    if (side !== "refs" || !session) return;
    call<{ references: Reference[] }>("design-references").then((r) => setRefs(r.references), () => undefined);
  }, [side, session, call]);
  const addRef = async (body: Record<string, unknown>) => {
    tell("Reading it…");
    try {
      const r = await call<{ references: Reference[] }>("design-reference", body);
      setRefs(r.references);
      setRefUrl("");
      tell("Kept as a reference");
    } catch (e) { tell(e instanceof Error ? e.message : "Couldn't read it."); }
  };
  const addRefImage = (file: File | undefined) => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      void uploadImage(session ?? "", String(reader.result)).then((path) => addRef({ image: path }), (e) => tell(e instanceof Error ? e.message : "Couldn't keep it."));
    };
    reader.readAsDataURL(file);
  };

  const current = meta?.pages.find((p) => p.name === page);
  const tools: { id: Tool; label: string; icon: ReactNode }[] = [
    { id: "cursor", label: "Use the page", icon: <MousePointer2 size={15} aria-hidden /> },
    { id: "comment", label: "Comment: click on something", icon: <MessageSquare size={15} aria-hidden /> },
    { id: "draw", label: "Draw: mark it, then add words if you like", icon: <Pencil size={15} aria-hidden /> },
    { id: "tweak", label: "Tweak: click on something, change its values", icon: <SlidersHorizontal size={15} aria-hidden /> },
  ];
  const tabs: { id: Side; label: string }[] = [
    { id: "comments", label: open.length ? `Comments ${open.length}` : "Comments" }, { id: "tweak", label: "Tweak" },
    ...(meta && meta.pages.length > 1 ? [{ id: "remix" as Side, label: "Remix" }] : []),
    { id: "critique", label: "Critique" }, { id: "refs", label: "Refs" },
  ];
  const w = WIDTHS[width];

  return (
    <section className="dg" aria-label="Design">
      <header className="dg-bar">
        <button type="button" className="dg-btn dg-close" title="Back to the chat" onClick={onClose}><X size={15} aria-hidden /><span>Close</span></button>
        <label className="dg-page">
          <span className="sr-only">Page</span>
          <select value={page} onChange={(e) => goTo(e.target.value)} aria-label="Page">
            {(meta?.pages ?? []).map((p) => <option key={p.name} value={p.name}>{p.name}{p.direction ? ` · ${p.direction}` : ""}</option>)}
          </select>
        </label>
        <div className="dg-group" role="radiogroup" aria-label="Tool">
          {tools.map((t) => (
            <button key={t.id} type="button" role="radio" aria-checked={tool === t.id} className="dg-btn" title={t.label} aria-label={t.label}
              onClick={() => { setTool(t.id); if (t.id === "tweak") setSide("tweak"); }}>{t.icon}</button>
          ))}
        </div>
        <div className="dg-group" role="radiogroup" aria-label="Width">
          {([["desktop", Monitor], ["tablet", Tablet], ["phone", Smartphone]] as const).map(([id, Icon]) => (
            <button key={id} type="button" role="radio" aria-checked={width === id} className="dg-btn" title={`${id[0].toUpperCase()}${id.slice(1)} width`} aria-label={`${id} width`} onClick={() => setWidth(id)}><Icon size={15} aria-hidden /></button>
          ))}
        </div>
        <select className="dg-theme" value={theme} onChange={(e) => setTheme(e.target.value)} aria-label="Colour scheme">
          <option value="">Page's theme</option><option value="light">Light</option><option value="dark">Dark</option>
        </select>
        <button type="button" className="dg-btn" aria-pressed={compareTo !== null} disabled={versions.length < 2}
          title={versions.length < 2 ? "Before and after: there's no earlier version yet" : "Before and after"}
          onClick={() => setCompareTo(compareTo === null ? versions[versions.length - 2] : null)}><Columns2 size={15} aria-hidden /></button>
        {compareTo !== null ? (
          <select value={compareTo} onChange={(e) => setCompareTo(Number(e.target.value))} aria-label="Compare with version">
            {versions.slice(0, -1).reverse().map((v) => <option key={v} value={v}>Version {v}</option>)}
          </select>
        ) : null}
        <span className="dg-live" title={current?.file}>{version ? `v${version}` : ""}</span>
        {said ? <span className="dg-said" role="status">{said}</span> : null}
        <span className="dg-grow" />
        {chrome}
      </header>
      <div className="dg-main">
        <div className="dg-stage" ref={stage}>
          {error ? <div className="dg-note">{error}</div> : null}
          {missing ? <div className="dg-note">This page's file is gone.</div> : null}
          {silent ? <div className="dg-note">The page stopped answering, so the tools can't reach it. It may have navigated away: switch pages to reload it.</div> : null}
          {!meta && !error ? <div className="dg-note">Opening…</div> : null}
          <div className="dg-sheet" style={w ? { width: w } : undefined}>
            {doc ? (
              <iframe ref={frame} key={`${page}`} title={page} className="dg-frame" sandbox="allow-scripts" srcDoc={doc} onLoad={loaded} data-hash={hash} />
            ) : null}
            {compareTo !== null && beforeDoc ? (
              <>
                <iframe ref={beforeFrame} title={`Version ${compareTo}`} className="dg-frame dg-before" sandbox="allow-scripts" srcDoc={beforeDoc} style={{ clipPath: `inset(0 ${100 - split}% 0 0)` }} />
                <div className="dg-split" style={{ left: `${split}%` }} aria-hidden />
                <span className="dg-tag" style={{ left: 8 }}>Version {compareTo}</span>
                <span className="dg-tag" style={{ right: 8 }}>Now</span>
                <input className="dg-slider" type="range" min={0} max={100} value={split} aria-label="Before and after" onChange={(e) => setSplit(Number(e.target.value))} />
              </>
            ) : null}
          </div>
        </div>
        {side ? (
          <aside className="dg-side">
            <div className="dg-tabs" role="tablist">
              {tabs.map((t) => <button key={t.id} type="button" role="tab" aria-selected={side === t.id} onClick={() => setSide(t.id)}>{t.label}</button>)}
              <button type="button" className="dg-hide" aria-label="Hide this panel" title="Hide this panel" onClick={() => setSide(null)}>×</button>
            </div>
            <div className="dg-panel">
              {side === "comments" ? (
                <>
                  {mine.length ? (
                    <ol className="dg-list">
                      {mine.map((c, i) => (
                        <li key={c.id} data-sent={c.status === "sent" || undefined}>
                          <button type="button" className="dg-item" onClick={() => {
                            const box = frame.current?.getBoundingClientRect();
                            setEditing({ comment: c, left: Math.max(8, (box?.right ?? 320) - 300), top: Math.min((box?.top ?? 60) + 40 + i * 8, window.innerHeight - 190), fresh: false });
                          }}>
                            <span className="dg-n">{c.kind === "tweak" ? "≈" : mine.filter((x) => x.kind !== "tweak").indexOf(c) + 1}</span>
                            <span className="dg-what">
                              {c.kind === "tweak" ? (c.changes ?? []).map((ch) => `${ch.prop}: ${ch.to}`).join("; ") : c.text || <em>Drawing, no words</em>}
                              {c.about ? <small>{c.about}</small> : null}
                              {c.status === "sent" ? <small>Sent</small> : null}
                            </span>
                          </button>
                          <button type="button" className="dg-drop" aria-label="Remove" title="Remove" onClick={() => void dropComment(c.id)}><Eraser size={13} aria-hidden /></button>
                        </li>
                      ))}
                    </ol>
                  ) : <p className="dg-empty">Pick the comment tool and click on the page, or draw on it. Nothing goes to the agent until you send it.</p>}
                  <textarea className="dg-note-in" rows={2} value={note} placeholder="Anything else to say with these" onChange={(e) => setNote(e.target.value)} />
                  <button type="button" className="dg-send" disabled={!open.length} onClick={sendComments}>{open.length ? `Send ${open.length} to the agent` : "Nothing new to send"}</button>
                </>
              ) : null}
              {side === "tweak" ? (
                <div className="dg-tweaks">
                  {picked ? (
                    <>
                      <p className="dg-about">{picked.about}</p>
                      {TWEAKS.map((t) => {
                        const value = picked.styles[t.prop] ?? "";
                        return (
                          <label key={t.css} className="dg-field">
                            <span>{t.label}</span>
                            {t.color
                              ? <input type="color" defaultValue={toHex(value)} key={`${picked.selector}${t.css}`} onChange={(e) => tweak(picked.selector, picked.about, t.css, value, e.target.value)} />
                              : <input type="text" defaultValue={value} key={`${picked.selector}${t.css}`} onBlur={(e) => { if (e.target.value !== value) tweak(picked.selector, picked.about, t.css, value, e.target.value); }} onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }} />}
                          </label>
                        );
                      })}
                    </>
                  ) : <p className="dg-empty">Pick the tweak tool and click on something. Your changes show at once and cost nothing, and they go to the agent as exact values with your comments.</p>}
                  {Object.keys(vars).length ? <h5>Page variables</h5> : null}
                  {Object.entries(vars).slice(0, 40).map(([name, value]) => (
                    <label key={name} className="dg-field">
                      <span title={name}>{name}</span>
                      {/^(#|rgb|hsl)/i.test(value) && /^#[0-9a-f]{6}$/i.test(value)
                        ? <input type="color" defaultValue={value} onChange={(e) => tweak(":root", "the page's variables", name, value, e.target.value)} />
                        : <input type="text" defaultValue={value} onBlur={(e) => { if (e.target.value !== value) tweak(":root", "the page's variables", name, value, e.target.value); }} />}
                    </label>
                  ))}
                </div>
              ) : null}
              {side === "remix" && meta ? (
                <div className="dg-remix">
                  <p className="dg-empty">Take each part from whichever direction has it right. Or go with one as it is:</p>
                  <div className="dg-pick">
                    {meta.pages.map((p) => <button key={p.name} type="button" className="dg-chip" onClick={() => void send(`Go with "${p.name}" on the board "${meta.title}" (board ${meta.id}). Take it further from there.`)}>{p.name}</button>)}
                  </div>
                  {ASPECTS.map((a) => (
                    <label key={a} className="dg-field">
                      <span>{a}</span>
                      <select value={picks[a] ?? ""} onChange={(e) => setPicks((x) => ({ ...x, [a]: e.target.value }))}>
                        <option value="">Up to the agent</option>
                        {meta.pages.map((p) => <option key={p.name} value={p.name}>{p.name}</option>)}
                      </select>
                    </label>
                  ))}
                  <textarea className="dg-note-in" rows={2} value={remixNote} placeholder="Anything else about the mix" onChange={(e) => setRemixNote(e.target.value)} />
                  <button type="button" className="dg-send" disabled={!Object.values(picks).some(Boolean)} onClick={() => void send(remixMessage(meta, picks, remixNote))}>Send the remix</button>
                </div>
              ) : null}
              {side === "critique" ? (
                <div className="dg-critic">
                  {!critique || critique.state === "failed" ? <p className="dg-empty">{critique?.error ?? "A separate model, which can only read, looks at this page on phone and desktop and scores it against your references. It takes a minute or two."}</p> : null}
                  {critique?.state === "running" ? <p className="dg-empty">Reviewing…</p> : null}
                  {critique?.state === "done" ? (
                    <>
                      <p className="dg-verdict">{critique.verdict}</p>
                      {Object.entries(critique.scores ?? {}).map(([k, v]) => (
                        <div key={k} className="dg-score"><span>{k}</span><span className="dg-track"><i style={{ width: `${Math.min(10, Number(v)) * 10}%` }} /></span><b>{v}</b></div>
                      ))}
                      <ol className="dg-fixes">{(critique.fixes ?? []).map((f, i) => <li key={i}><b>{f.where}</b> {f.fix}</li>)}</ol>
                      <button type="button" className="dg-send" onClick={() => void send(`An independent review of "${page}" on board ${boardId} said: ${critique.verdict}\n${(critique.fixes ?? []).map((f, i) => `${i + 1}. ${f.where}: ${f.fix}`).join("\n")}\nFix the ones you agree with, and say which you skipped.`)}>Send the fixes to the agent</button>
                    </>
                  ) : null}
                  <button type="button" className="dg-btn dg-wide" disabled={critique?.state === "running"} onClick={() => askCritic(true)}>{critique?.state === "done" ? "Review again" : "Review this page"}</button>
                </div>
              ) : null}
              {side === "refs" ? (
                <div className="dg-refs">
                  <form onSubmit={(e) => { e.preventDefault(); if (refUrl.trim()) void addRef({ url: refUrl.trim() }); }}>
                    <input type="url" value={refUrl} placeholder="A page you like: https://…" aria-label="Reference address" onChange={(e) => setRefUrl(e.target.value)} />
                    <button type="submit" className="dg-btn" disabled={!refUrl.trim()}>Read</button>
                  </form>
                  <label className="dg-btn dg-wide dg-file">Or keep a screenshot<input type="file" accept="image/*" onChange={(e) => addRefImage(e.target.files?.[0])} /></label>
                  {refs.length ? refs.map((r) => (
                    <div key={r.id} className="dg-ref">
                      <b>{r.name}</b>
                      {r.style ? <small>{Array.isArray(r.style.fonts) ? (r.style.fonts as string[]).slice(0, 3).join(", ") : ""}</small> : null}
                      <button type="button" className="dg-chip" onClick={() => void send(`Take direction from this reference for "${meta?.title}" (board ${boardId}): ${r.name}${r.url ? ` (${r.url})` : ""}${r.path ? `, screenshot at ${r.path}` : ""}.${r.style ? ` What it uses: ${JSON.stringify(r.style)}.` : ""} Use it as a direction, and don't copy its content or code.`)}>Design like this</button>
                    </div>
                  )) : <p className="dg-empty">Give it a page or a screenshot you like, and agents and the critic will have something real to go by.</p>}
                </div>
              ) : null}
            </div>
          </aside>
        ) : <button type="button" className="dg-show" onClick={() => setSide("comments")}>Comments{open.length ? ` ${open.length}` : ""}</button>}
      </div>
      {editing ? createPortal(<Editor key={editing.comment.id} editing={editing} onDone={finishEdit} onDrop={editing.fresh ? undefined : () => void dropComment(editing.comment.id)} />, document.body) : null}
    </section>
  );
}

function Editor({ editing, onDone, onDrop }: { editing: Editing; onDone: (text: string) => void | Promise<void>; onDrop?: () => void }) {
  const [text, setText] = useState(editing.comment.text);
  const c = editing.comment;
  return (
    <div className="dg-editor" role="dialog" aria-label="Comment" style={{ left: editing.left, top: editing.top }}>
      {c.about ? <small>{c.about}</small> : null}
      <textarea autoFocus rows={3} value={text} placeholder={c.kind === "draw" ? "Add words, or leave it as a drawing" : "What should change?"}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void onDone(text);
          if (e.key === "Escape") void onDone(editing.fresh ? "" : c.text);
        }} />
      <div>
        {onDrop ? <button type="button" className="dg-btn" onClick={onDrop}>Remove</button> : null}
        <span className="dg-grow" />
        <button type="button" className="dg-btn" onClick={() => void onDone(editing.fresh ? "" : c.text)}>Cancel</button>
        <button type="button" className="dg-send" onClick={() => void onDone(text)}>Save</button>
      </div>
    </div>
  );
}

/** A board in the chat: the button that opens it. */
export function DesignCard({ board, title, pages }: { board: string; title: string; pages: string[] }) {
  return (
    <div className="dg-card">
      <div className="dg-card-text">
        <b>{title}</b>
        <small>{pages.length > 1 ? `${pages.length} pages: ${pages.join(", ")}` : pages[0]}</small>
      </div>
      <button type="button" className="dg-send" onClick={() => window.dispatchEvent(new CustomEvent("mystical:design", { detail: { board } }))}>Preview design</button>
    </div>
  );
}

/** A project's boards: the design tab. */
export function DesignBoards({ onAsk, view }: { onAsk?: (text: string) => void; view?: (path: string, line?: number, at?: { x: number; y: number }) => void }) {
  const session = useRefSession();
  const [boards, setBoards] = useState<DesignBoard[] | null>(null);
  const [confirm, setConfirm] = useState("");
  const load = useCallback(() => {
    if (!session) { setBoards([]); return; }
    designCall<{ boards: DesignBoard[] }>(session, "design-boards").then((r) => setBoards(r.boards), () => setBoards([]));
  }, [session]);
  useEffect(load, [load]);
  return (
    <>
    <DesignSystem onAsk={onAsk} view={view} />
    <h4 className="dg-boards-h">Designs</h4>
    <div className="dg-boards">
      {boards && !boards.length ? <p className="dg-empty">No designs in this project yet. Ask an agent to design something, and its boards will be kept here.</p> : null}
      {(boards ?? []).map((b) => (
        <div key={b.id} className="dg-card">
          <div className="dg-card-text">
            <b>{b.title}</b>
            <small>{b.pages.length} {b.pages.length === 1 ? "page" : "pages"}{b.open ? `, ${b.open} unsent` : ""}</small>
          </div>
          <button type="button" className="dg-btn" onClick={() => window.dispatchEvent(new CustomEvent("mystical:design", { detail: { board: b.id } }))}>Open</button>
          {confirm === b.id ? (
            <button type="button" className="dg-btn dg-danger" onClick={() => { setConfirm(""); void designCall(session ?? "", "design-delete", { board: b.id }).then(load); }}>Really delete</button>
          ) : <button type="button" className="dg-btn" onClick={() => setConfirm(b.id)}>Delete</button>}
        </div>
      ))}
    </div>
    </>
  );
}
