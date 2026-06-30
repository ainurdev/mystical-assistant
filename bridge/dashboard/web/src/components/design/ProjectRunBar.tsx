const ctl = { appearance: "none" as const, cursor: "pointer", fontFamily: "inherit", flex: "none" as const };

export function ProjectRunBar({
  project, cmd, onCmd, placeholder, prodUrl, onProdUrl, serverStatus, port,
  onStart, onStop, onSave, onLearn, learning, busy,
}: {
  project: string | null;
  cmd: string;
  onCmd: (v: string) => void;
  placeholder: string;
  prodUrl: string;
  onProdUrl: (v: string) => void;
  serverStatus: string;
  port?: number | null;
  onStart: () => void;
  onStop: () => void;
  onSave: () => void;
  onLearn?: () => void;
  learning?: boolean;
  busy: boolean;
}) {
  const running = serverStatus === "running";
  const exited = serverStatus === "exited";
  const dot = running ? "#8fd9a8" : exited ? "#e0897a" : "#3c544f";
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "7px 12px", flexWrap: "wrap", flex: "none" }}>
      <span style={{ fontSize: 12, color: "#b9a6ff", fontFamily: "'JetBrains Mono',monospace", flex: "none", alignSelf: "flex-start", paddingTop: 6 }}>$</span>
      <textarea value={cmd} onChange={(e) => onCmd(e.target.value)} rows={2} spellCheck={false}
        placeholder={learning ? "Learning how to start this project…" : placeholder}
        disabled={!project || learning} title="Start command chain — edit, then Save or Run (chain steps with &&)"
        style={{ flex: "1 1 100%", minWidth: 160, resize: "vertical", background: "rgba(7,13,13,.6)", border: "1px solid rgba(127,233,216,.18)", outline: "none", color: "#dff8f2", fontFamily: "'JetBrains Mono',monospace", fontSize: 12, lineHeight: 1.5, padding: "6px 9px" }} />
      <input value={prodUrl} onChange={(e) => onProdUrl(e.target.value)} placeholder="https://deployed-url…"
        spellCheck={false} disabled={!project} title="Production URL — used by the 'deployed' source toggle"
        style={{ flex: 1, minWidth: 140, background: "rgba(7,13,13,.6)", border: "1px solid rgba(185,166,255,.2)", outline: "none", color: "#dff8f2", fontFamily: "'JetBrains Mono',monospace", fontSize: 12, padding: "6px 9px" }} />
      {onLearn && (
        <button data-no-drag onClick={onLearn} disabled={busy || learning || !project}
          title="Re-learn how to start this project (heuristics, then Claude for tricky repos)"
          style={{ ...ctl, border: "1px solid rgba(185,166,255,.3)", background: "transparent", color: "#b9a6ff", fontSize: 9.5, letterSpacing: 1, padding: "6px 11px", opacity: busy || learning || !project ? 0.4 : 1 }}>
          {learning ? "LEARNING…" : "↻ LEARN"}
        </button>
      )}
      <button data-no-drag onClick={onSave} disabled={busy || !project} title="Save command + prod URL for this project"
        style={{ ...ctl, border: "1px solid rgba(127,233,216,.25)", background: "transparent", color: "#9fc7c0", fontSize: 9.5, letterSpacing: 1, padding: "6px 11px", opacity: busy || !project ? 0.4 : 1 }}>SAVE</button>
      {running ? (
        <button data-no-drag onClick={onStop} disabled={busy} title="Stop dev server"
          style={{ ...ctl, border: "1px solid #e0897a", background: "rgba(224,137,122,.12)", color: "#e0897a", fontSize: 10, letterSpacing: 1, padding: "6px 14px", opacity: busy ? 0.4 : 1 }}>STOP ■</button>
      ) : (
        <button data-no-drag onClick={onStart} disabled={busy || !project} title="Run this project's dev server"
          style={{ ...ctl, border: "1px solid #7fe9d8", background: "rgba(127,233,216,.12)", color: "#dff8f2", fontSize: 10, letterSpacing: 1, padding: "6px 14px", opacity: busy || !project ? 0.4 : 1 }}>RUN ▸</button>
      )}
      <span style={{ display: "inline-flex", alignItems: "center", gap: 5, flex: "none" }}>
        <span style={{ width: 6, height: 6, borderRadius: "50%", background: dot, animation: running ? "mpulse 2.4s infinite" : undefined }} />
        <span style={{ fontSize: 9, letterSpacing: 1, color: dot }}>
          {serverStatus.toUpperCase()}{running && port ? ` :${port}` : ""}
        </span>
      </span>
    </div>
  );
}
