import { useCallback, useEffect, useState } from "react";
import { api, type IssuesInfo } from "../api";
import { ago } from "../lib/surfaces";

export function IssuesTab({ project }: { project: string | null }) {
  const [info, setInfo] = useState<IssuesInfo | null>(null);
  const [creating, setCreating] = useState(false);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!project) return;
    try {
      setInfo(await api.issues(project));
    } catch {
      /* ignore */
    }
  }, [project]);

  useEffect(() => {
    let live = true;
    void refresh();
    const id = setInterval(() => {
      if (live) void refresh();
    }, 60000);
    return () => {
      live = false;
      clearInterval(id);
    };
  }, [refresh]);

  if (!project) return <div className="p-4 text-xs text-muted-foreground">No project selected.</div>;
  if (info && !info.has_remote)
    return <div className="p-4 text-xs text-muted-foreground">No GitHub remote.</div>;
  if (info && !info.gh_ok)
    return (
      <div className="p-4 text-xs text-muted-foreground">
        GitHub CLI unavailable.
        {info.error ? (
          <div className="mt-1 font-mono text-[10.5px] text-muted-2">{info.error}</div>
        ) : null}
      </div>
    );

  async function create() {
    if (!project || !title.trim()) return;
    setBusy(true);
    setNote(null);
    try {
      const r = await api.createIssue(project, title.trim(), body);
      if (r.ok) {
        setTitle("");
        setBody("");
        setCreating(false);
        await refresh();
      } else {
        setNote(r.output || "Create failed.");
      }
    } catch (e) {
      setNote((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="p-4">
      <div className="mb-3 flex items-center justify-between">
        <div className="flex gap-3.5 font-mono text-xs">
          <span className="text-card-foreground">● {info?.open_count ?? 0} open</span>
          <span className="text-muted-2">✓ {info?.closed_count ?? 0} closed</span>
        </div>
        <button
          onClick={() => setCreating((v) => !v)}
          className="text-[11px] text-brand-soft hover:text-foreground"
        >
          {creating ? "Cancel" : "New issue"}
        </button>
      </div>

      {creating && (
        <div className="mb-3 rounded-[10px] border border-border bg-card p-3 animate-[mpop_.14s_ease]">
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Issue title"
            className="w-full bg-transparent text-[13px] outline-none placeholder:text-[#5a5470]"
          />
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={3}
            placeholder="Describe the issue…"
            className="mt-2 w-full resize-none bg-transparent text-[12.5px] outline-none placeholder:text-[#5a5470]"
          />
          <div className="mt-2 flex justify-end gap-2">
            <button
              onClick={() => setCreating(false)}
              className="rounded-lg border border-input bg-secondary px-3 py-1.5 text-[12px] text-foreground hover:bg-accent"
            >
              Cancel
            </button>
            <button
              onClick={() => void create()}
              disabled={busy || !title.trim()}
              className="rounded-lg border border-primary bg-[var(--ac-12)] px-3.5 py-1.5 text-[12px] font-semibold text-foreground-bright hover:bg-[var(--ac-22)] disabled:opacity-40"
            >
              Create
            </button>
          </div>
          {note && <div className="mt-2 font-mono text-[10.5px] text-danger">{note}</div>}
        </div>
      )}

      {info?.issues.map((i) => (
        <a
          key={i.number}
          href={i.url}
          target="_blank"
          rel="noreferrer"
          className="mb-2 block rounded-[10px] border border-border bg-card p-3 hover:border-ring"
        >
          <div className="flex gap-2.5">
            <span className="mt-0.5 h-3 w-3 shrink-0 rounded-full border-2 border-success" />
            <div className="min-w-0 flex-1">
              <div className="text-[13px] leading-snug text-card-foreground">{i.title}</div>
              <div className="mt-1.5 flex flex-wrap items-center gap-2">
                <span className="font-mono text-[10.5px] text-muted-2">#{i.number}</span>
                {i.labels.map((l) => (
                  <span
                    key={l.name}
                    className="rounded-full px-2 text-[10px]"
                    style={{
                      color: `#${l.color}`,
                      background: `#${l.color}22`,
                      border: `1px solid #${l.color}55`,
                    }}
                  >
                    {l.name}
                  </span>
                ))}
                <span className="ml-auto font-mono text-[10.5px] text-muted-2">
                  {ago(new Date(i.updated).getTime() / 1000)}
                </span>
              </div>
            </div>
          </div>
        </a>
      ))}
      {info && info.issues.length === 0 && !creating && (
        <div className="px-1 py-2 text-xs text-muted-foreground">No open issues.</div>
      )}
    </div>
  );
}
