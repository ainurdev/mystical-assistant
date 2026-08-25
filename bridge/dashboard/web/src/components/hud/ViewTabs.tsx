export type View = "chat" | "history" | "next";

/* Shared CHAT / CANVAS switcher in the Terminal header. Both land on the same
   view — CANVAS only changes how the turns are laid out (scroller vs board), so
   it is a flag on the chat view rather than a view of its own. That is what
   keeps the board on when you switch sessions: every path that resets the view
   to "chat" leaves the flag alone. */
export function ViewTabs({
  view, onView, canvas, onCanvas,
}: {
  view: View;
  onView: (v: View) => void;
  canvas?: boolean;
  onCanvas?: (on: boolean) => void;
}) {
  const tabs: { label: string; on: boolean; go: () => void }[] = [
    { label: "CHAT", on: view === "chat" && !canvas, go: () => { onView("chat"); onCanvas?.(false); } },
  ];
  if (onCanvas) {
    tabs.push({ label: "CANVAS", on: view === "chat" && !!canvas, go: () => { onView("chat"); onCanvas(true); } });
  }
  return (
    <div style={{ display: "flex" }}>
      {tabs.map((t) => (
        <button key={t.label} onClick={t.go}
          style={{ appearance: "none", cursor: "pointer", border: `1px solid ${t.on ? "var(--acc)" : "color-mix(in srgb, var(--acc) 16%, transparent)"}`, background: t.on ? "color-mix(in srgb, var(--acc) 8%, transparent)" : "transparent", color: t.on ? "var(--txb)" : "var(--txl)", fontFamily: "inherit", fontSize: "var(--t9)", letterSpacing: 1.5, padding: "3px 8px" }}>
          {t.label}
        </button>
      ))}
    </div>
  );
}
