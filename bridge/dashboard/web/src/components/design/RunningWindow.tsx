import { useEffect, useMemo, useRef, useState } from "react";
import { composePrompt } from "@selector/composePrompt";
import type { Capture } from "@selector/protocol";
import { api, logStream, type DevServerInfo, type PreviewCtx } from "../../api";
import { PreviewFrame } from "./PreviewFrame";
import { useSelector } from "./useSelector";
import { usePreviewQueue, useRunProgress } from "./usePreviewQueue";
import { PreviewConsole } from "./PreviewConsole";

function basename(rel: string | null): string {
  if (!rel) return "—";
  const clean = rel.replace(/\/+$/, "");
  return clean.split("/").pop() || clean || "—";
}

/** Turn a selector capture into a short {tag,label} anchor for the queue card. */
function anchorOf(c: Capture): { tag: string; label: string } {
  if (c.kind === "element") {
    const label = (c.text || "").trim().slice(0, 40) || c.selector || c.tag;
    return { tag: c.tag, label };
  }
  return { tag: "pin", label: `PIN (${Math.round(c.point.x)},${Math.round(c.point.y)})` };
}

export function RunningWindow({
  project, branch, cwd, sessionId, onClose,
}: {
  project: string | null;       // canonical project rel
  branch: string | null | undefined;
  cwd?: string | null;          // absolute run dir of the selected session (worktree)
  sessionId: string | null;     // the dashboard's open session — the queue runs against it
  onClose: () => void;
}) {
  const [source, setSource] = useState<"localhost" | "deployed">("localhost");
  const [cmd, setCmd] = useState("");
  const [placeholder, setPlaceholder] = useState("npm run dev");
  const [prodUrl, setProdUrl] = useState("");
  const [width, setWidth] = useState(375);
  const [instruction, setInstruction] = useState("");
  const [busyRun, setBusyRun] = useState(false);
  const [servers, setServers] = useState<DevServerInfo[]>([]);
  const [learning, setLearning] = useState(false);
  // run settings for queued prompts (independent of the main chat composer)
  const [model, setModel] = useState("opus");
  const [effort, setEffort] = useState("");
  const [mode, setMode] = useState("acceptEdits");
  // live dev-server log feed (LOGS tab)
  const [logs, setLogs] = useState<string[]>([]);
  const [autoscroll, setAutoscroll] = useState(true);
  const [logFilter, setLogFilter] = useState("all");
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const learnedRef = useRef<Set<string>>(new Set());

  const ctxProject = project;
  const ctxBranch = branch || "";
  const apiCtx = useMemo<PreviewCtx>(
    () => ({ cwd: cwd ?? undefined, project, branch: branch || undefined }),
    [project, branch, cwd]);
  const ctxKey = useMemo(() => JSON.stringify(apiCtx), [apiCtx]);

  // This context's running dev server (matched by project + branch).
  const ctxServer = servers.find((s) => s.project === project && (s.branch || "") === (branch || ""));
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

  // Live dev-server logs (SSE replays the recent tail, then streams). Shared across
  // servers; the LOGS tab filters client-side.
  useEffect(() => {
    const stop = logStream((line) => setLogs((p) => [...p, line].slice(-400)));
    return stop;
  }, []);

  const activeUrl = source === "localhost" ? localhostUrl : (prodUrl || null);
  const origin = useMemo(() => {
    try { return activeUrl ? new URL(activeUrl).origin : null; } catch { return null; }
  }, [activeUrl]);

  // The selector plugin is dev-only, so it works against localhost, not prod.
  const selectorOrigin = source === "localhost" ? origin : null;
  const sel = useSelector(iframeRef, selectorOrigin);

  // --- the per-session prompt queue + the running prompt's live tool stream ---
  const q = usePreviewQueue(sessionId);
  const progress = useRunProgress(sessionId, q.running?.job_id ?? null);
  const curTool = progress.tools.find((t) => t.state === "running") ?? progress.tools[progress.tools.length - 1];
  const runningTool = curTool ? `${curTool.name} · ${curTool.summary}` : null;

  const save = async () => {
    await api.setProjectSettings(apiCtx, { run_cmd: cmd, prod_url: prodUrl }).catch(() => {});
  };
  const start = async (opts?: { cmd?: string; skipSave?: boolean }) => {
    setBusyRun(true);
    try {
      if (!opts?.skipSave) await save();
      const r = await api.server("start", { cmd: opts?.cmd ?? cmd, ...apiCtx });
      setServers(r.servers ?? []);
      setSource("localhost");
    } catch { /* ignore */ } finally { setBusyRun(false); }
  };
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

  // Picks are optional; a bare instruction is fine.
  const compose = () => {
    const items = sel.state.items;
    return items.length
      ? composePrompt({ project: ctxProject, width, items, instruction })
      : instruction.trim();
  };

  // Compose + enqueue.
  const submit = async () => {
    if (!instruction.trim() || !sessionId) return;
    const items = sel.state.items;
    const prompt = compose();
    let images: string[] = [];
    try {
      if (activeUrl) {
        const shot = await api.screenshot(width, activeUrl, apiCtx);
        if (shot.data_url) images = [shot.data_url];
      }
    } catch { /* text-only fallback */ }
    q.enqueue({
      text: instruction.trim(), prompt, images, sel: items.map((it) => anchorOf(it.capture)),
      width, project: ctxProject ?? undefined,
      model, effort: effort || undefined, permission_mode: mode || undefined,
    });
    sel.clear();
    setInstruction("");
  };

  // Land the instruction in the turn that's already running (no screenshot: it
  // joins mid-flight as text). Falls back to queueing if the run just finished.
  const steer = async () => {
    if (!instruction.trim() || !sessionId) return;
    if (!(await q.steer(compose()))) return void submit();
    sel.clear();
    setInstruction("");
  };

  const canSelect = source === "localhost" && !!localhostUrl;
  const queuedCount = q.queued.length;
  const sendLabel = (q.running || queuedCount) ? "ADD ▸" : "SEND ▸";
  const sendHint = !instruction.trim()
    ? "⌘↵ to send · joins the queue"
    : q.running ? "runs after the current task — or ⚡ steer it into the live one"
      : queuedCount ? `queues behind ${queuedCount} waiting`
        : "starts on the running server";

  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 60, background: "var(--panel3)" }}>
      {activeUrl ? (
        <PreviewFrame url={activeUrl} iframeRef={iframeRef} width={width} selecting={sel.state.mode === "select"} />
      ) : learning ? (
        <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", gap: 8, alignItems: "center", justifyContent: "center", color: "var(--txm)", fontSize: 13, textAlign: "center", padding: 24 }}>
          <div style={{ color: "var(--acc)" }}>Learning how to start this project…</div>
          <div style={{ fontSize: 11, opacity: 0.6 }}>Inspecting the repo (and asking Claude if it's a tricky setup).</div>
        </div>
      ) : source !== "deployed" && status === "exited" ? (
        <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", gap: 10, alignItems: "center", justifyContent: "center", padding: 24 }}>
          <div style={{ color: "var(--err)", fontSize: 13 }}>Dev server exited — check the command.</div>
          {(ctxServer?.tail?.length ?? 0) > 0 && (
            <pre style={{ maxWidth: "min(800px,90vw)", maxHeight: "50vh", overflow: "auto", margin: 0, padding: "10px 12px", background: "color-mix(in srgb, var(--err) 7%, transparent)", border: "1px solid color-mix(in srgb, var(--err) 30%, transparent)", color: "var(--err-hi)", fontFamily: "'JetBrains Mono',monospace", fontSize: 11.5, lineHeight: 1.5, whiteSpace: "pre-wrap" }}>
              {ctxServer!.tail.join("\n")}
            </pre>
          )}
        </div>
      ) : (
        <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--txm)", fontSize: 13, fontStyle: "italic", textAlign: "center", padding: 24 }}>
          {source === "deployed"
            ? "no production URL set — add one in the controls."
            : status === "running"
              ? "dev server running — waiting for it to report its localhost URL…"
              : "the server sleeps — press RUN to wake the preview."}
        </div>
      )}

      <PreviewConsole
        project={basename(ctxProject)} branch={ctxBranch || null}
        serverStatus={status} port={ctxServer?.port ?? null}
        onClose={onClose}
        previewProps={{
          source, onSource: setSource, hasProd: !!prodUrl,
          project: ctxProject, cmd, onCmd: setCmd, placeholder,
          prodUrl, onProdUrl: setProdUrl, serverStatus: status, port: ctxServer?.port ?? null,
          onStart: () => void start(), onStop: () => void stop(), onSave: () => void save(),
          onLearn: () => void learn(true), learning, busyRun: busyRun || learning,
          width, onWidth: setWidth,
          selecting: sel.state.mode === "select",
          onToggleSelect: () => sel.setMode(sel.state.mode === "select" ? "idle" : "select"),
          canSelect, hoverLabel: sel.state.hoverLabel,
          items: sel.state.items, onNote: sel.setNote, onRemove: sel.remove,
          instruction, onInstruction: setInstruction, onSend: () => void submit(), sendLabel, sendHint,
          onSteer: () => void steer(), canSteer: !!q.running,
          model, onModel: setModel, effort, onEffort: setEffort, mode, onMode: setMode,
        }}
        logsProps={{
          lines: logs, running: status === "running", port: ctxServer?.port ?? null,
          autoscroll, onAutoscroll: setAutoscroll, onClear: () => setLogs([]),
          filter: logFilter, onFilter: setLogFilter,
        }}
        queueProps={{
          items: q.items, paused: q.paused, running: q.running, runningTool,
          onTogglePause: q.togglePause, onClearDone: q.clearDone,
          onRemove: q.remove, onEdit: q.edit, onCancel: q.cancel, onRetry: q.retry,
          onBump: q.bump, onReorder: q.reorder, onShowProgress: () => {},
        }}
        sidebar={{
          running: q.running, progress, queued: q.queued, paused: q.paused,
          onBump: q.bump, onTogglePause: q.togglePause,
        }}
      />
    </div>
  );
}
