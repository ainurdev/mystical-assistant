import { useEffect, useRef, useState } from "react";
import { api, type AgentInfo, type WorkflowInfo, type AgentActivity } from "../api";
import { Markdown } from "./Markdown";

type Row = { type: "text"; text: string } | { type: "tool"; name: string; summary: string };

export const SPIN = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

const fmtTok = (n: number) =>
  n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : `${n}`;
const fmtDur = (ms: number) => {
  const s = Math.round(ms / 1000);
  return s >= 3600 ? `${Math.round(s / 360) / 10}h` : s >= 60 ? `${Math.round(s / 60)}m` : `${s}s`;
};
/** Elapsed since an epoch-seconds stamp, in the same units as fmtDur. */
export const fmtSince = (epochSec: number) =>
  !epochSec ? "" : fmtDur(Math.max(0, Date.now() - epochSec * 1000));
/** How long an agent has been at it — live for a runner, start→last-write for a
 *  finished one, so a done row still says what it cost. */
const fmtSpan = (a: { status: string; started_at: number; updated_at: number }) =>
  a.status === "running" ? fmtSince(a.started_at)
    : a.updated_at > a.started_at ? fmtDur((a.updated_at - a.started_at) * 1000) : "";

const CHIP = (tint: string) => ({
  fontSize: "var(--t9)", letterSpacing: 1.5, padding: "2px 7px", flex: "none" as const,
  border: `1px solid color-mix(in srgb, ${tint} 34%, transparent)`,
  background: `color-mix(in srgb, ${tint} 9%, transparent)`, color: tint,
});

/** Status glyph: a live braille spinner while the agent runs, a hollow ring once
 *  it's done — the same vocabulary the HUD's working indicator uses. */
function Glyph({ running, frame, size = 6 }: { running: boolean; frame: number; size?: number }) {
  if (running) {
    return (
      <span style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: "var(--t105)",
                     color: "var(--ok)", width: 10, flex: "none", textAlign: "center" }}>
        {SPIN[frame % SPIN.length]}
      </span>
    );
  }
  return (
    <span style={{ width: 10, flex: "none", display: "inline-flex", justifyContent: "center" }}>
      <span style={{ width: size, height: size, borderRadius: "50%", boxSizing: "border-box",
                     border: "1.5px solid var(--txl)" }} />
    </span>
  );
}

export function AgentsModal({
  sessionId,
  agents,
  workflows,
  onClose,
}: {
  sessionId: string;
  agents: AgentInfo[];
  workflows: WorkflowInfo[];
  onClose: () => void;
}) {
  // Selection key: bare agent_id for a regular agent, "<run_id>::<agent_id>" for
  // a workflow sub-agent (so agent_activity is fetched from the right dir).
  const firstWf = workflows[0];
  const [selected, setSelected] = useState<string | null>(() => {
    // Open on what's working — with a long roster the finished ones are history.
    const live = agents.find((a) => a.status === "running");
    if (live) return live.agent_id;
    const liveWf = workflows.find((w) => w.status === "running");
    if (liveWf?.agents[0]) return `${liveWf.run_id}::${liveWf.agents[0].agent_id}`;
    const last = agents[agents.length - 1];
    return last?.agent_id
      ?? (firstWf?.agents[0] ? `${firstWf.run_id}::${firstWf.agents[0].agent_id}` : null);
  });
  const [expanded, setExpanded] = useState<Set<string>>(
    () => new Set(workflows.filter((w) => w.status === "running" || agents.length === 0)
                           .map((w) => w.run_id)),
  );
  const [escHov, setEscHov] = useState(false);
  const [tick, setTick] = useState(0);
  const cursorRef = useRef(0);
  const [events, setEvents] = useState<Row[]>([]);
  const [activityData, setActivityData] = useState<AgentActivity | null>(null);
  const feedRef = useRef<HTMLDivElement>(null);

  const wfAgents = workflows.flatMap((w) => w.agents);
  const liveCount = [...agents, ...wfAgents].filter((a) => a.status === "running").length;
  const total = agents.length + wfAgents.length;

  const toggle = (id: string) =>
    setExpanded((s) => {
      const n = new Set(s);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    if (!liveCount) return;                    // no spinner, no clock, when idle
    const id = setInterval(() => setTick((t) => t + 1), 110);
    return () => clearInterval(id);
  }, [liveCount]);

  useEffect(() => {
    cursorRef.current = 0;
    setEvents([]);
    setActivityData(null);
  }, [selected]);

  useEffect(() => {
    if (!selected) return;
    const [wf, id] = selected.includes("::")
      ? selected.split("::")
      : [undefined, selected];
    let live = true;
    const poll = async () => {
      try {
        const a = await api.agentActivity(sessionId, id, cursorRef.current, wf);
        if (!live) return;
        if (a.events.length) {
          setEvents((prev) => [...prev, ...a.events]);
        }
        cursorRef.current = a.next_cursor; // always advance: next_cursor counts all lines read
        setActivityData(a);
        if (live && a.status === "running") {
          setTimeout(poll, 1000);
        }
      } catch { /* ignore */ }
    };
    void poll();
    return () => { live = false; };
  }, [sessionId, selected]);

  useEffect(() => {
    feedRef.current?.scrollTo({ top: feedRef.current.scrollHeight });
  }, [events]);

  const sel = selected?.includes("::")
    ? wfAgents.find((a) => `${a.run_id}::${a.agent_id}` === selected)
    : agents.find((a) => a.agent_id === selected);
  const selRunning = (activityData?.status ?? sel?.status) === "running";
  const toolCount = events.filter((e) => e.type === "tool").length;

  const row = (
    key: string, on: boolean, running: boolean, title: string, meta: string,
    onPick: () => void, indent = 0,
  ) => (
    <div key={key} onClick={onPick} title={title}
         style={{ padding: `8px 11px 8px ${11 + indent}px`, cursor: "pointer",
                  borderLeft: `2px solid ${on ? "var(--acc)" : "transparent"}`,
                  background: on ? "color-mix(in srgb, var(--acc) 9%, transparent)"
                                 : running ? "color-mix(in srgb, var(--ok) 4%, transparent)"
                                           : "transparent" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
        <Glyph running={running} frame={tick} />
        <span style={{ fontSize: "var(--t12)", color: running || on ? "var(--txh)" : "var(--txm)",
                       overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {title}
        </span>
      </div>
      <div style={{ fontSize: "var(--t95)", color: "var(--txd)", marginTop: 3, paddingLeft: 17,
                    overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {meta}
      </div>
    </div>
  );

  return (
    <div
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Subagents"
      style={{ position: "fixed", inset: 0, zIndex: 96, background: "color-mix(in srgb, var(--panel3) 72%, transparent)",
               display: "flex", alignItems: "center", justifyContent: "center",
               animation: "backdropIn .2s ease both" }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="panel"
        style={{ width: "min(900px,92vw)", height: "min(600px,88vh)", display: "flex",
                 flexDirection: "column", border: "1px solid color-mix(in srgb, var(--acc) 40%, transparent)",
                 background: "color-mix(in srgb, var(--panel2) 98%, transparent)", boxShadow: "0 0 60px var(--shadow-modal)",
                 animation: "mslide .2s ease both" }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 9, padding: "10px 14px",
                      borderBottom: "1px solid color-mix(in srgb, var(--acc) 16%, transparent)",
                      background: "color-mix(in srgb, var(--panel2) 90%, transparent)" }}>
          <span style={{ fontSize: "var(--t11)", letterSpacing: 1.5, color: "var(--txm)" }}>
            {workflows.length ? "AGENTS · WORKFLOWS" : "AGENTS"}
          </span>
          {liveCount > 0 && (
            <span style={{ ...CHIP("var(--ok)"), display: "inline-flex", alignItems: "center", gap: 5 }}>
              <span style={{ fontFamily: "'JetBrains Mono',monospace" }}>{SPIN[tick % SPIN.length]}</span>
              {liveCount} RUNNING
            </span>
          )}
          <span style={CHIP("var(--txd)")}>{total} TOTAL</span>
          <span style={{ flex: 1 }} />
          <button onClick={onClose}
                  onMouseEnter={() => setEscHov(true)} onMouseLeave={() => setEscHov(false)}
                  style={{ appearance: "none", cursor: "pointer",
                  border: "1px solid color-mix(in srgb, var(--acc) 25%, transparent)",
                  background: escHov ? "color-mix(in srgb, var(--acc) 8%, transparent)" : "transparent",
                  color: "var(--txm)", fontFamily: "inherit", fontSize: "var(--t95)", letterSpacing: 1.5,
                  padding: "6px 12px" }}>
            ESC ✕
          </button>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "minmax(190px,32%) 1fr", flex: 1, minHeight: 0 }}>
          <div className="mscroll" style={{ borderRight: "1px solid color-mix(in srgb, var(--acc) 14%, transparent)",
                       overflowY: "auto", minHeight: 0 }}>
            {agents.map((a) => row(
              a.agent_id, a.agent_id === selected, a.status === "running",
              a.description || a.agent_id,
              [a.agent_type, a.spawn_depth > 1 ? `depth ${a.spawn_depth}` : "", fmtSpan(a)]
                .filter(Boolean).join(" · "),
              () => setSelected(a.agent_id),
            ))}

            {workflows.map((w) => {
              const open = expanded.has(w.run_id);
              const meta = [
                `${w.agent_count} agents`,
                w.total_tokens ? `${fmtTok(w.total_tokens)} tok` : "",
                w.duration_ms ? fmtDur(w.duration_ms) : "",
              ].filter(Boolean).join(" · ");
              return (
                <div key={w.run_id}>
                  <div onClick={() => toggle(w.run_id)} title={w.summary || w.name}
                       style={{ padding: "9px 11px", cursor: "pointer",
                                borderLeft: "2px solid transparent",
                                background: "color-mix(in srgb, var(--acc) 4%, transparent)",
                                borderTop: "1px solid color-mix(in srgb, var(--acc) 10%, transparent)" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      <span style={{ fontSize: "var(--t9)", color: "var(--txd)", width: 8, flex: "none" }}>
                        {open ? "▾" : "▸"}
                      </span>
                      <Glyph running={w.status === "running"} frame={tick} />
                      <span style={{ fontSize: "var(--t12)", color: "var(--txh)", overflow: "hidden",
                                     textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        ⛓ {w.name}
                      </span>
                    </div>
                    <div style={{ fontSize: "var(--t95)", color: "var(--txd)", marginTop: 4, paddingLeft: 25 }}>
                      workflow · {meta}
                    </div>
                  </div>
                  {open && w.agents.map((a) => {
                    const key = `${w.run_id}::${a.agent_id}`;
                    return row(
                      key, key === selected, a.status === "running",
                      a.description || `${a.agent_type} · ${a.agent_id.replace(/^agent-/, "").slice(0, 7)}`,
                      // the type is already in the title when there's no description
                      [a.description ? a.agent_type : "", fmtSpan(a)].filter(Boolean).join(" · "),
                      () => setSelected(key), 15,
                    );
                  })}
                </div>
              );
            })}
          </div>
          <div style={{ display: "flex", flexDirection: "column", minHeight: 0 }}>
            {sel && (
              <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "9px 14px",
                            borderBottom: "1px solid color-mix(in srgb, var(--acc) 12%, transparent)" }}>
                <Glyph running={selRunning} frame={tick} />
                <span style={{ fontSize: "var(--t12)", color: "var(--txh)", overflow: "hidden",
                               textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {sel.description || activityData?.description || sel.agent_id}
                </span>
                <span style={{ flex: 1 }} />
                <span style={{ fontSize: "var(--t95)", color: "var(--txd)", flex: "none",
                               fontVariantNumeric: "tabular-nums" }}>
                  {[sel.agent_type, toolCount ? `${toolCount} tools` : "",
                    fmtSpan(sel)].filter(Boolean).join(" · ")}
                </span>
              </div>
            )}
            <div ref={feedRef} className="mscroll" style={{ overflowY: "auto", minHeight: 0, flex: 1,
                         padding: 14, display: "flex", flexDirection: "column", gap: 8 }}>
              {events.length === 0 && (
                <div style={{ fontSize: "var(--t11)", color: "var(--txd)" }}>
                  {selRunning ? "Waiting for its first move…" : "No activity recorded."}
                </div>
              )}
              {events.map((e, i) =>
                e.type === "text" ? (
                  <div key={i} style={{ fontSize: "var(--t12)", color: "var(--tx)", lineHeight: 1.6 }}>
                    <Markdown>{e.text}</Markdown>
                  </div>
                ) : (
                  <div key={i} style={{ display: "flex", gap: 8, alignItems: "baseline",
                               fontFamily: "'JetBrains Mono',monospace", fontSize: "var(--t11)" }}>
                    <span style={{ ...CHIP("var(--acc)"), fontSize: "var(--t9)", padding: "1px 6px",
                                   letterSpacing: 1 }}>
                      {e.name}
                    </span>
                    <span style={{ minWidth: 0, color: "var(--txd)", overflowWrap: "anywhere" }}>
                      {e.summary}
                    </span>
                  </div>
                ),
              )}
              {selRunning && (
                <div style={{ display: "flex", alignItems: "center", gap: 7, fontSize: "var(--t11)",
                              color: "var(--ok)" }}>
                  <span style={{ fontFamily: "'JetBrains Mono',monospace" }}>{SPIN[tick % SPIN.length]}</span>
                  working…
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
