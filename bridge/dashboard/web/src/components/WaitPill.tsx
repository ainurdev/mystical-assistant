import { Hourglass } from "lucide-react";

/** The open session is WAITING on another one (bridge/waits.py): which, how
 *  that one is doing, and the two ways out: wake it now, or drop the wait.
 *  Sending a prompt ends the wait too; the composer's placeholder says so. */
export function WaitPill({ title, word, c, onResume, onCancel }: {
  title: string;
  word: string;   // the other session's state: working, needs you, parked…
  c: string;      // …and its colour, the sidebar's
  onResume: () => void;
  onCancel: () => void;
}) {
  const btn = (label: string, tip: string, strong: boolean, onClick: () => void) => (
    <button onClick={onClick} title={tip}
      style={{ appearance: "none", cursor: "pointer", font: "inherit", fontSize: "var(--t85)", letterSpacing: ".06em",
               padding: "1px 7px", borderRadius: 5, flex: "none", background: "transparent",
               border: `1px solid ${strong ? "var(--purple)" : "color-mix(in srgb, var(--purple) 35%, transparent)"}`,
               color: strong ? "var(--purple-h)" : "var(--txm)" }}>{label}</button>
  );
  return (
    <div title={`Wakes on its own when ${title} finishes. Sending a prompt ends the wait.`}
      style={{ alignSelf: "flex-start", display: "inline-flex", alignItems: "center", gap: 7, maxWidth: "100%",
               height: 24, boxSizing: "border-box", padding: "0 4px 0 9px", borderRadius: 999, whiteSpace: "nowrap",
               border: "1px solid color-mix(in srgb, var(--purple) 40%, transparent)",
               background: "color-mix(in srgb, var(--purple) 8%, transparent)", color: "var(--purple-h)", fontSize: "var(--t105)" }}>
      <Hourglass size={11} strokeWidth={2} aria-hidden style={{ flex: "none", color: "var(--purple)" }} />
      <span style={{ flex: "none" }}>waiting on</span>
      <span style={{ flex: "none", width: 6, height: 6, borderRadius: "50%", background: c }} />
      <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", color: "var(--txh)" }}>{title}</span>
      <span className="pill-desc" style={{ flex: "none", color: "var(--txl)" }}>· {word}</span>
      {btn("RESUME NOW", "Wake it now — don't wait any longer", true, onResume)}
      {btn("CANCEL", "Stop waiting; the session goes idle", false, onCancel)}
    </div>
  );
}
