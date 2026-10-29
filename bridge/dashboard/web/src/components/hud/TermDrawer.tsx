import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ChevronDown, Maximize2, Minimize2 } from "lucide-react";
import { api, logStream, type DevServerInfo, type TermInfo, type Worktree } from "../../api";
import { useAiFeatures } from "../../lib/ai";
import { XtermPane } from "./XtermPane";

/* TERMINAL — the file window's drawer, under the code (it was a tab of the
   window until the window went full-bleed: .mystical/design-drafts/editor-window,
   option A). One head row holds what the tab spread over three: the terminals
   as tabs, +, the project's run command with RUN, and the dev server the
   bridge runs for it (a pill: click for its log, ■ stops it). The drawer's top
   edge drags; ⤢ gives it the whole column.

   Terminals are the bridge's PTYs (one list per project), so they outlive the
   window: closing it detaches, and the next open reconnects. With none open,
   the first show starts one on the checked-out branch. */

export function TermDrawer({ project, worktrees, branch, onCount, initialCommand, open, onHide }: {
  project: string; worktrees: Worktree[]; branch: string; onCount: (n: number) => void;
  /** Re-run from a transcript terminal block: typed into the first PTY that connects. */
  initialCommand?: string;
  open: boolean;
  onHide: () => void;
}) {
  // Consumed by the first pane that connects, then cleared so switching tabs or
  // opening another terminal doesn't run it again.
  const [preload, setPreload] = useState(initialCommand ?? "");
  const ai = useAiFeatures();   // GENERATE asks Claude — hidden while RUN COMMAND is off
  const [hov, setHov] = useState("");
  const hp = (k: string) => ({ onMouseEnter: () => setHov(k), onMouseLeave: () => setHov("") });

  const [terms, setTerms] = useState<TermInfo[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [newOpen, setNewOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState("");
  const [h, setH] = useState(290);
  const [max, setMax] = useState(false);
  const [showLog, setShowLog] = useState(false);

  const [runCmd, setRunCmd] = useState("");
  const [runSource, setRunSource] = useState("");
  const [detected, setDetected] = useState(false);
  const [genBusy, setGenBusy] = useState(false);
  const [runBusy, setRunBusy] = useState(false);

  // auto-detect the run command for this project
  useEffect(() => {
    let live = true;
    setRunCmd(""); setRunSource(""); setDetected(false);
    void api.detectRunCommand({ project })
      .then((r) => { if (live) { setRunCmd(r.command || ""); setRunSource(r.source || ""); setDetected(true); } })
      .catch(() => { if (live) setDetected(true); });
    return () => { live = false; };
  }, [project]);

  // reconnect to this project's persisted terminals — with none open, start one on
  // the checked-out branch (the main checkout) so the drawer lands on a live prompt
  const autoOpened = useRef("");
  useEffect(() => {
    let live = true;
    void api.terminals(project).then((d) => {
      if (!live) return;
      setTerms(d.terminals);
      setActiveId((cur) => (cur && d.terminals.some((t) => t.id === cur)) ? cur : (d.terminals[0]?.id ?? null));
      if (!d.terminals.length && autoOpened.current !== project) {
        autoOpened.current = project;
        void create(project);
      }
    }).catch(() => {});
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project]);

  useEffect(() => { onCount(terms.length); }, [terms, onCount]);

  /* The dev server this project runs — the same one the chat header's chip
     points at. Its log comes off the SSE stream every surface publishes to; the
     poll alone would drop everything between ticks. */
  const [srv, setSrv] = useState<DevServerInfo | null>(null);
  const [lines, setLines] = useState<string[]>([]);
  const logRef = useRef<HTMLDivElement>(null);
  const seeded = useRef<string | null>(null);
  useEffect(() => {
    let live = true;
    const tick = () => void api.servers()
      .then((d) => { if (live) setSrv(d.servers.find((x) => x.dir === project || x.project === project) ?? null); })
      .catch(() => { /* the bridge will be back */ });
    tick();
    const id = setInterval(tick, 3000);
    return () => { live = false; clearInterval(id); };
  }, [project]);
  const dir = srv?.dir ?? null;
  useEffect(() => {   // a different (or restarted) server starts its log over
    if (dir && seeded.current !== dir) { seeded.current = dir; setLines(srv?.tail ?? []); }
  }, [dir, srv]);
  useEffect(() => {
    if (!dir) return;
    return logStream((line, d) => { if (d === dir) setLines((p) => [...p, line].slice(-200)); });
  }, [dir]);
  useLayoutEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines, showLog]);

  const branchOf = (t: TermInfo): string => {
    const wt = worktrees.find((w) => w.rel && w.rel === t.cwd_rel);
    if (wt) return wt.branch;
    if (t.cwd_rel === project) return branch || "main";
    return t.cwd_rel.replace(/\/+$/, "").split("/").pop() || t.cwd_rel;
  };

  const removeTerm = (id: string) => {
    setTerms((prev) => {
      const next = prev.filter((t) => t.id !== id);
      setActiveId((cur) => (cur === id ? (next[next.length - 1]?.id ?? null) : cur));
      return next;
    });
  };

  async function create(cwdRel: string) {
    if (creating) return;
    setCreating(true); setError("");
    try {
      const r = await api.createTerminal(project, cwdRel, 80, 24);
      if (r.error || !r.id) { setError(r.error || "could not open terminal"); return; }
      const fresh: TermInfo = { id: r.id, project, cwd_rel: r.cwd_rel ?? cwdRel, cols: 80, rows: 24, created: Date.now() / 1000, alive: true, venv: r.venv };
      setTerms((prev) => [...prev, fresh]);
      setActiveId(r.id);
      setNewOpen(false);
      setShowLog(false);
    } catch (e) { setError((e as Error).message); }
    finally { setCreating(false); }
  }

  async function closeTerm(id: string) {
    try { await api.closeTerminal(id); } catch { /* already gone */ }
    removeTerm(id);
  }

  async function genRun() {
    if (genBusy) return;
    setGenBusy(true);
    try {
      const r = await api.detectRunCommand({ project });
      setRunCmd(r.command || "");
      setRunSource(r.source || "");
    } catch { /* ignore */ }
    finally { setGenBusy(false); }
  }

  async function runProject() {
    const cmd = runCmd.trim();
    if (!cmd || runBusy) return;
    setRunBusy(true);
    try {
      const r = await api.server("start", { cmd, project });
      if (r.message?.startsWith("❌")) setError(r.message);
    } catch (e) { setError((e as Error).message); }
    finally { setRunBusy(false); }
  }

  /* The top edge drags the drawer's height; double-click puts it back. Pointer
     capture keeps the drag alive over the buffer and the PTY canvas. */
  function onResizeDown(e: React.PointerEvent<HTMLDivElement>) {
    e.preventDefault();
    const el = e.currentTarget, y0 = e.clientY, h0 = h;
    el.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => setH(Math.min(window.innerHeight - 200, Math.max(120, h0 - (ev.clientY - y0))));
    const up = () => { el.removeEventListener("pointermove", move); el.removeEventListener("pointerup", up); };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
  }

  const wtOpts = worktrees.length
    ? worktrees.map((w) => ({ name: w.branch, rel: w.rel ?? project }))
    : [{ name: branch || "main", rel: project }];
  const srvLive = srv?.status === "running";
  const srvOn = !!srv && srv.status !== "not started";
  const sc = srvLive ? "var(--ok)" : "var(--err)";
  const mono = "'JetBrains Mono',monospace";
  const iconBtn = (k: string, title: string, on: () => void, glyph: React.ReactNode) => (
    <button key={k} onClick={on} title={title} aria-label={title} {...hp(k)}
      style={{ appearance: "none", cursor: "pointer", border: 0, background: hov === k ? "color-mix(in srgb, var(--acc) 8%, transparent)" : "transparent", color: hov === k ? "var(--txb)" : "var(--txm)", display: "flex", alignItems: "center", padding: "0 9px", flex: "none" }}>{glyph}</button>
  );

  return (
    <div data-r="term" style={{ display: open ? "flex" : "none", flexDirection: "column", position: "relative", flex: max ? "1 1 100%" : "none", height: max ? undefined : h, minHeight: 0, borderTop: "1px solid color-mix(in srgb, var(--acc) 28%, transparent)", background: "color-mix(in srgb, var(--panel3) 92%, transparent)" }}>
      {!max && <div onPointerDown={onResizeDown} onDoubleClick={() => setH(290)} title="drag to resize · double-click to reset" {...hp("rsz")}
        style={{ position: "absolute", top: -4, left: 0, right: 0, height: 7, zIndex: 6, cursor: "row-resize", background: hov === "rsz" ? "color-mix(in srgb, var(--acc) 35%, transparent)" : "transparent" }} />}
      {/* head: tabs · + · run · server · ⤢ ⌄ */}
      <div style={{ flex: "none", height: 31, display: "flex", alignItems: "stretch", borderBottom: "1px solid color-mix(in srgb, var(--acc) 12%, transparent)", background: "color-mix(in srgb, var(--panel2) 60%, transparent)", overflowX: "auto", overflowY: "hidden" }}>
        <span className="caps" style={{ display: "flex", alignItems: "center", padding: "0 12px", fontSize: "var(--t85)", letterSpacing: 1.5, color: "var(--txl)", flex: "none" }}>Terminal</span>
        {terms.map((t) => {
          const on = t.id === activeId && !showLog;
          return (
            <div key={t.id} onClick={() => { setActiveId(t.id); setShowLog(false); }} {...hp(`term:${t.id}`)}
              style={{ display: "flex", alignItems: "center", gap: 7, padding: "0 10px", cursor: "pointer", borderRight: "1px solid color-mix(in srgb, var(--acc) 10%, transparent)", borderTop: `2px solid ${on ? "var(--acc)" : "transparent"}`, background: on ? "color-mix(in srgb, var(--acc) 6%, transparent)" : hov === `term:${t.id}` ? "color-mix(in srgb, var(--acc) 5%, transparent)" : "transparent", flex: "none" }}>
              <span style={{ color: "var(--acc)", fontSize: "var(--t10)", flex: "none" }}>❯_</span>
              <span style={{ fontFamily: mono, fontSize: "var(--t105)", color: on ? "var(--txb)" : "var(--txd)", maxWidth: 150, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>⎇ {branchOf(t)}</span>
              {t.venv && (
                // The shell started activated — say so, or `python` being the
                // project's 3.12 instead of the system one is a mystery.
                <span title={`${t.venv} is activated in this shell`}
                  style={{ fontFamily: mono, fontSize: "var(--t85)", letterSpacing: ".5px", color: "var(--ok)", border: "1px solid color-mix(in srgb, var(--ok) 30%, transparent)", padding: "1px 4px", flex: "none" }}>
                  {t.venv}
                </span>
              )}
              <button onClick={(e) => { e.stopPropagation(); void closeTerm(t.id); }} title="close terminal" {...hp(`termx:${t.id}`)}
                style={{ appearance: "none", cursor: "pointer", border: 0, background: "transparent", color: hov === `termx:${t.id}` ? "var(--err)" : "var(--txd)", fontFamily: "inherit", fontSize: "var(--t12)", lineHeight: 1, padding: "0 2px", flex: "none" }}>✕</button>
            </div>
          );
        })}
        <button onClick={() => setNewOpen((o) => !o)} title="new terminal on a worktree" {...hp("termnew")}
          style={{ appearance: "none", cursor: "pointer", border: 0, background: hov === "termnew" || newOpen ? "color-mix(in srgb, var(--acc) 8%, transparent)" : "transparent", color: "var(--acc)", fontFamily: "inherit", fontSize: "var(--t15)", lineHeight: 1, padding: "0 12px", flex: "none" }}>+</button>
        <span style={{ width: 1, background: "color-mix(in srgb, var(--acc) 12%, transparent)", margin: "6px 6px", flex: "none" }} />
        {/* run project */}
        <div style={{ display: "flex", alignItems: "center", gap: 7, padding: "0 6px", flex: "none" }}>
          <span style={{ display: "flex", alignItems: "center", gap: 6, height: 21, border: "1px solid color-mix(in srgb, var(--acc) 16%, transparent)", background: "color-mix(in srgb, var(--panel3) 60%, transparent)", padding: "0 8px" }}>
            <span style={{ color: "var(--ok)", fontFamily: mono, fontSize: "var(--t10)" }}>$</span>
            <input value={runCmd} onChange={(e) => setRunCmd(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void runProject(); }}
              placeholder="command to run this project…" spellCheck={false}
              style={{ width: Math.min(260, Math.max(110, runCmd.length * 7.4 + 12)), background: "transparent", border: 0, outline: "none", color: "var(--txb)", fontFamily: mono, fontSize: "var(--t10)", padding: 0 }} />
            {runSource && <span title="auto-detected" style={{ fontFamily: mono, fontSize: "var(--t85)", color: "var(--txf)" }}>{runSource}</span>}
          </span>
          {ai.preview && detected && !runCmd && (
            <button onClick={() => void genRun()} title="complex project — let Claude generate the run command" {...hp("gen")}
              style={{ appearance: "none", cursor: "pointer", height: 21, border: "1px solid color-mix(in srgb, var(--purple) 40%, transparent)", background: hov === "gen" ? "color-mix(in srgb, var(--purple) 18%, transparent)" : "color-mix(in srgb, var(--purple) 8%, transparent)", color: "var(--purple-h)", fontFamily: "inherit", fontSize: "var(--t9)", letterSpacing: 1, padding: "0 9px", display: "flex", alignItems: "center", gap: 5 }}>
              <span style={{ color: "var(--purple)" }}>✦</span>{genBusy ? "THINKING…" : "GENERATE"}</button>
          )}
          <button onClick={() => void runProject()} title="run it — the bridge owns the server" {...hp("run")}
            style={{ appearance: "none", cursor: "pointer", height: 21, border: "1px solid var(--ok)", background: hov === "run" ? "color-mix(in srgb, var(--ok) 24%, transparent)" : "color-mix(in srgb, var(--ok) 14%, transparent)", color: "var(--txb)", fontFamily: "inherit", fontSize: "var(--t9)", letterSpacing: 1.5, padding: "0 10px", display: "flex", alignItems: "center", gap: 5, opacity: runBusy ? 0.6 : 1 }}>
            <span style={{ color: "var(--ok)" }}>▸</span>RUN</button>
          {srvOn && (
            <span onClick={() => setShowLog((v) => !v)} title={showLog ? "back to the terminal" : `${srv?.cmd ?? ""} — click for its log`} {...hp("srv")}
              style={{ display: "flex", alignItems: "center", gap: 6, height: 21, cursor: "pointer", border: `1px solid color-mix(in srgb, ${sc} ${showLog || hov === "srv" ? 55 : 26}%, transparent)`, background: showLog ? `color-mix(in srgb, ${sc} 10%, transparent)` : "transparent", padding: "0 8px", fontFamily: mono, fontSize: "var(--t95)" }}>
              <span style={{ width: 6, height: 6, borderRadius: "50%", background: sc, boxShadow: srvLive ? `0 0 7px ${sc}` : "none" }} />
              <span style={{ color: sc, letterSpacing: 1, fontSize: "var(--t8)" }}>{srvLive ? "RUNNING" : "EXITED"}</span>
              {srv?.url && (
                <a href={srv.url} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}
                  style={{ color: "var(--ok)", textDecoration: "none", borderBottom: "1px solid color-mix(in srgb, var(--ok) 40%, transparent)" }}>
                  {srv.url.replace(/^https?:\/\/(localhost|127\.0\.0\.1)/, "")} ↗</a>
              )}
              {srvLive && (
                <button onClick={(e) => { e.stopPropagation(); void api.server("stop", { project }).catch(() => {}); }} title="stop this server"
                  style={{ appearance: "none", cursor: "pointer", border: 0, background: "transparent", color: "var(--err)", fontSize: "var(--t9)", padding: 0, lineHeight: 1 }}>■</button>
              )}
            </span>
          )}
        </div>
        <span style={{ flex: 1 }} />
        {iconBtn("max", max ? "restore" : "fill the column", () => setMax((m) => !m), max ? <Minimize2 size={13} strokeWidth={1.8} /> : <Maximize2 size={13} strokeWidth={1.8} />)}
        {iconBtn("hide", "hide · Ctrl-`", onHide, <ChevronDown size={15} strokeWidth={1.8} />)}
      </div>
      {newOpen && (
        <div style={{ flex: "none", display: "flex", alignItems: "center", flexWrap: "wrap", gap: 6, padding: "7px 11px", borderBottom: "1px solid color-mix(in srgb, var(--acc) 10%, transparent)", background: "color-mix(in srgb, var(--purple) 4%, transparent)" }}>
          <span style={{ fontSize: "var(--t8)", letterSpacing: 1.5, color: "var(--purple-g)", flex: "none" }}>OPEN ON WORKTREE</span>
          {wtOpts.map((w) => (
            <button key={w.name} onClick={() => void create(w.rel)} {...hp(`wt:${w.name}`)}
              style={{ appearance: "none", cursor: "pointer", display: "flex", alignItems: "center", gap: 5, border: `1px solid ${hov === `wt:${w.name}` ? "var(--purple)" : "color-mix(in srgb, var(--purple) 30%, transparent)"}`, background: "color-mix(in srgb, var(--purple) 6%, transparent)", color: "var(--purple-h)", fontFamily: mono, fontSize: "var(--t95)", padding: "3px 8px" }}>
              <span style={{ color: "var(--purple)" }}>⎇</span>{w.name}</button>
          ))}
        </div>
      )}
      {error && (
        <div style={{ flex: "none", borderBottom: "1px solid color-mix(in srgb, var(--err) 30%, transparent)", background: "color-mix(in srgb, var(--err) 6%, transparent)", color: "var(--err)", fontSize: "var(--t105)", padding: "6px 11px", fontFamily: mono, display: "flex", gap: 8 }}>
          <span style={{ flex: 1 }}>{error}</span>
          <button onClick={() => setError("")} style={{ appearance: "none", cursor: "pointer", border: 0, background: "transparent", color: "var(--err)", padding: 0 }}>✕</button>
        </div>
      )}
      {showLog ? (
        <div ref={logRef} className="mscroll" style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "7px 12px", fontFamily: mono, fontSize: "var(--t95)", lineHeight: 1.55, color: "var(--txd)", whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
          {lines.length ? lines.join("\n") : "(no output yet)"}
        </div>
      ) : terms.length === 0 ? (
        <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", gap: 11 }}>
          <span style={{ fontSize: "var(--t11)", letterSpacing: 1.5, color: "var(--txl)" }}>{creating ? "OPENING A TERMINAL…" : "NO OPEN TERMINALS"}</span>
          {!creating && <button onClick={() => setNewOpen(true)} {...hp("emptynew")}
            style={{ appearance: "none", cursor: "pointer", border: "1px solid color-mix(in srgb, var(--acc) 30%, transparent)", background: hov === "emptynew" ? "color-mix(in srgb, var(--acc) 16%, transparent)" : "color-mix(in srgb, var(--acc) 6%, transparent)", color: "var(--tx)", fontFamily: "inherit", fontSize: "var(--t10)", letterSpacing: 1.5, padding: "6px 12px" }}>+ NEW TERMINAL</button>}
        </div>
      ) : (
        /* real PTY panes; all stay mounted so output keeps flowing, only the
           active one is visible */
        <div style={{ position: "relative", flex: 1, minHeight: 0 }}>
          {terms.map((t) => (
            <div key={t.id} style={{ position: "absolute", inset: "6px 8px", display: t.id === activeId ? "block" : "none" }}>
              <XtermPane id={t.id} active={open && t.id === activeId} onEnded={() => removeTerm(t.id)}
                preload={t.id === activeId ? preload : ""} onPreloaded={() => setPreload("")} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
