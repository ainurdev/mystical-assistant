import { useState } from "react";

export type View = "chat" | "history" | "next";

/* The way back to CHAT from HIST or NEXT: the header's one bordered element (a
   hairline separates meta, a border marks an action). In CHAT it isn't drawn.
   A switch with one position was the brightest thing in the row and did
   nothing. HIST and NEXT themselves are reached from the command palette: they
   are places you go, not ways to read the session you are already in. */
export function ViewTabs({ view, onView }: { view: View; onView: (v: View) => void }) {
  const [hov, setHov] = useState(false);
  if (view === "chat") return null;
  return (
    <button onClick={() => onView("chat")}
      onMouseEnter={() => setHov(true)} onMouseLeave={() => setHov(false)}
      style={{
        appearance: "none", cursor: "pointer", flex: "none",
        border: "1px solid color-mix(in srgb, var(--acc) 30%, transparent)",
        background: hov ? "color-mix(in srgb, var(--acc) 6%, transparent)" : "transparent",
        color: "var(--acc)", fontFamily: "inherit", fontSize: "var(--t95)", letterSpacing: 1.5, padding: "3px 9px",
      }}>
      ← CHAT
    </button>
  );
}
