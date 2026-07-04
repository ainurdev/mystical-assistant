import { useEffect, useRef, useState } from "react";
import { api, type AgentsInfo } from "../api";
import { AgentsModal } from "./AgentsModal";

export function AgentsPill({
  sessionId,
  running,
}: {
  sessionId: string | null;
  running: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [hov, setHov] = useState(false);
  const [data, setData] = useState<AgentsInfo | null>(null);
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
        if (live && runningRef.current) {
          setTimeout(poll, 1500);
        }
      } catch { /* ignore */ }
    };
    void poll();
    return () => { live = false; };
  }, [sessionId, running]);

  if (!sessionId || !data || data.total === 0) return null;
  const working = data.running > 0;
  const label = working ? `${data.running} agents working` : `${data.total} agents ran`;
  return (
    <>
      <button
        onClick={() => setOpen(true)}
        onMouseEnter={() => setHov(true)} onMouseLeave={() => setHov(false)}
        style={{ appearance: "none", cursor: "pointer", alignSelf: "flex-start",
                 display: "inline-flex", alignItems: "center", gap: 7,
                 border: `1px solid rgba(127,233,216,${working ? 0.45 : 0.28})`,
                 background: hov ? "color-mix(in srgb, var(--acc) 12%, transparent)"
                                 : `rgba(127,233,216,${working ? 0.08 : 0.04})`,
                 color: working ? "var(--acc)" : "var(--txm)", fontFamily: "inherit", fontSize: 11,
                 letterSpacing: 0.5, padding: "4px 12px", borderRadius: 999,
                 transition: "background .15s ease" }}
      >
        <span style={{ width: 6, height: 6, borderRadius: "50%",
                       background: working ? "var(--ok)" : "var(--txl)",
                       animation: working ? "mpulse 2.4s infinite" : "none" }} />
        {label}
      </button>
      {open && (
        <AgentsModal
          sessionId={sessionId}
          agents={data.agents}
          workflows={data.workflows ?? []}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}
