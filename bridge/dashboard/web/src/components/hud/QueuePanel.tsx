import { useCallback, useEffect, useState } from "react";
import type { QueueGroup, QueueItem, RivendellQueueItem } from "../../api";
import { api } from "../../api";
import { ago } from "../../lib/surfaces";
import { askConfirm } from "../ui/Ask";

const toolBtn = {
  appearance: "none", cursor: "pointer", background: "transparent", color: "var(--txm)",
  border: "1px solid color-mix(in srgb, var(--acc) 20%, transparent)", fontFamily: "inherit",
  fontSize: "var(--t95)", lineHeight: 1.3, padding: "2px 6px",
} as const;

const section = { fontSize: "var(--t9)", letterSpacing: 1.5, color: "var(--txl)", padding: "10px 12px 4px" } as const;

const STATE: Record<QueueItem["status"], { text: string; color: string }> = {
  queued: { text: "QUEUED", color: "var(--warn)" },
  running: { text: "RUNNING", color: "var(--acc)" },
  done: { text: "DONE", color: "var(--ok)" },
  failed: { text: "FAILED", color: "var(--err)" },
};

function Chip({ text, color }: { text: string; color: string }) {
  return (
    <span style={{ flex: "none", fontSize: "var(--t8)", letterSpacing: 1, padding: "2px 6px",
                   border: `1px solid color-mix(in srgb, ${color} 40%, transparent)`, color }}>{text}</span>
  );
}

function Link({ href }: { href: string | null }) {
  if (!href) return null;
  return (
    <button style={toolBtn} title="Open in Rivendell"
      onClick={(e) => { e.stopPropagation(); window.open(href, "_blank", "noopener"); }}>↗</button>
  );
}

/** QUEUE — the real queue: Rivendell's jobs held or running on this bridge, then
 *  every session of the open project that still holds queued prompts, with the
 *  queue ops that exist (pause/resume, bump, remove). Polls while mounted:
 *  Rivendell rows change with no dashboard event, and the per-session SSE
 *  streams are one session each. */
export function QueuePanel({ project, onOpenSession }: {
  project: string | null;
  onOpenSession: (id: string) => void;
}) {
  const [jobs, setJobs] = useState<RivendellQueueItem[]>([]);
  const [groups, setGroups] = useState<QueueGroup[] | null>(null);
  const [busy, setBusy] = useState<Set<string>>(new Set());

  const load = useCallback(() => {
    void api.rivendellQueue().then((r) => setJobs(r.queue)).catch(() => {});
    void api.queueAll(project).then((r) => setGroups(r.sessions)).catch(() => {});
  }, [project]);
  useEffect(() => {
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [load]);

  const op = async (key: string, run: () => Promise<unknown>) => {
    setBusy((b) => new Set(b).add(key));
    try { await run(); load(); } catch { /* the poll reconciles */ }
    finally { setBusy((b) => { const n = new Set(b); n.delete(key); return n; }); }
  };

  const decide = async (it: RivendellQueueItem, accept: boolean) => {
    if (!accept) {
      const ok = await askConfirm(`Reject “${it.label ?? it.slug ?? it.request_id}”? Rivendell asks its requester what to do next.`);
      if (!ok) return;
    }
    await op(`${it.instance_id}|${it.key}`, () =>
      accept ? api.acceptRivendell(it.instance_id, it.key) : api.rejectRivendell(it.instance_id, it.key));
  };

  const empty = jobs.length === 0 && (groups?.length ?? 0) === 0;

  return (
    <div className="panel" style={{ border: "1px solid color-mix(in srgb, var(--acc) 16%, transparent)", background: "color-mix(in srgb, var(--panel) 86%, transparent)", display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "8px 12px" }}>
        <span style={{ fontSize: "var(--t105)", letterSpacing: 2.5, color: "var(--txl)" }}>QUEUE</span>
        <button style={toolBtn} title="refresh" onClick={load}>⟳</button>
      </div>
      <div style={{ height: 1, background: "linear-gradient(90deg,var(--acc),transparent)" }} />
      <div className="mscroll" style={{ flex: 1, minHeight: 0, padding: "0 0 10px" }}>
        {empty && groups !== null && (
          <div style={{ padding: "18px 12px", fontSize: "var(--t95)", color: "var(--txl)" }}>Nothing queued.</div>
        )}
        {jobs.length > 0 && <div style={section}>RIVENDELL</div>}
        {jobs.map((it) => {
          const key = `${it.instance_id}|${it.key}`;
          const working = busy.has(key);
          return (
            <div key={key} style={{ display: "grid", gridTemplateColumns: "auto 1fr auto", alignItems: "center", gap: 8,
                                    padding: "7px 12px", borderTop: "1px solid color-mix(in srgb, var(--acc) 6%, transparent)", opacity: working ? 0.5 : 1 }}>
              <Chip text={it.status === "running" ? "RUNNING" : "HELD"} color={it.status === "running" ? "var(--acc)" : "var(--warn)"} />
              <div style={{ minWidth: 0, display: "flex", flexDirection: "column", gap: 2 }}>
                <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: "var(--t115)", color: "var(--txh)" }}>
                  {it.label ?? it.slug ?? it.request_id}
                </span>
                <span style={{ display: "flex", gap: 7, fontSize: "var(--t9)", color: "var(--txl)" }}>
                  <span style={{ color: "var(--purple-g)" }}>{it.instance}</span>
                  {it.mode && <span>{it.mode}</span>}
                  <span>{ago(it.created_at)}</span>
                </span>
              </div>
              <div style={{ display: "flex", gap: 6 }}>
                <Link href={it.link} />
                {it.status === "running" && it.session_id && (
                  <button style={toolBtn} onClick={() => onOpenSession(it.session_id!)}>OPEN SESSION</button>
                )}
                {it.status === "held" && (
                  <>
                    <button style={{ ...toolBtn, color: "var(--ok)" }} disabled={working} onClick={() => decide(it, true)}>ACCEPT</button>
                    <button style={{ ...toolBtn, color: "var(--err-g)" }} disabled={working} onClick={() => decide(it, false)}>REJECT</button>
                  </>
                )}
              </div>
            </div>
          );
        })}
        {(groups ?? []).map((g) => (
          <div key={g.session_id}>
            <div style={{ ...section, display: "flex", alignItems: "center", gap: 8 }}>
              <button
                style={{ ...toolBtn, border: "none", padding: 0, letterSpacing: 1.5, fontSize: "var(--t9)", color: "var(--txm)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 }}
                title="Open this session" onClick={() => onOpenSession(g.session_id)}
              >{(g.title || g.session_id).toUpperCase()}</button>
              <span style={{ marginLeft: "auto", flex: "none" }}>
                <button style={toolBtn} disabled={busy.has(g.session_id)}
                  onClick={() => op(g.session_id, () => api.queueOp(g.paused ? "resume" : "pause", { session_id: g.session_id }))}>
                  {g.paused ? "RESUME" : "PAUSE"}
                </button>
              </span>
            </div>
            {g.items.map((it) => (
              <div key={it.id} style={{ display: "grid", gridTemplateColumns: "auto 1fr auto", alignItems: "center", gap: 8,
                                        padding: "7px 12px", borderTop: "1px solid color-mix(in srgb, var(--acc) 6%, transparent)" }}>
                <Chip {...STATE[it.status]} />
                <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: "var(--t115)", color: it.status === "done" ? "var(--txm)" : "var(--txh)" }}
                      title={it.error ?? it.text}>
                  {it.label ?? it.text}
                </span>
                <div style={{ display: "flex", gap: 6 }}>
                  <Link href={it.link} />
                  {it.status === "queued" && (
                    <>
                      <button style={toolBtn} title="Run this next" disabled={busy.has(it.id)}
                        onClick={() => op(it.id, () => api.queueOp("bump", { session_id: g.session_id, item_id: it.id }))}>▲</button>
                      <button style={{ ...toolBtn, color: "var(--err-g)" }} title="Remove" disabled={busy.has(it.id)}
                        onClick={() => op(it.id, () => api.queueOp("remove", { session_id: g.session_id, item_id: it.id }))}>✕</button>
                    </>
                  )}
                </div>
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
