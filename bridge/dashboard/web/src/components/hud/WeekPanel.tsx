import { useEffect, useRef, useState, type CSSProperties } from "react";
import { api, type TodayInfo, type WeeklyReport } from "../../api";

/** The strip's TODAY chip, now clickable: the dropdown is the weekly report —
 *  which projects the week went into, sessions/turns/time per project, a
 *  per-day rhythm strip, and the delta against the week before.
 *
 *  Time and tokens, never dollars: the CLI prices subscription runs at API
 *  list rate (9f612a4), so a dollar line here would be confidently wrong. */

function fmtTokens(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${Math.round(n / 1e3)}K`;
  return String(n);
}

function dur(s: number): string {
  if (s < 60) return `${Math.round(s)}s`;
  if (s < 5400) return `${Math.round(s / 60)}m`;
  return `${(s / 3600).toFixed(1)}h`;
}

function pct(cur: number, prev: number): string {
  const n = Math.round((100 * (cur - prev)) / prev);
  return n >= 0 ? `+${n}%` : `−${Math.abs(n)}%`;
}

/** Last two path segments — a bare basename like "app" says nothing. */
function shortName(project: string): string {
  const parts = project.split("/").filter(Boolean);
  return parts.slice(-2).join("/") || project;
}

const seg = (on: boolean): CSSProperties => ({
  appearance: "none", cursor: "pointer", border: 0,
  background: on ? "color-mix(in srgb, var(--acc) 16%, transparent)" : "transparent",
  color: on ? "var(--txb)" : "var(--txd)",
  fontFamily: "inherit", fontSize: "var(--t9)", letterSpacing: "1px", padding: "3px 8px",
});

/** Mon..Sun columns for the report's span; days with no activity stay as
 *  baseline ticks so the week keeps its shape. */
function DayStrip({ rep }: { rep: WeeklyReport }) {
  const byDay = new Map(rep.days.map((d) => [d.day, d]));
  const days = Array.from({ length: 7 }, (_, i) => {
    // Noon, not midnight, so a DST edge can't bleed the label into the
    // neighbouring date.
    const d = new Date((rep.since + i * 86400) * 1000 + 12 * 3600 * 1000);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    return { label: "MTWTFSS"[i], key, ...(byDay.get(key) ?? { turns: 0, elapsed: 0 }) };
  });
  const peak = Math.max(...days.map((d) => d.elapsed), 1);
  return (
    <div style={{ display: "flex", gap: 4, alignItems: "flex-end", padding: "2px 11px 10px", height: 34 }}>
      {days.map((d, i) => (
        <div key={i} title={`${d.key} — ${d.turns} turns · ${dur(d.elapsed)}`}
          style={{ flex: 1, display: "flex", flexDirection: "column", gap: 2, alignItems: "stretch" }}>
          <div style={{
            height: Math.max(2, Math.round((d.elapsed / peak) * 24)),
            background: d.elapsed ? "var(--acc)" : "color-mix(in srgb, var(--acc) 14%, transparent)",
          }} />
          <div style={{ fontSize: "var(--t7)", textAlign: "center", color: "var(--txf)", letterSpacing: "1px" }}>{d.label}</div>
        </div>
      ))}
    </div>
  );
}

export function WeekPanel() {
  const [today, setToday] = useState<TodayInfo | null>(null);
  const [open, setOpen] = useState(false);
  const [hover, setHover] = useState(false);
  const [back, setBack] = useState(0);
  const [rep, setRep] = useState<WeeklyReport | null>(null);
  // A bridge still running pre-restart code has no /local/report route — say
  // "restart" instead of spinning forever (the SpendPanel posture).
  const [stale, setStale] = useState(false);
  const wrapRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    let live = true;
    const load = () => void api.today().then((r) => { if (live) setToday(r); }).catch(() => {});
    load();
    const t = setInterval(load, 60_000);
    return () => { live = false; clearInterval(t); };
  }, []);

  useEffect(() => {
    if (!open) return;
    let live = true;
    setRep(null);
    api.report(back)
      .then((r) => { if (live) { setRep(r); setStale(false); } })
      .catch(() => { if (live) setStale(true); });
    return () => { live = false; };
  }, [open, back]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [open]);

  if (!today || !today.turns) return null;

  const t = rep?.totals;
  const peak = rep?.projects.length ? rep.projects[0].elapsed : 0;
  const range = rep
    ? `${new Date(rep.since * 1000).toLocaleDateString(undefined, { month: "short", day: "numeric" })} – ${new Date((rep.until - 43200) * 1000).toLocaleDateString(undefined, { month: "short", day: "numeric" })}`
    : "";

  return (
    <span ref={wrapRef} style={{ position: "relative", flex: "none", display: "flex" }}>
      <button
        onClick={() => setOpen(!open)}
        title={`Since midnight: ${today.turns} turn${today.turns === 1 ? "" : "s"}, `
          + `${today.tokens.toLocaleString()} tokens — click for the week per project`}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        style={{
          appearance: "none", cursor: "pointer",
          border: `1px solid color-mix(in srgb, var(--acc) ${open ? 45 : hover ? 25 : 0}%, transparent)`,
          background: open || hover ? "color-mix(in srgb, var(--acc) 8%, transparent)" : "transparent",
          display: "flex", alignItems: "center", gap: "6px", fontSize: "var(--t10)",
          letterSpacing: "1.5px", color: "var(--txd)", flex: "none",
          fontFamily: "inherit", padding: "3px 6px",
        }}
      >
        TODAY
        <span style={{ color: "var(--tx)" }}>{today.turns}</span>
        <span style={{ color: "var(--txf)" }}>TURNS</span>
        <span style={{ color: "var(--tx)" }}>{fmtTokens(today.tokens)}</span>
        <span style={{ color: "var(--txf)" }}>TOK</span>
      </button>

      {open && (
        <div style={{
          position: "absolute", top: "calc(100% + 8px)", left: 0, zIndex: 60, width: 360,
          border: "1px solid color-mix(in srgb, var(--acc) 40%, transparent)",
          background: "color-mix(in srgb, var(--panel2) 99%, transparent)",
          boxShadow: "0 16px 44px var(--shadow-pop)", animation: "mslide .16s ease both",
        }}>
          <div style={{ padding: "11px 11px 7px", fontSize: "var(--t9)", letterSpacing: 2, color: "var(--acc)", display: "flex", alignItems: "center", gap: 8 }}>
            <span>WEEK</span>
            <span style={{ color: "var(--txl)", letterSpacing: 1 }}>{range}</span>
            <span style={{ flex: 1 }} />
            <span style={{ display: "flex", border: "1px solid color-mix(in srgb, var(--acc) 18%, transparent)" }}>
              <button onClick={() => setBack(0)} style={seg(back === 0)}>THIS</button>
              <button onClick={() => setBack(1)} style={seg(back === 1)}>LAST</button>
            </span>
          </div>

          {stale ? (
            <div style={{ padding: "10px 11px 13px", fontSize: "var(--t10)", color: "var(--txl)" }}>
              the bridge needs a restart before it can answer this
            </div>
          ) : !rep ? (
            <div style={{ padding: "10px 11px 13px", fontSize: "var(--t10)", color: "var(--txl)" }}>reading…</div>
          ) : !rep.projects.length ? (
            <div style={{ padding: "10px 11px 13px", fontSize: "var(--t10)", color: "var(--txl)" }}>
              nothing ran this week
            </div>
          ) : (
            <>
              <div style={{ padding: "0 11px 8px", fontSize: "var(--t10)", color: "var(--txm)", display: "flex", justifyContent: "space-between", gap: 8 }}>
                <span>
                  {t!.sessions} session{t!.sessions === 1 ? "" : "s"} · {t!.turns} turn{t!.turns === 1 ? "" : "s"} · {dur(t!.elapsed)}
                </span>
                {rep.prev.turns > 0 && (
                  <span title="vs the week before" style={{ color: "var(--txl)" }}>
                    {pct(t!.turns, rep.prev.turns)} turns{rep.prev.elapsed ? ` · ${pct(t!.elapsed, rep.prev.elapsed)} time` : ""}
                  </span>
                )}
              </div>

              <DayStrip rep={rep} />

              <div style={{ padding: "0 11px 4px", display: "flex", flexDirection: "column", gap: 6 }}>
                {rep.projects.map((p) => (
                  <div key={p.project} title={`${p.project}${p.models.length ? ` — ${p.models.join(", ")}` : ""}`}>
                    <div style={{ display: "flex", justifyContent: "space-between", gap: 8, fontSize: "var(--t10)", color: "var(--txm)" }}>
                      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {shortName(p.project)}
                        <span style={{ color: "var(--txl)" }}>
                          {" "}{p.sessions} sess · {p.turns} turns{p.tokens !== null ? ` · ${fmtTokens(p.tokens)} tok` : ""}
                        </span>
                      </span>
                      <span style={{ flex: "none", color: "var(--txb)" }}>{dur(p.elapsed)}</span>
                    </div>
                    <div style={{ height: 3, marginTop: 2, background: "color-mix(in srgb, var(--acc) 8%, transparent)" }}>
                      <div style={{ height: "100%", width: `${peak ? (p.elapsed / peak) * 100 : 0}%`, background: "var(--acc)" }} />
                    </div>
                  </div>
                ))}
              </div>

              <div style={{ borderTop: "1px solid color-mix(in srgb, var(--acc) 10%, transparent)", margin: "8px 0 0", padding: "8px 11px 11px", fontSize: "var(--t10)", color: "var(--txl)", display: "flex", justifyContent: "space-between", gap: 8 }}>
                <span>tokens</span>
                {t!.tokens ? (
                  <span
                    title={`in ${t!.tokens.in.toLocaleString()} · out ${t!.tokens.out.toLocaleString()} · cache write ${t!.tokens.cache_w.toLocaleString()} · cache read ${t!.tokens.cache_r.toLocaleString()}`}
                    style={{ color: "var(--txm)" }}
                  >
                    {fmtTokens(t!.tokens.in)} in · {fmtTokens(t!.tokens.out)} out · {fmtTokens(t!.tokens.cache_r + t!.tokens.cache_w)} cache
                  </span>
                ) : (
                  <span title="no turn this week reported usage — unknown, not zero">—</span>
                )}
              </div>
            </>
          )}
        </div>
      )}
    </span>
  );
}
