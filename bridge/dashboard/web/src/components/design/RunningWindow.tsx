import { useEffect, useMemo, useRef, useState } from "react";
import { composePrompt } from "@selector/composePrompt";
import { api, type DevServerInfo, type PreviewCtx } from "../../api";
import { PreviewControls } from "./PreviewControls";
import { PreviewFrame } from "./PreviewFrame";
import { useSelector } from "./useSelector";

export function RunningWindow({
  project, branch, cwd, busy, onSubmit, onClose,
}: {
  project: string | null;       // canonical project rel
  branch: string | null | undefined;
  cwd?: string | null;          // absolute run dir of the selected session (worktree)
  busy: boolean;                // a Claude run is active
  onSubmit: (text: string, images: string[]) => void;
  onClose: () => void;
}) {
  const [source, setSource] = useState<"localhost" | "deployed">("localhost");
  const [cmd, setCmd] = useState("");
  const [placeholder, setPlaceholder] = useState("npm run dev");
  const [prodUrl, setProdUrl] = useState("");
  const [width, setWidth] = useState(375);
  const [instruction, setInstruction] = useState("");
  const [busyRun, setBusyRun] = useState(false);
  const [sending, setSending] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [servers, setServers] = useState<DevServerInfo[]>([]);
  const [learning, setLearning] = useState(false);
  // A switcher pick overrides the selected-session context until the selection changes.
  const [override, setOverride] = useState<{ cwdRel: string; project: string | null; branch: string } | null>(null);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  // Contexts we've already auto-learned this mount (so we learn+run only once each).
  const learnedRef = useRef<Set<string>>(new Set());

  useEffect(() => { setOverride(null); }, [project, branch, cwd]);

  // The (project, branch) the preview currently targets, and the API context
  // used to start/stop/save/screenshot it.
  const ctxProject = override ? override.project : project;
  const ctxBranch = override ? override.branch : (branch || "");
  const apiCtx = useMemo<PreviewCtx>(() => override
    ? { cwd_rel: override.cwdRel, project: override.project, branch: override.branch }
    : { cwd: cwd ?? undefined, project, branch: branch || undefined },
    [override, project, branch, cwd]);
  const ctxKey = useMemo(() => JSON.stringify(apiCtx), [apiCtx]);

  // This context's running dev server (matched by its rel dir, or by project+branch).
  const ctxServer = override
    ? servers.find((s) => s.dir === override.cwdRel)
    : servers.find((s) => s.project === project && (s.branch || "") === (branch || ""));
  const status = ctxServer?.status ?? "not started";
  const localhostUrl = ctxServer?.url ?? null;

  // Per-context settings: run command + prod URL. With no stored command yet,
  // learn how to start this project on first open, then auto-run it.
  useEffect(() => {
    let live = true;
    api.projectSettings(apiCtx).then((s) => {
      if (!live) return;
      setPlaceholder(s.default_cmd || "npm run dev");
      setProdUrl(s.prod_url ?? "");
      if (s.run_cmd) {
        setCmd(s.run_cmd);
      } else {
        setCmd("");
        if (!learnedRef.current.has(ctxKey)) {
          learnedRef.current.add(ctxKey);
          void learn(true);
        }
      }
    }).catch(() => {});
    return () => { live = false; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctxKey]);

  // Poll the running dev servers (picks up URL detection + external stops).
  useEffect(() => {
    let live = true;
    const tick = async () => {
      try { const r = await api.servers(); if (live) setServers(r.servers); } catch { /* ignore */ }
    };
    void tick();
    const id = setInterval(tick, 2500);
    return () => { live = false; clearInterval(id); };
  }, []);

  const activeUrl = source === "localhost" ? localhostUrl : (prodUrl || null);
  const origin = useMemo(() => {
    try { return activeUrl ? new URL(activeUrl).origin : null; } catch { return null; }
  }, [activeUrl]);

  // The selector plugin is dev-only, so it works against localhost, not prod.
  const selectorOrigin = source === "localhost" ? origin : null;
  const sel = useSelector(iframeRef, selectorOrigin);

  const save = async () => {
    await api.setProjectSettings(apiCtx, { run_cmd: cmd, prod_url: prodUrl }).catch(() => {});
  };
  // skipSave: the just-learned command is already persisted server-side, and
  // `cmd` state may not have flushed yet — so start with it explicitly.
  const start = async (opts?: { cmd?: string; skipSave?: boolean }) => {
    setBusyRun(true);
    try {
      if (!opts?.skipSave) await save();
      const r = await api.server("start", { cmd: opts?.cmd ?? cmd, ...apiCtx });
      setServers(r.servers ?? []);
      setSource("localhost");
    } catch { /* ignore */ } finally { setBusyRun(false); }
  };
  // Learn the start chain (heuristic, then Claude for tricky repos); optionally run it.
  const learn = async (autorun: boolean) => {
    setLearning(true);
    try {
      const r = await api.detectPreview(apiCtx);
      if (r.command) {
        setCmd(r.command);
        if (autorun) await start({ cmd: r.command, skipSave: true });
      }
    } catch { /* ignore */ } finally { setLearning(false); }
  };
  const stop = async () => {
    setBusyRun(true);
    try { const r = await api.server("stop", apiCtx); setServers(r.servers ?? []); }
    catch { /* ignore */ } finally { setBusyRun(false); }
  };

  const submit = async () => {
    if (!instruction.trim() || !sel.state.items.length) return;
    setSending(true);
    const text = composePrompt({ project: ctxProject, width, items: sel.state.items, instruction });
    let images: string[] = [];
    try {
      if (activeUrl) {
        const shot = await api.screenshot(width, activeUrl, apiCtx);
        if (shot.data_url) images = [shot.data_url];
      }
    } catch { /* text-only fallback */ }
    onSubmit(text, images);
    sel.clear();
    setInstruction("");
    setSending(false);
  };

  const onSwitch = (s: DevServerInfo) => {
    setOverride({ cwdRel: s.dir ?? "", project: s.project, branch: s.branch });
    setSource("localhost");
  };

  const canSelect = source === "localhost" && !!localhostUrl;

  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 60, background: "#05080a" }}>
      {activeUrl ? (
        <PreviewFrame url={activeUrl} iframeRef={iframeRef} width={width} selecting={sel.state.mode === "select"} />
      ) : learning ? (
        <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", gap: 8, alignItems: "center", justifyContent: "center", color: "#9fc7c0", fontSize: 13, textAlign: "center", padding: 24 }}>
          <div style={{ color: "#7fe9d8" }}>Learning how to start this project…</div>
          <div style={{ fontSize: 11, opacity: 0.6 }}>Inspecting the repo (and asking Claude if it's a tricky setup).</div>
        </div>
      ) : source !== "deployed" && status === "exited" ? (
        <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", gap: 10, alignItems: "center", justifyContent: "center", padding: 24 }}>
          <div style={{ color: "#e0897a", fontSize: 13 }}>Dev server exited — check the command.</div>
          {(ctxServer?.tail?.length ?? 0) > 0 && (
            <pre style={{ maxWidth: "min(800px,90vw)", maxHeight: "50vh", overflow: "auto", margin: 0, padding: "10px 12px", background: "rgba(224,137,122,.07)", border: "1px solid rgba(224,137,122,.3)", color: "#e7b3a8", fontFamily: "'JetBrains Mono',monospace", fontSize: 11.5, lineHeight: 1.5, whiteSpace: "pre-wrap" }}>
              {ctxServer!.tail.join("\n")}
            </pre>
          )}
        </div>
      ) : (
        <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", color: "#9fc7c0", fontSize: 13, textAlign: "center", padding: 24 }}>
          {source === "deployed"
            ? "No production URL set — add one in the controls."
            : status === "running"
              ? "Dev server running — waiting for it to report its localhost URL…"
              : "Start the dev server to preview localhost."}
        </div>
      )}

      <PreviewControls
        project={ctxProject} branch={ctxBranch}
        source={source} onSource={setSource} hasProd={!!prodUrl}
        collapsed={collapsed} onCollapsed={setCollapsed} onClose={onClose}
        cmd={cmd} onCmd={setCmd} placeholder={placeholder}
        prodUrl={prodUrl} onProdUrl={setProdUrl} status={status} port={ctxServer?.port ?? null}
        onStart={() => void start()} onStop={() => void stop()} onSave={() => void save()}
        onLearn={() => void learn(true)} learning={learning} busyRun={busyRun || learning}
        width={width} onWidth={setWidth}
        selecting={sel.state.mode === "select"}
        onToggleSelect={() => sel.setMode(sel.state.mode === "select" ? "idle" : "select")}
        canSelect={canSelect} hoverLabel={sel.state.hoverLabel}
        items={sel.state.items} onNote={sel.setNote} onRemove={sel.remove}
        instruction={instruction} onInstruction={setInstruction}
        onSubmit={() => void submit()} sending={busy || sending}
        servers={servers} activeDir={ctxServer?.dir ?? null} onSwitch={onSwitch}
      />
    </div>
  );
}
