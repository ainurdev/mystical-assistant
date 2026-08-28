import { useEffect, useRef, useState } from "react";
import { api, type SessionBreakdown, type ToolSpend } from "../../api";

/** Header button + dropdown: where this session's wall clock and tokens went.
 *
 *  Ranked by union time, so the row at the top is the thing actually holding the
 *  session. Waiting on a human is kept out of tool time — a session that sat half
 *  an hour on a question was not slow, and saying so would be a lie the numbers
 *  can't defend.
 *
 *  Polls while a turn runs: a turn that dies at the cap is exactly the one you
 *  want to look at before it dies. */

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

type Row = { label: string; secs: number; tint: string; note?: string; title?: string };

/** Every line the bar chart draws, biggest first. Tools, plus the three spans
 *  that aren't tools: waiting on you, thinking, and generating. */
function rowsOf(b: SessionBreakdown): Row[] {
  const rows: Row[] = Object.entries(b.tools).map(([name, t]: [string, ToolSpend]) => ({
    label: name,
    secs: t.union_s,
    tint: "var(--acc)",
    // Equal means the calls never overlapped each other — so running them
    // concurrently is still available as a fix. That is the actionable bit.
    note: [
      `${t.calls}×`,
      t.calls > 1 && t.naive_s - t.union_s < 1 ? "serial" : null,
      t.unfinished ? `${t.unfinished} killed` : null,
    ].filter(Boolean).join(" · "),
    title: `${t.calls} calls, avg ${secs(t.avg_s)}`
      + (t.naive_s - t.union_s >= 1
        ? ` — ${secs(t.naive_s)} summed, ${secs(t.union_s)} of real time (they overlapped)`
        : ""),
  }));
  if (b.waiting_s > 0)
    rows.push({
      label: "waiting on you", secs: b.waiting_s, tint: "var(--purple)",
      title: "time inside AskUserQuestion — a human deciding, not the session being slow",
    });
  if (b.thinking_s > 0)
    rows.push({ label: "thinking", secs: b.thinking_s, tint: "var(--txl)" });
  if (b.model_s > 0)
    rows.push({
      label: "generating", secs: b.model_s, tint: "var(--txm)",
      title: "wall clock nothing else claimed",
    });
  return rows.sort((a, c) => c.secs - a.secs);
}

export function SpendPanel({ sessionId, running }: {
  sessionId: string | null;
  /** Poll while a turn is in flight — the numbers move under you. */
  running?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [hover, setHover] = useState(false);
  const [b, setB] = useState<SessionBreakdown | null>(null);
  // A bridge still running pre-restart code has no breakdown route; the path
  // falls through to the transcript one, which answers 200 with a different
  // shape entirely. Recognise that instead of destructuring our way into a crash.
  const [stale, setStale] = useState(false);
  const wrapRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [open]);

  // Load once per session (and again when a turn ends) so the button carries a
  // real number before anyone clicks it; the 5s poll is only worth running while
  // the dropdown is actually open on a live turn.
  useEffect(() => {
    if (!sessionId) return;
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
    if (!open || !running) return () => { live = false; };
    const t = setInterval(load, POLL_MS);
    return () => { live = false; clearInterval(t); };
  }, [open, sessionId, running]);

  if (!sessionId) return null;

  const rows = b ? rowsOf(b) : [];
  const peak = rows.length ? rows[0].secs : 0;
  const tok = b?.tokens;

  return (
    <span ref={wrapRef} style={{ position: "relative", flex: "none", display: "flex" }}>
      <button
        onClick={() => setOpen(!open)}
        title="spend — where this session's time and tokens went"
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        style={{
          appearance: "none", cursor: "pointer", gap: 5,
          border: 0, background: "transparent",
          color: open || hover ? "var(--txb)" : "var(--txm)",
          fontFamily: "var(--mono)", fontSize: "var(--t10)",
          padding: 0, display: "flex", alignItems: "center",
        }}
      >
        <span aria-hidden style={{ color: "var(--txl)" }}>{"⏱︎"}</span>
        {b ? secs(b.wall) : "·"}
        {!!b?.capped && (
          <span title={`${b.capped} turns killed by the per-turn time cap`}
            style={{ width: 5, height: 5, borderRadius: "50%", background: "var(--red)", boxShadow: "0 0 6px var(--red)" }} />
        )}
      </button>

      {open && (
        <div style={{
          position: "absolute", top: "calc(100% + 8px)", right: 0, zIndex: 60, width: 330,
          border: "1px solid color-mix(in srgb, var(--acc) 40%, transparent)",
          background: "color-mix(in srgb, var(--panel2) 99%, transparent)",
          boxShadow: "0 16px 44px var(--shadow-pop)", animation: "mslide .16s ease both",
        }}>
          <div style={{ padding: "11px 11px 7px", fontSize: "var(--t9)", letterSpacing: 2, color: "var(--acc)", display: "flex", justifyContent: "space-between" }}>
            <span>SPEND</span>
            {b && <span style={{ color: "var(--txl)" }}>{b.turns} TURNS · {secs(b.wall)}</span>}
          </div>

          {stale ? (
            <div style={{ padding: "10px 11px 13px", fontSize: "var(--t10)", color: "var(--txl)" }}>
              the bridge needs a restart before it can answer this
            </div>
          ) : !b ? (
            <div style={{ padding: "10px 11px 13px", fontSize: "var(--t10)", color: "var(--txl)" }}>reading…</div>
          ) : (
            <>
              {!!b.capped && (
                <div title="a turn that hit the per-turn time cap was killed and auto-resumed"
                  style={{ margin: "0 11px 8px", padding: "5px 7px", fontSize: "var(--t10)", color: "var(--red)", border: "1px solid color-mix(in srgb, var(--red) 30%, transparent)" }}>
                  {b.capped} {b.capped === 1 ? "turn" : "turns"} killed by the time cap
                </div>
              )}

              <div style={{ padding: "0 11px 4px", display: "flex", flexDirection: "column", gap: 6 }}>
                {rows.length === 0 && (
                  <div style={{ fontSize: "var(--t10)", color: "var(--txl)", paddingBottom: 8 }}>
                    nothing recorded yet
                  </div>
                )}
                {rows.map((r) => (
                  <div key={r.label} title={r.title}>
                    <div style={{ display: "flex", justifyContent: "space-between", gap: 8, fontSize: "var(--t10)", color: "var(--txm)" }}>
                      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {r.label}
                        {r.note && <span style={{ color: "var(--txl)" }}> {r.note}</span>}
                      </span>
                      <span style={{ flex: "none", color: "var(--txb)" }}>{secs(r.secs)}</span>
                    </div>
                    <div style={{ height: 3, marginTop: 2, background: "color-mix(in srgb, var(--acc) 8%, transparent)" }}>
                      <div style={{ height: "100%", width: `${peak ? (r.secs / peak) * 100 : 0}%`, background: r.tint }} />
                    </div>
                  </div>
                ))}
              </div>

              <div style={{ borderTop: "1px solid color-mix(in srgb, var(--acc) 10%, transparent)", margin: "8px 0 0", padding: "8px 11px 11px", fontSize: "var(--t10)", color: "var(--txl)", display: "flex", justifyContent: "space-between", gap: 8 }}>
                <span>tokens</span>
                {tok ? (
                  <span title={`in ${tok.in} · out ${tok.out} · cache write ${tok.cache_w} · cache read ${tok.cache_r}`} style={{ color: "var(--txm)" }}>
                    {kilo(tok.in + tok.cache_w + tok.cache_r)} in · {kilo(tok.out)} out
                  </span>
                ) : (
                  <span title="no turn in this session reported usage — unknown, not zero">—</span>
                )}
              </div>
            </>
          )}
        </div>
      )}
    </span>
  );
}
