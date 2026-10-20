import { useEffect, useRef, useState } from "react";
import { api, type AgentsInfo } from "../api";
import type { HudSettings } from "../lib/theme";
import { OPEN_AGENT, setRoster } from "../lib/subagents";
import { AgentsModal, SPIN, fmtSince } from "./AgentsModal";

/** The subagent readout above the composer: how many are working, on what, and
 *  how far through the fan-out this turn is. Click to open the roster. Nothing
 *  here is live-state — the roster is derived from the files Claude Code writes,
 *  and an agent only counts as running while its session's process is alive. */
export function AgentsPill({
  sessionId,
  running,
  hud,
}: {
  sessionId: string | null;
  running: boolean;
  hud?: HudSettings;
}) {
  // false = shut; true = open on the first agent; a string = open on that agent.
  const [open, setOpen] = useState<boolean | string>(false);
  const [hov, setHov] = useState(false);
  const [data, setData] = useState<AgentsInfo | null>(null);
  const [tick, setTick] = useState(0);
  const runningRef = useRef(running);
  runningRef.current = running;

  useEffect(() => {
    if (!sessionId) return;
    let live = true;
    const poll = async () => {
      try {
        const d = await api.agents(sessionId);
        if (!live) return;
        setData(d);
        setRoster(d);            // the transcript's AGENT plates read it (lib/subagents)
        if (live && (runningRef.current || d.running > 0)) {
          setTimeout(poll, 1500);
        }
      } catch { /* ignore */ }
    };
    void poll();
    return () => { live = false; };
  }, [sessionId, running]);

  useEffect(() => () => setRoster(null), [sessionId]);

  // An AGENT plate's open ↗ (lib/subagents openAgent).
  useEffect(() => {
    const onOpen = (e: Event) => setOpen((e as CustomEvent<string>).detail);
    window.addEventListener(OPEN_AGENT, onOpen);
    return () => window.removeEventListener(OPEN_AGENT, onOpen);
  }, []);

  // Spinner frame + live elapsed, only while something is actually working.
  const working = (data?.running ?? 0) > 0;
  useEffect(() => {
    if (!working) return;
    const id = setInterval(() => setTick((t) => t + 1), 110);
    return () => clearInterval(id);
  }, [working]);

  if (!sessionId || !data || data.total === 0) return null;
  const all = [...data.agents, ...(data.workflows ?? []).flatMap((w) => w.agents)];
  const live = all.filter((a) => a.status === "running");
  const done = data.total - data.running;
  const oldest = live.reduce((m, a) => (a.started_at && a.started_at < m ? a.started_at : m),
                             Number.POSITIVE_INFINITY);
  // The newest one carries the most useful "what is it doing" — the oldest is
  // usually the long tail everyone forgot about.
  const newest = live.reduce<typeof live[number] | null>(
    (m, a) => (!m || a.started_at > m.started_at ? a : m), null);
  const tint = working ? "var(--ok)" : "var(--txd)";
  return (
    <>
      <button
        onClick={() => setOpen(true)}
        onMouseEnter={() => setHov(true)} onMouseLeave={() => setHov(false)}
        title={all.map((a) => `${a.status === "running" ? "▶" : "✓"} ${a.description || a.agent_type}`)
                  .join("\n") || "subagents"}
        style={{ appearance: "none", cursor: "pointer", alignSelf: "flex-start", maxWidth: "100%",
                 display: "inline-flex", alignItems: "center", gap: 8,
                 border: `1px solid color-mix(in srgb, ${tint} ${working ? 40 : 26}%, transparent)`,
                 background: `color-mix(in srgb, ${tint} ${hov ? 14 : working ? 8 : 4}%, transparent)`,
                 color: tint, fontFamily: "inherit", fontSize: "var(--t11)",
                 letterSpacing: 0.5, padding: "4px 12px", borderRadius: 999,
                 transition: "background .15s ease, border-color .15s ease" }}
      >
        {working ? (
          <span style={{ fontFamily: "'JetBrains Mono',monospace", flex: "0 0 auto",
                         width: 9, textAlign: "center" }}>
            {SPIN[tick % SPIN.length]}
          </span>
        ) : (
          <span style={{ width: 6, height: 6, borderRadius: "50%", flex: "0 0 auto",
                         border: `1.5px solid ${tint}`, boxSizing: "border-box" }} />
        )}
        <span style={{ flex: "0 0 auto" }}>
          {working ? `${data.running} working` : `${data.total} agents ran`}
        </span>
        {working && newest?.description && (
          <span className="pill-desc" style={{ color: "var(--txm)", overflow: "hidden", minWidth: 0,
                         textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {newest.description}
          </span>
        )}
        {working && (
          <>
            {/* done / total, so a long fan-out reads as progress, not a number */}
            <span style={{ flex: "0 0 auto", width: 34, height: 3, borderRadius: 2,
                           background: "color-mix(in srgb, var(--txd) 35%, transparent)" }}>
              <span style={{ display: "block", height: "100%", borderRadius: 2,
                             width: `${Math.round((done / data.total) * 100)}%`,
                             background: tint, transition: "width .4s ease" }} />
            </span>
            <span style={{ flex: "0 0 auto", color: "var(--txd)",
                           fontVariantNumeric: "tabular-nums" }}>
              {Number.isFinite(oldest) ? fmtSince(oldest) : ""}
            </span>
          </>
        )}
      </button>
      {open && (
        <AgentsModal
          sessionId={sessionId}
          agents={data.agents}
          workflows={data.workflows ?? []}
          initial={typeof open === "string" ? open : null}
          hud={hud}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}
