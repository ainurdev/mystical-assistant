import { useEffect, useMemo, useRef, useState } from "react";
import { composePrompt } from "@selector/composePrompt";
import { api } from "../../api";
import { FloatingWindow } from "./FloatingWindow";
import { ProjectRunBar } from "./ProjectRunBar";
import { PreviewFrame } from "./PreviewFrame";
import { SelectionTray } from "./SelectionTray";
import { useSelector } from "./useSelector";

function basename(rel: string | null): string {
  if (!rel) return "—";
  const clean = rel.replace(/\/+$/, "");
  return clean.split("/").pop() || clean || "—";
}

export function RunningWindow({
  project, branch, devPort, busy, onSubmit, onClose,
}: {
  project: string | null;
  branch: string | null | undefined;
  devPort: number;
  busy: boolean;
  onSubmit: (text: string, images: string[]) => void;
  onClose: () => void;
}) {
  const [source, setSource] = useState<"localhost" | "deployed">("localhost");
  const [cmd, setCmd] = useState("");
  const [placeholder, setPlaceholder] = useState("npm run dev");
  const [prodUrl, setProdUrl] = useState("");
  const [serverStatus, setServerStatus] = useState("not started");
  const [busyRun, setBusyRun] = useState(false);
  const [width, setWidth] = useState(375);
  const [instruction, setInstruction] = useState("");
  const iframeRef = useRef<HTMLIFrameElement | null>(null);

  // Per-project settings: run command + prod URL.
  useEffect(() => {
    if (!project) { setCmd(""); setProdUrl(""); return; }
    let live = true;
    api.projectSettings(project).then((s) => {
      if (!live) return;
      setCmd(s.run_cmd ?? s.default_cmd);
      setPlaceholder(s.default_cmd || "npm run dev");
      setProdUrl(s.prod_url ?? "");
    }).catch(() => {});
    return () => { live = false; };
  }, [project]);

  // Dev-server status poll.
  useEffect(() => {
    let live = true;
    const tick = async () => {
      try { const st = await api.state(); if (live) setServerStatus(st.server?.status ?? "not started"); }
      catch { /* ignore */ }
    };
    void tick();
    const id = setInterval(tick, 3000);
    return () => { live = false; clearInterval(id); };
  }, []);

  const localhostUrl = `http://localhost:${devPort}`;
  const activeUrl = source === "localhost" ? localhostUrl : (prodUrl || null);
  const origin = useMemo(() => {
    try { return activeUrl ? new URL(activeUrl).origin : null; } catch { return null; }
  }, [activeUrl]);

  // The selector only works against the dev server (the plugin is dev-only).
  const selectorOrigin = source === "localhost" ? origin : null;
  const sel = useSelector(iframeRef, selectorOrigin);

  const save = async () => {
    if (project) await api.setProjectSettings(project, { run_cmd: cmd, prod_url: prodUrl }).catch(() => {});
  };
  const start = async () => {
    if (!project) return;
    setBusyRun(true);
    try {
      await save();
      await api.select(project);        // dev-server cwd keys off the active project
      await api.server("start", cmd, project);
      setServerStatus("running");
      setSource("localhost");
    } catch { /* ignore */ } finally { setBusyRun(false); }
  };
  const stop = async () => {
    setBusyRun(true);
    try { await api.server("stop"); setServerStatus("exited"); } catch { /* ignore */ }
    finally { setBusyRun(false); }
  };

  const submit = async () => {
    if (!instruction.trim() || !sel.state.items.length) return;
    const text = composePrompt({ project, width, items: sel.state.items, instruction });
    let images: string[] = [];
    try {
      if (activeUrl) {
        const shot = await api.screenshot(width, activeUrl);
        if (shot.data_url) images = [shot.data_url];
      }
    } catch { /* text-only fallback */ }
    onSubmit(text, images);
    sel.clear();
    setInstruction("");
  };

  const header = (
    <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
      <span style={{ fontSize: 9, letterSpacing: 1, color: "#7fe9d8", border: "1px solid rgba(127,233,216,.4)", padding: "2px 7px", flex: "none" }}>RUNNING</span>
      <span style={{ fontSize: 11, color: "#dff8f2", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{basename(project)}</span>
      {branch && (
        <span style={{ display: "flex", alignItems: "center", gap: 4, flex: "none", fontSize: 9, color: "#a78bf0", border: "1px solid rgba(185,166,255,.28)", padding: "2px 7px" }}>
          <span style={{ color: "#b9a6ff" }}>⎇</span>{branch}
        </span>
      )}
      <span style={{ display: "flex", marginLeft: 6, flex: "none" }}>
        {(["localhost", "deployed"] as const).map((s) => (
          <button key={s} data-no-drag onClick={() => setSource(s)}
            disabled={s === "deployed" && !prodUrl}
            title={s === "deployed" && !prodUrl ? "Set a production URL in the run bar first" : `Show ${s}`}
            style={{ appearance: "none", cursor: "pointer", border: `1px solid ${source === s ? "#7fe9d8" : "rgba(127,233,216,.16)"}`, background: source === s ? "rgba(127,233,216,.08)" : "transparent", color: source === s ? "#dff8f2" : "#3c544f", fontFamily: "inherit", fontSize: 9, letterSpacing: 1, padding: "3px 8px", opacity: s === "deployed" && !prodUrl ? 0.4 : 1 }}>
            {s.toUpperCase()}
          </button>
        ))}
      </span>
    </div>
  );

  return (
    <FloatingWindow storageKey="mystical:runner"
      defaultRect={{ x: Math.max(20, window.innerWidth - 760), y: 90, w: 720, h: 560 }}
      header={header} onClose={onClose}>
      <ProjectRunBar project={project} cmd={cmd} onCmd={setCmd} placeholder={placeholder}
        prodUrl={prodUrl} onProdUrl={setProdUrl} serverStatus={serverStatus}
        onStart={() => void start()} onStop={() => void stop()} onSave={() => void save()} busy={busyRun} />
      <div style={{ height: 1, background: "rgba(127,233,216,.1)", flex: "none" }} />
      {!activeUrl ? (
        <div className="p-4 text-sm opacity-60" style={{ color: "#9fc7c0" }}>
          {source === "deployed" ? "No production URL set — add one in the run bar." : "Start the dev server to preview localhost."}
        </div>
      ) : (
        <div className="grid grid-cols-[1fr_300px] gap-3 p-3" style={{ flex: 1, minHeight: 0 }}>
          <PreviewFrame url={activeUrl} iframeRef={iframeRef} width={width} onWidth={setWidth}
            mode={sel.state.mode} onMode={sel.setMode} hoverLabel={sel.state.hoverLabel} />
          <div className="flex flex-col gap-2 overflow-y-auto">
            {source === "deployed" ? (
              <p className="text-xs opacity-60">Production preview — element selection needs the dev server (localhost).</p>
            ) : (
              <SelectionTray items={sel.state.items} onNote={sel.setNote} onRemove={sel.remove} />
            )}
            <textarea value={instruction} onChange={(e) => setInstruction(e.target.value)}
              placeholder="What should Claude change?" rows={3}
              className="w-full rounded border border-[var(--border)] bg-[var(--panel)] p-2 text-sm outline-none" />
            <button onClick={() => void submit()} disabled={busy || !instruction.trim() || !sel.state.items.length}
              className="rounded bg-[var(--accent)] px-3 py-2 text-sm font-medium text-[var(--accent-foreground)] disabled:opacity-40">
              Send to Claude
            </button>
          </div>
        </div>
      )}
    </FloatingWindow>
  );
}
