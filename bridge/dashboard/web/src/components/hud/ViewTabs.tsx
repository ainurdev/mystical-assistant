import { useState } from "react";

export type View = "chat" | "history" | "next";

const LABELS: Record<View, string> = { chat: "CHAT", history: "HIST", next: "NEXT" };

/* View switcher in the Terminal header — the header's ONE bordered element (a
   hairline separates meta, a border marks an action). HIST and NEXT are
   reachable from the command palette, not from here: they are places you go,
   not ways to read the session you are already in. */
export function ViewTabs({ view, onView }: { view: View; onView: (v: View) => void }) {
  const [hov, setHov] = useState<View | null>(null);
  return (
    <div style={{ display: "flex", border: "1px solid color-mix(in srgb, var(--acc) 18%, transparent)" }}>
      {(["chat"] as const).map((v) => (
        <button key={v} onClick={() => onView(v)}
          onMouseEnter={() => setHov(v)} onMouseLeave={() => setHov(null)}
          style={{
            appearance: "none", cursor: "pointer", border: 0,
            background: view === v ? "var(--acc)" : hov === v ? "color-mix(in srgb, var(--acc) 6%, transparent)" : "transparent",
            color: view === v ? "var(--acc-on)" : hov === v ? "var(--tx)" : "var(--txf)",
            fontFamily: "inherit", fontSize: "var(--t95)", letterSpacing: 1.5, padding: "3px 9px",
          }}>
          {LABELS[v]}
        </button>
      ))}
    </div>
  );
}
