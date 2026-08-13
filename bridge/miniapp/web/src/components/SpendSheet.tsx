import { useEffect, useState } from "react";
import { Clock, X } from "lucide-react";
import { api, type SessionBreakdown, type ToolSpend } from "../lib/api";

/* SPEND — where this chat's wall clock and tokens went, ranked so the top row is
   the thing actually holding the session.

   Waiting on you is kept out of tool time: a chat that sat half an hour on a
   question was not slow, and folding that in would say it was. Dollars are
   absent on purpose — the CLI prices runs off API list rates while these go
   through a subscription (9f612a4).

   Polls while a turn is running, because the turn you most want to inspect is
   the one still burning toward the cap. */

const POLL_MS = 5000;

function secs(s: number): string {
  if (s < 1) return "0s";
  if (s < 90) return `${Math.round(s)}s`;
  return `${(s / 60).toFixed(1)}m`;
}

function kilo(n: number): string {
  if (n < 1000) return `${n}`;
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

type Row = { label: string; secs: number; note?: string; tone: string };

function rowsOf(b: SessionBreakdown): Row[] {
  const rows: Row[] = Object.entries(b.tools).map(([name, t]: [string, ToolSpend]) => ({
    label: name,
    secs: t.union_s,
    tone: "bg-[var(--brand-soft)]",
    // naive == union means the calls never overlapped, so running them
    // concurrently is still on the table. That is the actionable part.
    note: [
      `${t.calls}×`,
      t.calls > 1 && t.naive_s - t.union_s < 1 ? "serial" : null,
      t.unfinished ? `${t.unfinished} killed` : null,
    ].filter(Boolean).join(" · "),
  }));
  if (b.waiting_s > 0)
    rows.push({ label: "waiting on you", secs: b.waiting_s, tone: "bg-amber-400" });
  if (b.thinking_s > 0)
    rows.push({ label: "thinking", secs: b.thinking_s, tone: "bg-[var(--ac-22)]" });
  if (b.model_s > 0)
    rows.push({ label: "generating", secs: b.model_s, tone: "bg-[var(--tg-hint)]" });
  return rows.sort((a, c) => c.secs - a.secs);
}

export function SpendButton({ sessionId, running }: {
  sessionId: string | null;
  running?: boolean;
}) {
  const [open, setOpen] = useState(false);
  if (!sessionId) return null;
  return (
    <>
      <button
        onClick={() => setOpen(true)}
        aria-label="Spend"
        className="flex shrink-0 items-center gap-1.5 border border-border-bright/60 px-2 py-1.5 text-[var(--tg-hint)] active:opacity-70"
      >
        <Clock size={13} aria-hidden />
      </button>
      {open && (
        <SpendSheet sessionId={sessionId} running={running} onClose={() => setOpen(false)} />
      )}
    </>
  );
}

function SpendSheet({ sessionId, running, onClose }: {
  sessionId: string;
  running?: boolean;
  onClose: () => void;
}) {
  const [b, setB] = useState<SessionBreakdown | null>(null);
  // Pre-restart bridges answer this path with a transcript, not a breakdown.
  const [stale, setStale] = useState(false);

  useEffect(() => {
    let live = true;
    const load = () => {
      void api.sessionBreakdown(sessionId)
        .then((r) => {
          if (!live) return;
          if (!r || typeof r.wall !== "number" || !r.tools) { setStale(true); return; }
          setStale(false);
          setB(r);
        })
        .catch(() => {});
    };
    load();
    if (!running) return () => { live = false; };
    const t = setInterval(load, POLL_MS);
    return () => { live = false; clearInterval(t); };
  }, [sessionId, running]);

  const rows = b ? rowsOf(b) : [];
  const peak = rows.length ? rows[0].secs : 0;
  const tok = b?.tokens;

  return (
    <div className="fixed inset-0 z-50 flex flex-col justify-end bg-black/50" onClick={onClose}>
      <div
        className="flex max-h-[78%] flex-col border-t border-border-bright bg-[var(--tg-bg)] shadow-[0_-16px_44px_rgba(0,0,0,0.6)]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex justify-center pb-0.5 pt-2">
          <span className="h-1 w-9 rounded-full bg-[var(--ac-22)]" />
        </div>
        <div className="flex items-center gap-2 px-3.5 py-2">
          <span className="text-[9.5px] tracking-[2px] text-[var(--brand-soft)]">SPEND</span>
          {b && (
            <span className="text-[9.5px] tracking-wider text-[var(--tg-hint)]">
              {b.turns} TURN{b.turns === 1 ? "" : "S"} · {secs(b.wall)}
            </span>
          )}
          <button onClick={onClose} aria-label="Close" className="ml-auto">
            <X size={16} />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto border-t border-border">
          {stale ? (
            <div className="p-6 text-center text-xs text-[var(--tg-hint)]">
              the bridge needs a restart before it can answer this
            </div>
          ) : !b ? (
            <div className="p-6 text-center text-xs text-[var(--tg-hint)]">reading…</div>
          ) : (
            <>
              {!!b.capped && (
                <div className="mx-3.5 mt-3 border border-red-500/30 px-2.5 py-1.5 text-[11px] text-red-400">
                  {b.capped} {b.capped === 1 ? "turn" : "turns"} killed by the time cap
                </div>
              )}
              <div className="flex flex-col gap-2.5 px-3.5 py-3">
                {rows.length === 0 && (
                  <div className="text-center text-xs text-[var(--tg-hint)]">nothing recorded yet</div>
                )}
                {rows.map((r) => (
                  <div key={r.label}>
                    <div className="flex justify-between gap-2 text-[11px] text-[var(--tg-text)]">
                      <span className="truncate">
                        {r.label}
                        {r.note && <span className="text-[var(--tg-hint)]"> {r.note}</span>}
                      </span>
                      <span className="shrink-0">{secs(r.secs)}</span>
                    </div>
                    <div className="mt-1 h-[3px] bg-[var(--ac-22)]">
                      <div className={`h-full ${r.tone}`} style={{ width: `${peak ? (r.secs / peak) * 100 : 0}%` }} />
                    </div>
                  </div>
                ))}
              </div>
              <div className="flex justify-between border-t border-border px-3.5 py-2.5 text-[11px] text-[var(--tg-hint)]">
                <span>tokens</span>
                {tok ? (
                  <span className="text-[var(--tg-text)]">
                    {kilo(tok.in + tok.cache_w + tok.cache_r)} in · {kilo(tok.out)} out
                  </span>
                ) : (
                  <span title="no turn reported usage — unknown, not zero">—</span>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
