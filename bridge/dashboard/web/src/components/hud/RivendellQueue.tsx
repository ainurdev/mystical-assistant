import { useEffect, useState } from "react";
import type { RivendellQueueItem } from "../../api";
import { api } from "../../api";
import { ago } from "../../lib/surfaces";
import { askConfirm } from "../ui/Ask";

const KIND_LABEL: Record<RivendellQueueItem["kind"], string> = {
  review: "REVIEW", impl: "IMPLEMENT", todolist: "TODOLIST", taskdesc: "TASK DESC",
};

// The same request id can sit in two instances' queues (separate id spaces), so
// a row's React key / busy-key must carry the instance too.
const rid = (it: RivendellQueueItem) => `${it.instance_id}|${it.key}`;

/** The rivendell PENDING queue: requests waiting for you to accept (run) or
 *  reject (decline). It sits at the top of the PLUGINS tab and polls while that
 *  tab is showing — requests arrive over the worker's websocket, with no
 *  dashboard event to announce them. Accept claims and starts an autonomous run
 *  (concurrently: each run isolates itself in its own worktree). Reject confirms,
 *  then fails the request back so a later catch-up does not resurrect it. */
export function RivendellQueue({ active }: { active: boolean }) {
  const [items, setItems] = useState<RivendellQueueItem[] | null>(null);
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const [hov, setHov] = useState("");

  useEffect(() => {
    if (!active) return;
    let live = true;
    const load = () =>
      void api.rivendellQueue().then((r) => { if (live) setItems(r.queue); }).catch(() => {});
    load();
    const t = setInterval(load, 4000);
    return () => { live = false; clearInterval(t); };
  }, [active]);

  const decide = async (it: RivendellQueueItem, accept: boolean) => {
    if (!accept) {
      const ok = await askConfirm(
        `Reject this ${KIND_LABEL[it.kind]} request${it.slug ? ` — ${it.slug}` : ""}? ` +
        `It will be marked failed on ${it.instance}.`);
      if (!ok) return;
    }
    const id = rid(it);
    setBusy((b) => new Set(b).add(id));
    try {
      await (accept ? api.acceptRivendell(it.instance_id, it.key)
                    : api.rejectRivendell(it.instance_id, it.key));
      // Drop it now; the next poll reconciles against the worker's truth.
      setItems((cur) => cur?.filter((x) => rid(x) !== id) ?? cur);
    } catch { /* leave it — the poll will refetch */ }
    finally { setBusy((b) => { const n = new Set(b); n.delete(id); return n; }); }
  };

  if (!items || items.length === 0) return null;

  return (
    <div style={{ border: "1px solid color-mix(in srgb, var(--purple) 30%, transparent)",
                  background: "linear-gradient(160deg,color-mix(in srgb, var(--purple) 7%, transparent),color-mix(in srgb, var(--panel) 40%, transparent))",
                  marginBottom: 11, animation: "mslide .22s ease both" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 12px 9px",
                    borderBottom: "1px solid color-mix(in srgb, var(--purple) 16%, transparent)" }}>
        <span style={{ width: 7, height: 7, borderRadius: "50%", background: "var(--purple)", flex: "none",
                       animation: "mpulse 2.4s infinite" }} />
        <span style={{ fontSize: "var(--t9)", letterSpacing: 1.5, color: "var(--purple-h)" }}>QUEUE</span>
        <span style={{ fontSize: "var(--t9)", color: "var(--txl)" }}>{items.length} waiting</span>
      </div>
      <div>
        {items.map((it) => {
          const id = rid(it);
          const on = hov === id;
          const working = busy.has(id);
          return (
            <div
              key={id}
              onMouseEnter={() => setHov(id)} onMouseLeave={() => setHov("")}
              style={{ display: "grid", gridTemplateColumns: "auto 1fr auto", alignItems: "center", gap: 10,
                       padding: "8px 12px", borderTop: "1px solid color-mix(in srgb, var(--purple) 8%, transparent)",
                       background: on ? "color-mix(in srgb, var(--purple) 6%, transparent)" : "transparent",
                       opacity: working ? 0.5 : 1, transition: "background .13s ease" }}
            >
              <span style={{ flex: "none", fontSize: "var(--t8)", letterSpacing: 1, padding: "2px 6px",
                             border: "1px solid color-mix(in srgb, var(--purple) 34%, transparent)",
                             color: "var(--purple-h)" }}>{KIND_LABEL[it.kind]}</span>
              <div style={{ minWidth: 0, display: "flex", flexDirection: "column", gap: 3 }}>
                <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                               fontSize: "var(--t115)", color: "var(--txh)" }}>{it.slug || "(no repo)"}</span>
                <span style={{ display: "flex", gap: 7, fontSize: "var(--t9)", color: "var(--txl)" }}>
                  <span style={{ color: "var(--purple-g)" }}>{it.instance}</span>
                  <span>{ago(it.created_at)}</span>
                </span>
              </div>
              {/* Buttons ride in on hover — quiet until you reach for them, but
                  kept visible while a decision is in flight so the row can't
                  flip back to blank mid-request. */}
              <div style={{ display: "flex", gap: 6, opacity: on || working ? 1 : 0, transition: "opacity .13s ease" }}>
                <button
                  onClick={() => decide(it, true)} disabled={working}
                  title="Accept — run this request now"
                  style={{ appearance: "none", cursor: working ? "default" : "pointer",
                           border: "1px solid color-mix(in srgb, var(--ok) 45%, transparent)",
                           background: "color-mix(in srgb, var(--ok) 12%, transparent)", color: "var(--ok)",
                           fontFamily: "inherit", fontSize: "var(--t9)", letterSpacing: 1, padding: "5px 10px" }}
                >ACCEPT</button>
                <button
                  onClick={() => decide(it, false)} disabled={working}
                  title="Reject — decline this request"
                  style={{ appearance: "none", cursor: working ? "default" : "pointer",
                           border: "1px solid color-mix(in srgb, var(--err) 40%, transparent)",
                           background: "transparent", color: "var(--err-g)",
                           fontFamily: "inherit", fontSize: "var(--t9)", letterSpacing: 1, padding: "5px 10px" }}
                >REJECT</button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
