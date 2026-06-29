import { useEffect, useState } from "react";
import { api, type ProjectSettings, type ServerInfo } from "../api";

/** Per-project dev-server controls: pick a run command (from package.json
 *  scripts or free-text), persist it per project, start/stop, and surface the
 *  on-disk log path the Claude session can read. */
export function RunTab({
  project,
  server,
}: {
  project: string | null;
  server?: ServerInfo;
}) {
  const [settings, setSettings] = useState<ProjectSettings | null>(null);
  const [cmd, setCmd] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    if (!project) return;
    let live = true;
    api
      .projectSettings(project)
      .then((s) => {
        if (!live) return;
        setSettings(s);
        setCmd(s.run_cmd ?? s.default_cmd);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [project]);

  if (!project)
    return <div className="p-4 text-xs text-muted-foreground">No project selected.</div>;

  const scripts = settings?.scripts ?? {};
  const names = Object.keys(scripts);
  const running = server?.status === "running";

  async function persist() {
    if (project) await api.setProjectSettings(project, { run_cmd: cmd }).catch(() => {});
  }
  async function start() {
    setBusy(true);
    setNote(null);
    try {
      await persist();
      const r = await api.server("start", cmd);
      setNote(r.message);
    } catch (e) {
      setNote((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function stop() {
    setBusy(true);
    try {
      const r = await api.server("stop");
      setNote(r.message);
    } catch {
      /* ignore */
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3 p-4">
      <div className="flex items-center gap-2 text-[12px]">
        <span
          className="h-1.5 w-1.5 rounded-full"
          style={{ background: running ? "#8fd9a8" : "#3c544f" }}
        />
        <span className="text-card-foreground">
          {(server?.status ?? "not started").toUpperCase()}
        </span>
        {server?.pid != null && (
          <span className="font-mono text-[10.5px] text-muted-2">pid {server.pid}</span>
        )}
      </div>

      {names.length > 0 && (
        <div>
          <div className="mb-1 text-[10.5px] tracking-[1px] text-muted-2">PACKAGE.JSON SCRIPTS</div>
          <div className="flex flex-wrap gap-1.5">
            {names.map((n) => (
              <button
                key={n}
                onClick={() => setCmd(`npm run ${n}`)}
                title={scripts[n]}
                className="border border-input px-2 py-1 text-[11px] text-muted-foreground hover:border-ring hover:text-foreground"
              >
                npm run {n}
              </button>
            ))}
          </div>
        </div>
      )}

      <input
        value={cmd}
        onChange={(e) => setCmd(e.target.value)}
        placeholder={settings?.default_cmd ?? "npm run dev"}
        className="w-full border border-input bg-transparent px-2.5 py-1.5 font-mono text-[12px] text-foreground outline-none"
      />

      <div className="flex gap-2">
        {running ? (
          <button
            onClick={() => void stop()}
            disabled={busy}
            className="border border-danger bg-[rgba(224,137,122,.12)] px-3 py-1.5 text-[11px] tracking-[1px] text-danger hover:bg-[rgba(224,137,122,.22)] disabled:opacity-40"
          >
            STOP ■
          </button>
        ) : (
          <button
            onClick={() => void start()}
            disabled={busy}
            className="border border-primary bg-[var(--ac-12)] px-3 py-1.5 text-[11px] tracking-[1px] text-foreground-bright hover:bg-[var(--ac-22)] disabled:opacity-40"
          >
            START ▸
          </button>
        )}
        <button
          onClick={() => void persist()}
          disabled={busy}
          className="border border-input px-3 py-1.5 text-[11px] tracking-[1px] text-muted-foreground hover:text-foreground disabled:opacity-40"
        >
          SAVE
        </button>
      </div>

      <div className="text-[10.5px] text-muted-2">
        Saved per project. Logs tee'd to{" "}
        <span className="font-mono">{settings?.log_path ?? ".mystical/dev.log"}</span> — readable by
        the Claude session.
      </div>
      {note && <div className="font-mono text-[10.5px] text-muted-2">{note}</div>}
    </div>
  );
}
