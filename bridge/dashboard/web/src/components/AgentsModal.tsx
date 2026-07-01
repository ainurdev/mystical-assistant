import { useEffect, useRef, useState } from "react";
import { api, type AgentInfo, type AgentActivity } from "../api";
import { Markdown } from "./Markdown";

type Row = { type: "text"; text: string } | { type: "tool"; name: string; summary: string };

export function AgentsModal({
  sessionId,
  agents,
  onClose,
}: {
  sessionId: string;
  agents: AgentInfo[];
  onClose: () => void;
}) {
  const [selected, setSelected] = useState<string | null>(agents[0]?.agent_id ?? null);
  const cursorRef = useRef(0);
  const [events, setEvents] = useState<Row[]>([]);
  const [activityData, setActivityData] = useState<AgentActivity | null>(null);
  const feedRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    cursorRef.current = 0;
    setEvents([]);
    setActivityData(null);
  }, [selected]);

  useEffect(() => {
    if (!selected) return;
    let live = true;
    const poll = async () => {
      try {
        const a = await api.agentActivity(sessionId, selected, cursorRef.current);
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
      style={{ position: "fixed", inset: 0, zIndex: 50, background: "rgba(0,0,0,.55)",
               display: "flex", alignItems: "center", justifyContent: "center" }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="panel"
        style={{ width: "min(900px,92vw)", height: "min(600px,88vh)", display: "flex",
                 flexDirection: "column", border: "1px solid var(--border-bright)",
                 background: "var(--panel)" }}
      >
        <div style={{ display: "flex", alignItems: "center", padding: "10px 14px",
                      borderBottom: "1px solid rgba(127,233,216,.14)" }}>
          <span style={{ fontSize: 11, letterSpacing: 1.5, color: "#9fc7c0" }}>AGENTS</span>
          <span style={{ flex: 1 }} />
          <button onClick={onClose} style={{ appearance: "none", cursor: "pointer",
                  border: "1px solid rgba(127,233,216,.25)", background: "transparent",
                  color: "#9fc7c0", fontFamily: "inherit", fontSize: 11, padding: "2px 8px" }}>
            ✕
          </button>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "300px 1fr", flex: 1, minHeight: 0 }}>
          <div className="mscroll" style={{ borderRight: "1px solid rgba(127,233,216,.14)",
                       overflowY: "auto", minHeight: 0 }}>
            {agents.map((a) => {
              const on = a.agent_id === selected;
              return (
                <div key={a.agent_id} onClick={() => setSelected(a.agent_id)}
                     style={{ padding: "9px 11px", cursor: "pointer",
                              borderLeft: `2px solid ${on ? "#7fe9d8" : "transparent"}`,
                              background: on ? "rgba(127,233,216,.08)" : "transparent" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <span style={{ width: 6, height: 6, borderRadius: "50%",
                                   background: a.status === "running" ? "#8fd9a8" : "#3c544f" }} />
                    <span style={{ fontSize: 12, color: "#cfe9e3", overflow: "hidden",
                                   textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {a.description || a.agent_id}
                    </span>
                  </div>
                  <div style={{ fontSize: 9.5, color: "#3c544f", marginTop: 4 }}>
                    {a.agent_type}{a.spawn_depth > 1 ? ` · depth ${a.spawn_depth}` : ""}
                  </div>
                </div>
              );
            })}
          </div>
          <div ref={feedRef} className="mscroll" style={{ overflowY: "auto", minHeight: 0,
                       padding: 14, display: "flex", flexDirection: "column", gap: 8 }}>
            {events.length === 0 && (
              <div style={{ fontSize: 11, color: "#3c544f" }}>No activity yet.</div>
            )}
            {events.map((e, i) =>
              e.type === "text" ? (
                <div key={i} style={{ fontSize: 12, color: "#bfe6de", lineHeight: 1.6 }}>
                  <Markdown>{e.text}</Markdown>
                </div>
              ) : (
                <div key={i} style={{ display: "flex", gap: 8, fontFamily: "'JetBrains Mono',monospace",
                             fontSize: 11, color: "#6f938d" }}>
                  <span style={{ color: "#9fc7c0" }}>{e.name}</span>
                  <span style={{ minWidth: 0, wordBreak: "break-all" }}>{e.summary}</span>
                </div>
              ),
            )}
            {activityData?.status === "running" && (
              <div style={{ fontSize: 11, color: "#6f938d" }}>Working…</div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
