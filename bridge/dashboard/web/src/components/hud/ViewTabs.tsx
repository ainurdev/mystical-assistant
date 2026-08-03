export type View = "chat" | "history" | "next";

const LABELS: Record<View, string> = { chat: "CHAT", history: "HIST", next: "NEXT" };

/* Shared CHAT / HIST switcher in the Terminal header. */
export function ViewTabs({ view, onView }: { view: View; onView: (v: View) => void }) {
  return (
    <div style={{ display: "flex" }}>
      {(["chat"] as const).map((v) => (
        <button key={v} onClick={() => onView(v)}
          style={{ appearance: "none", cursor: "pointer", border: `1px solid ${view === v ? "var(--acc)" : "color-mix(in srgb, var(--acc) 16%, transparent)"}`, background: view === v ? "color-mix(in srgb, var(--acc) 8%, transparent)" : "transparent", color: view === v ? "var(--txb)" : "var(--txl)", fontFamily: "inherit", fontSize: 9, letterSpacing: 1.5, padding: "3px 8px" }}>
          {LABELS[v]}
        </button>
      ))}
    </div>
  );
}
