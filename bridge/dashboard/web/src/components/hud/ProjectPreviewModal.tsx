import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { composePrompt } from "@selector/composePrompt";
import type { Capture } from "@selector/protocol";
import { api, type DevServerInfo, type PreviewCtx } from "../../api";
import { projectTint } from "../../lib/surfaces";
import { SelectionTray } from "../design/SelectionTray";
import { useSelector } from "../design/useSelector";

/* PROJECT PREVIEW modal — matches the HUD design mock (hud.dc.html, the
   "PROJECT PREVIEW (viewport + docked run panel)" section, lines 1333-1505):
   a browser-chrome viewport on the left and a docked run panel on the right
   (SOURCE · RUN COMMAND · VIEWPORT · LOG·TAIL · status footer), with a
   maximize toggle + reload in the chrome.

   It reuses the same bridge dev-server registry RunningWindow drives:
   api.servers (poll), api.server start/stop (RUN / STOP / reload),
   api.detectPreview (the "LEARN" repo-scan), and api.projectSettings /
   setProjectSettings (the run command + deployed URL, persisted per project).
   The ⊕ chrome button toggles live element select (useSelector ↔ the
   mysticalSelector vite plugin's in-page agent): picks land in a tray in the
   docked panel and SEND composes them with an instruction and enqueues to the
   active session — the same queue path the composer uses to feed Claude. */

function basename(rel: string): string {
  const clean = rel.replace(/\/+$/, "");
  return clean.split("/").pop() || clean;
}

function safeHost(u: string): string {
  try { return new URL(u).host; } catch { return u.replace(/^https?:\/\//, ""); }
}

/** Short {tag,label} anchor for a selector capture, shown on the queue card. */
function anchorOf(c: Capture): { tag: string; label: string } {
  if (c.kind === "element") {
    const label = (c.text || "").trim().slice(0, 40) || c.selector || c.tag;
    return { tag: c.tag, label };
  }
  return { tag: "pin", label: `PIN (${Math.round(c.point.x)},${Math.round(c.point.y)})` };
}

/** Coerce a user-typed localhost value into a full URL. Accepts "localhost:5173",
 *  ":5173", "5173", "127.0.0.1:3000", or a full http(s) URL. */
function normalizeLocal(v: string): string | null {
  const s = v.trim();
  if (!s) return null;
  if (/^https?:\/\//i.test(s)) return s;
  if (/^:\d+$/.test(s)) return `http://localhost${s}`;
  if (/^\d+$/.test(s)) return `http://localhost:${s}`;
  return `http://${s}`;
}

/** Colour a dev-server log line by its content (mirrors RunningWindow's tail). */
function logColor(line: string): string {
  const l = line.toLowerCase();
  if (/\b(error|err!|fail|failed|cannot|exception)\b/.test(l)) return "var(--err)";
  if (/\b(warn|warning|deprecat)\b/.test(l)) return "var(--warn)";
  if (/(ready|compiled|success|✓|➜|local:|listening|started)/.test(l)) return "var(--ok)";
  return "var(--txm)";
}

// Viewport widths for the responsive frame (FULL fills the pane; the others
// centre a device-width frame with side rails).
const VIEWPORTS = [
  { key: "full", label: "FULL", w: "100%" },
  { key: "tablet", label: "TABLET", w: 834 },
  { key: "phone", label: "PHONE", w: 414 },
] as const;
type Vw = (typeof VIEWPORTS)[number]["key"];

const SECTION_PAD = "13px 14px";
const labelStyle: React.CSSProperties = { fontSize: 9, letterSpacing: 2, color: "var(--txl)" };

/** SOURCE / VIEWPORT option button (mock: grid of segmented buttons). */
function optBtn(active: boolean): React.CSSProperties {
  return {
    appearance: "none", cursor: "pointer", fontFamily: "inherit", textAlign: "center",
    padding: "6px 0", fontSize: 9, letterSpacing: 1.5,
    border: `1px solid ${active ? "color-mix(in srgb, var(--acc) 55%, transparent)" : "color-mix(in srgb, var(--acc) 16%, transparent)"}`,
    background: active ? "color-mix(in srgb, var(--acc) 12%, transparent)" : "transparent",
    color: active ? "var(--txb)" : "var(--txm)",
  };
}

export function ProjectPreviewModal({ project, sessionId, onClose }: {
  project: string;
  sessionId: string | null;
  onClose: () => void;
}) {
  const [servers, setServers] = useState<DevServerInfo[]>([]);
  const [source, setSource] = useState<"localhost" | "deployed">("localhost");
  const [cmd, setCmd] = useState("");
  const [placeholder, setPlaceholder] = useState("npm run dev");
  const [prodUrl, setProdUrl] = useState("");
  const [busyRun, setBusyRun] = useState(false);
  const [learning, setLearning] = useState(false);
  const [full, setFull] = useState(true); // open maximized (near-fullscreen) by default
  const [vw, setVw] = useState<Vw>("full");
  const [infoHover, setInfoHover] = useState(false);
  // element select → send: instruction + send lifecycle for the SELECT panel
  const [instruction, setInstruction] = useState("");
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [sendErr, setSendErr] = useState<string | null>(null);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  // Editable localhost target: `localInput` is the field text, `localApplied` the
  // committed URL used for the preview — persisted per-project so a server you
  // started yourself (outside the bridge) sticks across reopens.
  const [localInput, setLocalInput] = useState("");
  const [localApplied, setLocalApplied] = useState("");
  const learnedRef = useRef(false);
  const localKey = `mystical:preview-local:${project}`;

  const apiCtx = useMemo<PreviewCtx>(() => ({ project }), [project]);
  const tint = projectTint(project);
  const name = basename(project);

  // This project's dev server (by canonical project rel).
  const server = servers.find((s) => s.project === project) ?? null;
  const status = server?.status ?? "not started";
  const running = status === "running";
  const detectedUrl = server?.url ?? null;
  // A manually-entered localhost wins over the bridge-detected one (point at a
  // server you started yourself, outside the bridge's registry).
  const localhostUrl = normalizeLocal(localApplied) ?? detectedUrl;
  const activeUrl = source === "localhost" ? localhostUrl : (prodUrl.trim() || null);

  // Live element selector — the in-page agent is injected by the mysticalSelector
  // vite plugin (dev-only), so it works against localhost, not deployed builds.
  const selectorOrigin = useMemo(() => {
    if (source !== "localhost" || !activeUrl) return null;
    try { return new URL(activeUrl).origin; } catch { return null; }
  }, [source, activeUrl]);
  const sel = useSelector(iframeRef, selectorOrigin);
  const selecting = sel.state.mode === "select";

  // Waking = we asked to start (or it's up) but no localhost URL yet.
  const booting = source === "localhost" && (busyRun || (running && !localhostUrl)) && !activeUrl;
  const showApp = !!activeUrl;
  const showEnter = !showApp && source === "deployed";
  const showBoot = !showApp && booting;
  const showSleep = !showApp && !showBoot && source === "localhost";

  // --- API wiring (mirrors RunningWindow's sequences) ---
  const save = useCallback(async (over?: { cmd?: string; prodUrl?: string }) => {
    await api.setProjectSettings(apiCtx, {
      run_cmd: over?.cmd ?? cmd, prod_url: over?.prodUrl ?? prodUrl,
    }).catch(() => {});
  }, [apiCtx, cmd, prodUrl]);

  const start = useCallback(async (over?: string) => {
    setBusyRun(true);
    try {
      const runCmd = over ?? cmd;
      await save({ cmd: runCmd });
      const r = await api.server("start", { cmd: runCmd, ...apiCtx });
      setServers(r.servers ?? []);
      setSource("localhost");
    } catch { /* surfaced via the exited/tail state */ } finally { setBusyRun(false); }
  }, [apiCtx, cmd, save]);

  const stop = useCallback(async () => {
    setBusyRun(true);
    try { const r = await api.server("stop", apiCtx); setServers(r.servers ?? []); }
    catch { /* ignore */ } finally { setBusyRun(false); }
  }, [apiCtx]);

  const reload = useCallback(async () => {
    setBusyRun(true);
    try {
      await api.server("stop", apiCtx).catch(() => {});
      const r = await api.server("start", { cmd, ...apiCtx });
      setServers(r.servers ?? []);
    } catch { /* ignore */ } finally { setBusyRun(false); }
  }, [apiCtx, cmd]);

  const learn = useCallback(async (autorun: boolean) => {
    setLearning(true);
    try {
      const r = await api.detectPreview(apiCtx);
      if (r.command) { setCmd(r.command); if (autorun) await start(r.command); }
    } catch { /* ignore */ } finally { setLearning(false); }
  }, [apiCtx, start]);

  const connect = useCallback(() => {
    if (!prodUrl.trim()) return;
    void save({ prodUrl });
    setSource("deployed");
  }, [prodUrl, save]);

  // Load per-project settings on open; auto-learn the command once if unset.
  useEffect(() => {
    let live = true;
    learnedRef.current = false;
    api.projectSettings(apiCtx).then((s) => {
      if (!live) return;
      setPlaceholder(s.default_cmd || "npm run dev");
      setProdUrl(s.prod_url ?? "");
      if (s.run_cmd) setCmd(s.run_cmd);
      else if (!learnedRef.current) { learnedRef.current = true; void learn(false); }
    }).catch(() => {});
    return () => { live = false; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiCtx]);

  // Poll running dev servers (URL detection + external stops).
  useEffect(() => {
    let live = true;
    const tick = async () => {
      try { const r = await api.servers(); if (live) setServers(r.servers); } catch { /* ignore */ }
    };
    void tick();
    const id = setInterval(tick, 2500);
    return () => { live = false; clearInterval(id); };
  }, []);

  // Load the saved manual localhost for this project; seed the field with the
  // detected URL until you override it.
  useEffect(() => {
    let saved = "";
    try { saved = localStorage.getItem(localKey) ?? ""; } catch { /* ignore */ }
    setLocalApplied(saved);
    setLocalInput(saved || (detectedUrl ? detectedUrl.replace(/^https?:\/\//, "") : ""));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [localKey]);
  useEffect(() => {
    if (!localApplied && !localInput && detectedUrl) setLocalInput(detectedUrl.replace(/^https?:\/\//, ""));
  }, [detectedUrl, localApplied, localInput]);

  // Commit the typed localhost (Enter / blur) and remember it per project.
  const applyLocal = (v: string) => {
    const t = v.trim();
    setLocalApplied(t);
    try { if (t) localStorage.setItem(localKey, t); else localStorage.removeItem(localKey); } catch { /* ignore */ }
  };

  // --- derived chrome / footer status ---
  const live = !!activeUrl;
  const chromeUrl = activeUrl
    ? activeUrl.replace(/^https?:\/\//, "")
    : source === "localhost" ? "localhost:—" : "no target set";
  const st = showApp
    ? { tag: "LIVE", color: "var(--ok)", foot: "connected — live preview" }
    : booting
      ? { tag: "BOOT", color: "var(--warn)", foot: "waking the dev server…" }
      : status === "exited"
        ? { tag: "EXIT", color: "var(--err)", foot: "dev server exited — check the command" }
        : source === "deployed"
          ? { tag: "IDLE", color: "var(--txl)", foot: "no target connected" }
          : { tag: "IDLE", color: "var(--txl)", foot: "server sleeping" };
  const portLabel = source === "localhost" && server?.port ? `:${server.port}`
    : activeUrl ? safeHost(activeUrl) : "—";
  const tail = (server?.tail ?? []).slice(-6);
  const frameW = VIEWPORTS.find((v) => v.key === vw)?.w ?? "100%";
  const framed = vw !== "full";
  const captureWidth = typeof frameW === "number" ? frameW : 1280;

  // Compose the selected elements + instruction into a prompt and enqueue it to
  // the active session, with a screenshot for visual context when available.
  const canSend = !!sessionId && !sending && sel.state.items.length > 0;
  const send = async () => {
    if (!canSend) return;
    setSending(true);
    setSendErr(null);
    try {
      const items = sel.state.items;
      const instr = instruction.trim() || "Please address the notes on the selected elements.";
      const prompt = composePrompt({ project, width: captureWidth, items, instruction: instr });
      let images: string[] = [];
      try {
        if (activeUrl) {
          const shot = await api.screenshot(captureWidth, activeUrl, apiCtx);
          if (shot.data_url) images = [shot.data_url];
        }
      } catch { /* text-only fallback */ }
      await api.queueEnqueue({
        session_id: sessionId!, surface: "dashboard",
        text: instruction.trim(), prompt, images,
        sel: items.map((it) => anchorOf(it.capture)), width: captureWidth, project,
      });
      sel.clear();
      setInstruction("");
      setSent(true);
      setTimeout(() => setSent(false), 1200);
    } catch {
      setSendErr("failed to send — the session queue rejected it");
    } finally {
      setSending(false);
    }
  };

  const iconBtn: React.CSSProperties = {
    appearance: "none", cursor: "pointer", border: "1px solid color-mix(in srgb, var(--acc) 25%, transparent)",
    background: "transparent", color: "var(--txm)", fontFamily: "inherit", fontSize: 11, padding: "5px 9px",
    flex: "none", lineHeight: 1,
  };

  return (
    <div onClick={onClose}
      style={{ position: "fixed", inset: 0, background: "color-mix(in srgb, var(--panel3) 80%, transparent)", zIndex: 95,
        display: "flex", alignItems: "center", justifyContent: "center", padding: full ? "2vh 2vw" : "4vh 3vw",
        animation: "backdropIn .2s ease both", transition: "padding .38s cubic-bezier(.25,.9,.25,1)" }}>
      <div onClick={(e) => e.stopPropagation()} data-screen-label="project preview"
        style={{ width: full ? "96vw" : 1180, maxWidth: full ? "96vw" : "95vw", height: full ? "94vh" : 720,
          maxHeight: full ? "94vh" : "88vh",
          transition: "width .38s cubic-bezier(.25,.9,.25,1),height .38s cubic-bezier(.25,.9,.25,1),max-width .38s cubic-bezier(.25,.9,.25,1),max-height .38s cubic-bezier(.25,.9,.25,1)",
          display: "flex", flexDirection: "column", border: "1px solid color-mix(in srgb, var(--acc) 40%, transparent)",
          background: "#0a1113", boxShadow: "0 0 70px rgba(0,0,0,.85)", animation: "mslide .2s ease both", overflow: "hidden" }}>

        {/* chrome bar */}
        <div style={{ flex: "none", display: "flex", alignItems: "center", gap: 11, padding: "9px 13px",
          background: "color-mix(in srgb, var(--panel2) 90%, transparent)", borderBottom: "1px solid color-mix(in srgb, var(--acc) 16%, transparent)" }}>
          <span style={{ display: "flex", gap: 6, flex: "none" }}>
            <span style={{ width: 11, height: 11, borderRadius: "50%", background: "var(--err)" }} />
            <span style={{ width: 11, height: 11, borderRadius: "50%", background: "var(--warn)" }} />
            <span style={{ width: 11, height: 11, borderRadius: "50%", background: "var(--ok)" }} />
          </span>
          <span title={name} style={{ fontSize: 8, letterSpacing: 1, color: tint.color, border: `1px solid ${tint.border}`, padding: "1px 5px", flex: "none" }}>{tint.tag}</span>
          <div style={{ flex: 1, display: "flex", alignItems: "center", gap: 8, background: "color-mix(in srgb, var(--panel3) 60%, transparent)",
            border: "1px solid color-mix(in srgb, var(--acc) 14%, transparent)", padding: "5px 11px", minWidth: 0 }}>
            <span style={{ width: 6, height: 6, borderRadius: "50%", flex: "none",
              background: live ? "var(--ok)" : "var(--txl)", animation: live ? "mpulse 2.4s infinite" : undefined }} />
            <span style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--txm)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{chromeUrl}</span>
            <span style={{ flex: 1 }} />
            <span style={{ fontSize: 8, letterSpacing: 1, color: st.color, border: `1px solid ${st.color}`, padding: "1px 5px", flex: "none" }}>{st.tag}</span>
          </div>
          <button onClick={() => setFull((v) => !v)} title={full ? "restore size" : "maximize"} style={iconBtn}
            onMouseEnter={(e) => (e.currentTarget.style.background = "color-mix(in srgb, var(--acc) 8%, transparent)")}
            onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}>{full ? "⤡" : "⤢"}</button>
          {showApp && (
            <button onClick={() => sel.setMode(selecting ? "idle" : "select")} disabled={!selectorOrigin}
              title={!selectorOrigin ? "element select needs the localhost dev server"
                : selecting ? "exit element select" : "select elements in the live preview & send to Claude"}
              style={{ ...iconBtn, fontSize: 9.5, letterSpacing: 1.5, padding: "6px 11px", opacity: selectorOrigin ? 1 : 0.4,
                color: selecting ? "var(--acc)" : "var(--txm)",
                borderColor: selecting ? "color-mix(in srgb, var(--acc) 55%, transparent)" : "color-mix(in srgb, var(--acc) 25%, transparent)",
                background: selecting ? "color-mix(in srgb, var(--acc) 10%, transparent)" : "transparent" }}
              onMouseEnter={(e) => { if (!selecting) e.currentTarget.style.background = "color-mix(in srgb, var(--acc) 8%, transparent)"; }}
              onMouseLeave={(e) => { if (!selecting) e.currentTarget.style.background = "transparent"; }}>{selecting ? "◉ SELECTING" : "⊕ SELECT"}</button>
          )}
          <button onClick={() => void reload()} title="restart the dev server" style={iconBtn} disabled={busyRun}
            onMouseEnter={(e) => (e.currentTarget.style.background = "color-mix(in srgb, var(--acc) 8%, transparent)")}
            onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}>↻</button>
          <button onClick={onClose} title="close preview"
            style={{ ...iconBtn, fontSize: 9.5, letterSpacing: 1.5, padding: "6px 11px" }}
            onMouseEnter={(e) => (e.currentTarget.style.background = "color-mix(in srgb, var(--acc) 8%, transparent)")}
            onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}>ESC ✕</button>
        </div>

        {/* body: viewport + docked panel */}
        <div style={{ flex: 1, minHeight: 0, display: "flex" }}>

          {/* viewport */}
          <div style={{ flex: 1, minWidth: 0, position: "relative", overflow: "hidden",
            background: "radial-gradient(120% 100% at 50% 0%, color-mix(in srgb, var(--acc) 5%, transparent), transparent 60%), #0a1113" }}>
            {showApp ? (
              <div style={{ position: "absolute", inset: 0, display: "flex", justifyContent: "center" }}>
                <div style={{ width: frameW, maxWidth: "100%", height: "100%", transition: "width .35s ease",
                  borderLeft: framed ? "1px solid color-mix(in srgb, var(--acc) 18%, transparent)" : "none",
                  borderRight: framed ? "1px solid color-mix(in srgb, var(--acc) 18%, transparent)" : "none" }}>
                  <iframe ref={iframeRef} src={activeUrl!} title="project preview"
                    style={{ width: "100%", height: "100%", border: 0, background: "#fff", display: "block" }} />
                </div>
              </div>
            ) : showBoot ? (
              <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 14 }}>
                <svg viewBox="0 0 100 100" style={{ width: 26, height: 26, overflow: "visible" }}>
                  <circle cx="50" cy="50" r="40" fill="none" stroke="var(--acc)" strokeWidth="4" strokeDasharray="7 11"
                    style={{ transformOrigin: "50px 50px", animation: "introspin 1.6s linear infinite" }} />
                </svg>
                <span style={{ fontFamily: "var(--mono)", fontSize: 11.5, color: "var(--txh)" }}>$ {cmd || placeholder}</span>
                <span style={{ fontSize: 9.5, letterSpacing: 1.5, color: "var(--txd)" }}>waking the dev server…</span>
              </div>
            ) : showEnter ? (
              <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", padding: 30, textAlign: "center" }}>
                <span style={{ fontSize: 12, fontStyle: "italic", color: "var(--txd)" }}>no target connected — enter the deployed domain in the panel →</span>
              </div>
            ) : (
              // sleep
              <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 16 }}>
                <span style={{ fontSize: 12, fontStyle: "italic", color: "var(--txd)", letterSpacing: ".4px" }}>the server sleeps — press RUN, or paste a localhost URL in the panel →</span>
                <button onClick={() => void start()} disabled={busyRun}
                  style={{ appearance: "none", cursor: "pointer", fontFamily: "inherit", border: "1px solid color-mix(in srgb, var(--ok) 40%, transparent)",
                    background: "color-mix(in srgb, var(--ok) 7%, transparent)", color: "var(--ok)", fontSize: 10, letterSpacing: 2, padding: "7px 18px", opacity: busyRun ? 0.5 : 1 }}>RUN ▸</button>
              </div>
            )}
          </div>

          {/* docked right panel */}
          <div style={{ flex: "none", width: 256, display: "flex", flexDirection: "column", minHeight: 0,
            borderLeft: "1px solid color-mix(in srgb, var(--acc) 16%, transparent)", background: "color-mix(in srgb, var(--panel2) 92%, transparent)" }}>
            <div className="mscroll" style={{ flex: 1, overflowY: "auto", minHeight: 0, display: "flex", flexDirection: "column" }}>

              {/* SOURCE */}
              <div style={{ flex: "none", padding: SECTION_PAD, borderBottom: "1px solid color-mix(in srgb, var(--acc) 10%, transparent)", display: "flex", flexDirection: "column", gap: 9 }}>
                <span style={labelStyle}>SOURCE</span>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
                  <button onClick={() => setSource("localhost")} style={optBtn(source === "localhost")}>LOCAL</button>
                  <button onClick={() => setSource("deployed")} style={optBtn(source === "deployed")}>DEPLOYED</button>
                </div>
                {source === "localhost" ? (
                  <>
                    <div style={{ display: "flex", gap: 6 }}>
                      <input value={localInput} onChange={(e) => setLocalInput(e.target.value)}
                        onKeyDown={(e) => { if (e.key === "Enter") applyLocal(localInput); }} onBlur={() => applyLocal(localInput)}
                        placeholder="localhost:5173" spellCheck={false} title="URL your app is already serving on — press Enter to preview it"
                        style={{ appearance: "none", flex: 1, minWidth: 0, background: "color-mix(in srgb, var(--panel3) 70%, transparent)",
                          border: "1px solid color-mix(in srgb, var(--acc) 16%, transparent)", color: "var(--txh)", fontFamily: "var(--mono)", fontSize: 11, padding: "7px 9px", outline: "none" }} />
                      <button title="open in a new tab" disabled={!localhostUrl} onClick={() => localhostUrl && window.open(localhostUrl, "_blank")}
                        style={{ appearance: "none", cursor: localhostUrl ? "pointer" : "default", border: "1px solid color-mix(in srgb, var(--acc) 20%, transparent)",
                          background: "transparent", color: "var(--txd)", fontFamily: "inherit", fontSize: 11, width: 30, flex: "none", opacity: localhostUrl ? 1 : 0.4 }}>↗</button>
                    </div>
                    <span style={{ fontSize: 9, color: "var(--txf)", lineHeight: 1.5 }}>already running it in your terminal? paste the localhost URL — RUN below is only for letting the bridge start it.</span>
                  </>
                ) : (
                  <>
                    <div style={{ display: "flex", gap: 6 }}>
                      <input value={prodUrl} onChange={(e) => setProdUrl(e.target.value)} onKeyDown={(e) => e.key === "Enter" && connect()}
                        placeholder="https://app.yourdomain.com" spellCheck={false}
                        style={{ appearance: "none", flex: 1, minWidth: 0, background: "color-mix(in srgb, var(--panel3) 70%, transparent)",
                          border: "1px solid color-mix(in srgb, var(--acc) 16%, transparent)", color: "var(--txh)", fontFamily: "var(--mono)", fontSize: 11, padding: "7px 9px", outline: "none" }} />
                      <button onClick={connect} title="connect to this domain"
                        style={{ appearance: "none", cursor: "pointer", border: "1px solid color-mix(in srgb, var(--info) 35%, transparent)",
                          background: "transparent", color: "var(--info)", fontFamily: "inherit", fontSize: 9, letterSpacing: 1.5, padding: "0 10px", flex: "none" }}>GO</button>
                    </div>
                    <span style={{ fontSize: 9, color: "var(--txf)", lineHeight: 1.5 }}>point at any deployed build — nothing runs locally.</span>
                  </>
                )}
              </div>

              {/* RUN COMMAND (localhost only) */}
              {source === "localhost" && (
                <div style={{ flex: "none", position: "relative", padding: SECTION_PAD, borderBottom: "1px solid color-mix(in srgb, var(--acc) 10%, transparent)", display: "flex", flexDirection: "column", gap: 9 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
                    <span style={labelStyle}>RUN COMMAND</span>
                    <span style={{ flex: 1 }} />
                    <span onMouseEnter={() => setInfoHover(true)} onMouseLeave={() => setInfoHover(false)}
                      style={{ width: 15, height: 15, border: "1px solid color-mix(in srgb, var(--purple) 35%, transparent)", borderRadius: "50%",
                        color: "var(--purple-h)", fontSize: 9, fontFamily: "var(--mono)", display: "flex", alignItems: "center", justifyContent: "center", cursor: "help", flex: "none" }}>i</span>
                    <button onClick={() => void learn(false)} disabled={learning}
                      style={{ appearance: "none", cursor: "pointer", fontFamily: "inherit", border: "1px solid color-mix(in srgb, var(--purple) 35%, transparent)",
                        background: "transparent", color: "var(--purple-h)", fontSize: 9, letterSpacing: 1.5, padding: "4px 9px", flex: "none", opacity: learning ? 0.6 : 1 }}>
                      {learning ? "LEARNING…" : "◇ LEARN"}
                    </button>
                  </div>
                  {infoHover && (
                    <div style={{ position: "absolute", top: 36, right: 12, zIndex: 6, width: 214, background: "var(--panel2)",
                      border: "1px solid color-mix(in srgb, var(--purple) 40%, transparent)", boxShadow: "0 10px 34px rgba(0,0,0,.65)",
                      padding: "10px 11px", display: "flex", flexDirection: "column", gap: 6, animation: "mpop .16s ease both" }}>
                      <span style={{ fontSize: 8.5, letterSpacing: 1.5, color: "var(--purple-h)" }}>◇ LEARN — CLAUDE</span>
                      <span style={{ fontSize: 10, lineHeight: 1.6, color: "var(--txm)" }}>Scans the repo — package.json scripts, lockfile, README, Dockerfile — and writes the command needed to boot this project. Edit it before running if needed.</span>
                    </div>
                  )}
                  <div style={{ display: "flex", alignItems: "center", gap: 7, border: "1px solid color-mix(in srgb, var(--acc) 16%, transparent)", background: "color-mix(in srgb, var(--panel3) 70%, transparent)", padding: "0 9px" }}>
                    <span style={{ fontSize: 11, color: "var(--txl)", fontFamily: "var(--mono)", flex: "none" }}>$</span>
                    <input value={cmd} onChange={(e) => setCmd(e.target.value)} placeholder={placeholder} spellCheck={false}
                      onKeyDown={(e) => { if (e.key === "Enter") void start(); }}
                      style={{ appearance: "none", flex: 1, minWidth: 0, background: "transparent", border: 0, outline: "none", color: "var(--txh)", fontFamily: "var(--mono)", fontSize: 11, padding: "7px 0" }} />
                  </div>
                  <span style={{ fontSize: 9, color: "var(--txf)" }}>chain steps with &amp;&amp;. RUN saves + starts it for this project.</span>
                  <button onClick={() => running ? void stop() : void start()} disabled={busyRun}
                    title={running ? "stop the dev server" : "save + run this project"}
                    style={{ appearance: "none", cursor: "pointer", fontFamily: "inherit", width: "100%", padding: "8px 0", fontSize: 10, letterSpacing: 2.5,
                      border: `1px solid ${running ? "color-mix(in srgb, var(--err) 45%, transparent)" : "color-mix(in srgb, var(--ok) 45%, transparent)"}`,
                      background: running ? "color-mix(in srgb, var(--err) 8%, transparent)" : "color-mix(in srgb, var(--ok) 8%, transparent)",
                      color: running ? "var(--err)" : "var(--ok)", opacity: busyRun ? 0.5 : 1 }}>
                    {running ? "STOP ■" : "RUN ▸"}
                  </button>
                </div>
              )}

              {/* VIEWPORT */}
              <div style={{ flex: "none", padding: SECTION_PAD, borderBottom: "1px solid color-mix(in srgb, var(--acc) 10%, transparent)", display: "flex", flexDirection: "column", gap: 9 }}>
                <span style={labelStyle}>VIEWPORT</span>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 6 }}>
                  {VIEWPORTS.map((v) => (
                    <button key={v.key} onClick={() => setVw(v.key)} style={optBtn(vw === v.key)}>{v.label}</button>
                  ))}
                </div>
              </div>

              {/* SELECT · SEND (live element picks → session prompt queue) */}
              {showApp && (selecting || sel.state.items.length > 0) && (
                <div style={{ flex: "none", padding: SECTION_PAD, borderBottom: "1px solid color-mix(in srgb, var(--acc) 10%, transparent)", display: "flex", flexDirection: "column", gap: 9 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
                    <span style={labelStyle}>SELECT · SEND</span>
                    <span style={{ flex: 1 }} />
                    {sel.state.items.length > 0 && (
                      <button onClick={sel.clear} title="drop all picks"
                        style={{ appearance: "none", cursor: "pointer", fontFamily: "inherit", border: "none", background: "transparent", color: "var(--txd)", fontSize: 9, letterSpacing: 1.5, padding: 0 }}>CLEAR</button>
                    )}
                  </div>
                  {selecting && !sel.state.ready && (
                    <span style={{ fontSize: 9, color: "var(--warn)", lineHeight: 1.5 }}>selector agent not detected — press RUN so the bridge starts the dev server with the selector plugin injected, or add mysticalSelector() to the app's vite config.</span>
                  )}
                  {selecting && sel.state.ready && (
                    <span style={{ fontSize: 9, color: "var(--txf)", fontFamily: "var(--mono)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                      {sel.state.hoverLabel ?? "click an element in the preview to capture it"}
                    </span>
                  )}
                  <SelectionTray items={sel.state.items} onNote={sel.setNote} onRemove={sel.remove} />
                  <input value={instruction} onChange={(e) => setInstruction(e.target.value)} disabled={sending}
                    onKeyDown={(e) => { if (e.key === "Enter") void send(); }}
                    placeholder={sessionId ? "describe the change — ↵ to send…" : "open a session to send"} spellCheck
                    style={{ appearance: "none", width: "100%", boxSizing: "border-box", background: "color-mix(in srgb, var(--panel3) 70%, transparent)",
                      border: "1px solid color-mix(in srgb, var(--acc) 16%, transparent)", color: "var(--txh)", fontFamily: "inherit", fontSize: 11, padding: "7px 9px", outline: "none" }} />
                  {sendErr && <span style={{ fontSize: 9, color: "var(--err)" }}>{sendErr}</span>}
                  <button onClick={() => void send()} disabled={!canSend}
                    title={!sessionId ? "no active session to send to" : sel.state.items.length === 0 ? "select at least one element first" : "send the selected elements to Claude"}
                    style={{ appearance: "none", cursor: canSend ? "pointer" : "default", fontFamily: "inherit", width: "100%", padding: "8px 0", fontSize: 10, letterSpacing: 2.5,
                      border: `1px solid ${sent ? "color-mix(in srgb, var(--ok) 55%, transparent)" : "color-mix(in srgb, var(--acc) 45%, transparent)"}`,
                      background: sent ? "color-mix(in srgb, var(--ok) 12%, transparent)" : "color-mix(in srgb, var(--acc) 10%, transparent)",
                      color: sent ? "var(--ok)" : "var(--acc)", opacity: canSend || sent ? 1 : 0.45 }}>
                    {sent ? "SENT ✓" : sending ? "SENDING…" : "SEND ▸"}
                  </button>
                </div>
              )}

              <div style={{ flex: 1 }} />

              {/* LOG · TAIL */}
              {tail.length > 0 && (
                <div style={{ flex: "none", padding: "12px 14px", borderTop: "1px solid color-mix(in srgb, var(--acc) 10%, transparent)", display: "flex", flexDirection: "column", gap: 6 }}>
                  <span style={labelStyle}>LOG · TAIL</span>
                  {tail.map((l, i) => (
                    <span key={i} style={{ fontFamily: "var(--mono)", fontSize: 9.5, color: logColor(l), whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{l}</span>
                  ))}
                </div>
              )}
            </div>

            {/* status footer */}
            <div style={{ flex: "none", display: "flex", alignItems: "center", gap: 7, padding: "9px 14px", borderTop: "1px solid color-mix(in srgb, var(--acc) 12%, transparent)" }}>
              <span style={{ width: 6, height: 6, borderRadius: "50%", background: st.color, flex: "none" }} />
              <span style={{ fontSize: 9, letterSpacing: 1.5, color: st.color }}>{st.foot}</span>
              <span style={{ flex: 1 }} />
              <span style={{ fontSize: 9, color: "var(--txf)", fontFamily: "var(--mono)" }}>{portLabel}</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
