import { useEffect, useRef, useState } from "react";
import { api, type AgentInfo, type WorkflowInfo, type AgentActivity } from "../api";
import { Markdown } from "./Markdown";

type Row = { type: "text"; text: string } | { type: "tool"; name: string; summary: string };

const fmtTok = (n: number) =>
  n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : `${n}`;
const fmtDur = (ms: number) => {
  const s = Math.round(ms / 1000);
  return s >= 3600 ? `${Math.round(s / 360) / 10}h` : s >= 60 ? `${Math.round(s / 60)}m` : `${s}s`;
};

const dot = (running: boolean, size = 6) => (
  <span style={{ width: size, height: size, borderRadius: "50%", flex: "none",
                 background: running ? "var(--ok)" : "var(--txl)" }} />
);

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
  const [selected, setSelected] = useState<string | null>(
    agents[0]?.agent_id ??
      (firstWf?.agents[0] ? `${firstWf.run_id}::${firstWf.agents[0].agent_id}` : null),
  );
  const [expanded, setExpanded] = useState<Set<string>>(
    () => (agents.length === 0 && firstWf ? new Set([firstWf.run_id]) : new Set()),
  );
  const [escHov, setEscHov] = useState(false);
  const cursorRef = useRef(0);
  const [events, setEvents] = useState<Row[]>([]);
  const [activityData, setActivityData] = useState<AgentActivity | null>(null);
  const feedRef = useRef<HTMLDivElement>(null);

  const toggle = (id: string) =>
    setExpanded((s) => {
      const n = new Set(s);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });

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

  return (
    <div
      onClick={onClose}
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
        <div style={{ display: "flex", alignItems: "center", padding: "10px 14px",
                      borderBottom: "1px solid color-mix(in srgb, var(--acc) 16%, transparent)",
                      background: "color-mix(in srgb, var(--panel2) 90%, transparent)" }}>
          <span style={{ fontSize: "var(--t11)", letterSpacing: 1.5, color: "var(--txm)" }}>
            {workflows.length ? "AGENTS · WORKFLOWS" : "AGENTS"}
          </span>
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
        <div style={{ display: "grid", gridTemplateColumns: "300px 1fr", flex: 1, minHeight: 0 }}>
          <div className="mscroll" style={{ borderRight: "1px solid color-mix(in srgb, var(--acc) 14%, transparent)",
                       overflowY: "auto", minHeight: 0 }}>
            {agents.map((a) => {
              const on = a.agent_id === selected;
              return (
                <div key={a.agent_id} onClick={() => setSelected(a.agent_id)}
                     style={{ padding: "9px 11px", cursor: "pointer",
                              borderLeft: `2px solid ${on ? "var(--acc)" : "transparent"}`,
                              background: on ? "color-mix(in srgb, var(--acc) 8%, transparent)" : "transparent" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    {dot(a.status === "running")}
                    <span style={{ fontSize: "var(--t12)", color: "var(--txh)", overflow: "hidden",
                                   textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {a.description || a.agent_id}
                    </span>
                  </div>
                  <div style={{ fontSize: "var(--t95)", color: "var(--txd)", marginTop: 4 }}>
                    {a.agent_type}{a.spawn_depth > 1 ? ` · depth ${a.spawn_depth}` : ""}
                  </div>
                </div>
              );
            })}

            {workflows.map((w) => {
              const open = expanded.has(w.run_id);
              const meta = [
                `${w.agent_count} agents`,
                w.total_tokens ? `${fmtTok(w.total_tokens)} tok` : "",
                w.duration_ms ? fmtDur(w.duration_ms) : "",
              ].filter(Boolean).join(" · ");
              return (
                <div key={w.run_id}>
                  <div onClick={() => toggle(w.run_id)}
                       style={{ padding: "9px 11px", cursor: "pointer",
                                borderLeft: "2px solid transparent",
                                background: "color-mix(in srgb, var(--acc) 4%, transparent)",
                                borderTop: "1px solid color-mix(in srgb, var(--acc) 10%, transparent)" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      <span style={{ fontSize: "var(--t9)", color: "var(--txd)", width: 8, flex: "none" }}>
                        {open ? "▾" : "▸"}
                      </span>
                      {dot(w.status === "running")}
                      <span style={{ fontSize: "var(--t12)", color: "var(--txh)", overflow: "hidden",
                                     textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        ⛓ {w.name}
                      </span>
                    </div>
                    <div style={{ fontSize: "var(--t95)", color: "var(--txd)", marginTop: 4, paddingLeft: 14 }}>
                      workflow · {meta}
                    </div>
                  </div>
                  {open && w.agents.map((a) => {
                    const key = `${w.run_id}::${a.agent_id}`;
                    const on = key === selected;
                    return (
                      <div key={key} onClick={() => setSelected(key)}
                           style={{ padding: "7px 11px 7px 26px", cursor: "pointer",
                                    borderLeft: `2px solid ${on ? "var(--acc)" : "transparent"}`,
                                    background: on ? "color-mix(in srgb, var(--acc) 8%, transparent)" : "transparent" }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                          {dot(a.status === "running", 5)}
                          <span style={{ fontSize: "var(--t115)", color: "var(--tx)", overflow: "hidden",
                                         textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                            {a.description || `${a.agent_type} · ${a.agent_id.replace(/^agent-/, "").slice(0, 7)}`}
                          </span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              );
            })}
          </div>
          <div ref={feedRef} className="mscroll" style={{ overflowY: "auto", minHeight: 0,
                       padding: 14, display: "flex", flexDirection: "column", gap: 8 }}>
            {events.length === 0 && (
              <div style={{ fontSize: "var(--t11)", color: "var(--txd)" }}>No activity yet.</div>
            )}
            {events.map((e, i) =>
              e.type === "text" ? (
                <div key={i} style={{ fontSize: "var(--t12)", color: "var(--tx)", lineHeight: 1.6 }}>
                  <Markdown>{e.text}</Markdown>
                </div>
              ) : (
                <div key={i} style={{ display: "flex", gap: 8, fontFamily: "'JetBrains Mono',monospace",
                             fontSize: "var(--t11)", color: "var(--txd)" }}>
                  <span style={{ color: "var(--txm)" }}>{e.name}</span>
                  <span style={{ minWidth: 0, wordBreak: "break-all" }}>{e.summary}</span>
                </div>
              ),
            )}
            {activityData?.status === "running" && (
              <div style={{ fontSize: "var(--t11)", color: "var(--txd)" }}>Working…</div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
