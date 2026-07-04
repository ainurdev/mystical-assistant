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
  const dot = running ? "var(--ok)" : exited ? "var(--err)" : "var(--txl)";
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "7px 12px", flexWrap: "wrap", flex: "none" }}>
      <span style={{ fontSize: 12, color: "var(--purple)", fontFamily: "'JetBrains Mono',monospace", flex: "none", alignSelf: "flex-start", paddingTop: 6 }}>$</span>
      <textarea value={cmd} onChange={(e) => onCmd(e.target.value)} rows={2} spellCheck={false}
        placeholder={learning ? "Learning how to start this project…" : placeholder}
        disabled={!project || learning} title="Start command chain — edit, then Save or Run (chain steps with &&)"
        style={{ flex: "1 1 100%", minWidth: 160, resize: "vertical", background: "color-mix(in srgb, var(--panel2) 60%, transparent)", border: "1px solid color-mix(in srgb, var(--acc) 18%, transparent)", outline: "none", color: "var(--txb)", fontFamily: "'JetBrains Mono',monospace", fontSize: 12, lineHeight: 1.5, padding: "6px 9px" }} />
      <input value={prodUrl} onChange={(e) => onProdUrl(e.target.value)} placeholder="https://deployed-url…"
        spellCheck={false} disabled={!project} title="Production URL — used by the 'deployed' source toggle"
        style={{ flex: 1, minWidth: 140, background: "color-mix(in srgb, var(--panel2) 60%, transparent)", border: "1px solid color-mix(in srgb, var(--purple) 20%, transparent)", outline: "none", color: "var(--txb)", fontFamily: "'JetBrains Mono',monospace", fontSize: 12, padding: "6px 9px" }} />
      {onLearn && (
        <button data-no-drag onClick={onLearn} disabled={busy || learning || !project}
          title="Re-learn how to start this project (heuristics, then Claude for tricky repos)"
          style={{ ...ctl, border: "1px solid color-mix(in srgb, var(--purple) 30%, transparent)", background: "transparent", color: "var(--purple)", fontSize: 9.5, letterSpacing: 1, padding: "6px 11px", opacity: busy || learning || !project ? 0.4 : 1 }}>
          {learning ? "LEARNING…" : "↻ LEARN"}
        </button>
      )}
      <button data-no-drag onClick={onSave} disabled={busy || !project} title="Save command + prod URL for this project"
        style={{ ...ctl, border: "1px solid color-mix(in srgb, var(--acc) 25%, transparent)", background: "transparent", color: "var(--txm)", fontSize: 9.5, letterSpacing: 1, padding: "6px 11px", opacity: busy || !project ? 0.4 : 1 }}>SAVE</button>
      {running ? (
        <button data-no-drag onClick={onStop} disabled={busy} title="Stop dev server"
          style={{ ...ctl, border: "1px solid var(--err)", background: "color-mix(in srgb, var(--err) 12%, transparent)", color: "var(--err)", fontSize: 10, letterSpacing: 1, padding: "6px 14px", opacity: busy ? 0.4 : 1 }}>STOP ■</button>
      ) : (
        <button data-no-drag onClick={onStart} disabled={busy || !project} title="Run this project's dev server"
          style={{ ...ctl, border: "1px solid var(--acc)", background: "color-mix(in srgb, var(--acc) 12%, transparent)", color: "var(--txb)", fontSize: 10, letterSpacing: 1, padding: "6px 14px", opacity: busy || !project ? 0.4 : 1 }}>RUN ▸</button>
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
