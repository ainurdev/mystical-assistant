import { useCallback, useEffect, useState } from "react";
import { api, type GitStatus } from "../api";

function statusColor(s: string): string {
  if (s === "A" || s === "?") return "var(--success)";
  if (s === "D") return "var(--danger)";
  return "var(--warning)";
}

export function GitTab({
  project,
  onOpenDiff,
}: {
  project: string | null;
  onOpenDiff: (path: string) => void;
}) {
  const [st, setSt] = useState<GitStatus | null>(null);
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!project) return;
    try {
      setSt(await api.git(project));
    } catch {
      /* ignore */
    }
  }, [project]);

  useEffect(() => {
    let live = true;
    void refresh();
    const id = setInterval(() => {
      if (live) void refresh();
    }, 4000);
    return () => {
      live = false;
      clearInterval(id);
    };
  }, [refresh]);

  if (!project) return <div className="p-4 text-xs text-muted-foreground">No project selected.</div>;
  if (st && !st.is_repo)
    return <div className="p-4 text-xs text-muted-foreground">Not a git repository.</div>;

  async function commit() {
    if (!project || !msg.trim()) return;
    setBusy(true);
    setNote(null);
    try {
      const r = await api.gitCommit(project, msg.trim());
      setNote(r.ok ? "Committed." : r.output || "Commit failed.");
      if (r.ok) setMsg("");
      await refresh();
    } catch (e) {
      setNote((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function push() {
    if (!project) return;
    setBusy(true);
    setNote(null);
    try {
      const r = await api.gitPush(project);
      setNote(r.ok ? "Pushed." : r.output || "Push failed.");
    } catch (e) {
      setNote((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="p-4">
      <div className="mb-4 rounded-[11px] border border-border bg-card p-3.5">
        <div className="flex items-center justify-between">
          <span className="flex items-center gap-1.5 font-mono text-[13px] text-card-foreground">
            <span className="text-brand-soft">⎇</span>
            {st?.branch || "—"}
          </span>
          <span className="flex gap-2.5 font-mono text-[11px] text-muted-2">
            <span className="text-success">↑{st?.ahead ?? 0}</span>
            <span>↓{st?.behind ?? 0}</span>
          </span>
        </div>
      </div>

      <div className="px-0.5 pb-2 text-[10.5px] font-semibold uppercase tracking-wider text-muted-2">
        Changes · {st?.files.length ?? 0} files
      </div>
      {st?.files.map((f) => (
        <button
          key={f.path}
          onClick={() => onOpenDiff(f.path)}
          className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left hover:bg-accent"
        >
          <span
            className="w-4 shrink-0 text-center font-mono text-[11px] font-semibold"
            style={{ color: statusColor(f.status) }}
          >
            {f.status}
          </span>
          <span
            className="flex-1 truncate text-left font-mono text-[11.5px] text-card-foreground"
            style={{ direction: "rtl" }}
          >
            {f.path}
          </span>
          <span className="flex shrink-0 gap-1.5 font-mono text-[11px]">
            <span className="text-success">+{f.add}</span>
            <span className="text-danger">−{f.del}</span>
          </span>
        </button>
      ))}
      {st && st.files.length === 0 && (
        <div className="px-2.5 py-2 text-xs text-muted-foreground">Working tree clean.</div>
      )}

      <div className="mt-4 rounded-[11px] border border-border bg-card p-3">
        <textarea
          value={msg}
          onChange={(e) => setMsg(e.target.value)}
          rows={2}
          placeholder="Commit message…"
          className="w-full resize-none bg-transparent text-[12.5px] outline-none placeholder:text-[#5a5470]"
        />
        <div className="mt-3 flex gap-2">
          <button
            onClick={() => void commit()}
            disabled={busy || !msg.trim()}
            className="flex-1 rounded-lg border border-brand-soft bg-primary px-2 py-2 text-[12.5px] font-semibold text-white hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Commit all
          </button>
          <button
            onClick={() => void push()}
            disabled={busy}
            className="rounded-lg border border-input bg-secondary px-3.5 py-2 text-[12.5px] font-medium text-foreground hover:bg-accent disabled:opacity-40"
          >
            Push
          </button>
        </div>
        {note && (
          <div className="mt-2 whitespace-pre-wrap break-words font-mono text-[10.5px] text-muted-foreground">
            {note}
          </div>
        )}
      </div>
    </div>
  );
}
