export type View = "chat" | "history" | "memory";

const LABELS: Record<View, string> = { chat: "CHAT", history: "HIST", memory: "MEM" };

/* Shared CHAT / HIST / MEM switcher in the Terminal header. */
export function ViewTabs({ view, onView }: { view: View; onView: (v: View) => void }) {
  return (
    <div style={{ display: "flex" }}>
      {(["chat", "history", "memory"] as const).map((v) => (
        <button key={v} onClick={() => onView(v)}
          style={{ appearance: "none", cursor: "pointer", border: `1px solid ${view === v ? "#7fe9d8" : "rgba(127,233,216,.16)"}`, background: view === v ? "rgba(127,233,216,.08)" : "transparent", color: view === v ? "#dff8f2" : "#3c544f", fontFamily: "inherit", fontSize: 9, letterSpacing: 1.5, padding: "3px 8px" }}>
          {LABELS[v]}
        </button>
      ))}
    </div>
  );
}
