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
  const label =
    data.running > 0 ? `⚡ ${data.running} agents working` : `${data.total} agents ran`;
  return (
    <>
      <button
        onClick={() => setOpen(true)}
        style={{ appearance: "none", cursor: "pointer", alignSelf: "flex-start",
                 border: "1px solid rgba(127,233,216,.35)", background: "rgba(127,233,216,.06)",
                 color: "#7fe9d8", fontFamily: "inherit", fontSize: 11, letterSpacing: 0.5,
                 padding: "4px 11px", borderRadius: 999 }}
      >
        {label}
      </button>
      {open && (
        <AgentsModal
          sessionId={sessionId}
          agents={data.agents}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}
