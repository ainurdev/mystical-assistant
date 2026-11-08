import { useEffect, useState } from "react";
import { Keys } from "./ui/Keys";
import { isNativeApp } from "../lib/mac";
import { SHORTCUTS, WHERE, type Shortcut } from "../lib/shortcuts";
import type { SendKey } from "../lib/theme";

/* ⌘/ — every shortcut, grouped by where it works (lib/shortcuts' table), in the
   ⌘K palette's box with a filter on top: type "stop" and ⌘. is the one row left.
   It only lists; the keys themselves stay where they work. */
export function ShortcutSheet({ open, sendKey, onClose }: { open: boolean; sendKey: SendKey; onClose: () => void }) {
  const [query, setQuery] = useState("");
  useEffect(() => { if (open) setQuery(""); }, [open]);
  if (!open) return null;

  // The message box sends the way Settings says; the sheet says the same.
  const rows: Shortcut[] = Object.values(SHORTCUTS).map((s) =>
    sendKey !== "ctrl-enter" ? s
      : s === SHORTCUTS.send ? { ...s, keys: "Ctrl+Enter" }
      : s === SHORTCUTS.newline ? { ...s, keys: "Enter" } : s);
  const q = query.trim().toLowerCase();
  const hits = rows.filter((s) => !q || `${s.label} ${s.where}`.toLowerCase().includes(q));
  const app = isNativeApp();

  return (
    <div
      onClick={onClose}
      style={{ position: "fixed", inset: 0, background: "color-mix(in srgb, var(--panel3) 70%, transparent)", zIndex: 90, display: "flex", alignItems: "flex-start", justifyContent: "center", paddingTop: "14vh", animation: "backdropIn .2s ease both" }}
    >
      <div
        role="dialog"
        aria-label="Keyboard shortcuts"
        onClick={(e) => e.stopPropagation()}
        className="panel"
        style={{ width: 560, maxWidth: "92vw", border: "1px solid color-mix(in srgb, var(--acc) 40%, transparent)", background: "color-mix(in srgb, var(--panel2) 97%, transparent)", boxShadow: "0 0 60px var(--shadow-modal),0 0 30px color-mix(in srgb, var(--acc) 8%, transparent)", animation: "modalIn .46s cubic-bezier(.16,.84,.3,1) both" }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 11, padding: "14px 16px", borderBottom: "1px solid color-mix(in srgb, var(--acc) 16%, transparent)" }}>
          <span style={{ color: "var(--acc)" }}>~ ❯</span>
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== "Escape") return;
              e.preventDefault();
              e.stopPropagation(); // App's Escape would close whatever sits under the sheet too
              onClose();
            }}
            placeholder="filter shortcuts…"
            aria-label="Filter shortcuts"
            style={{ flex: 1, background: "transparent", border: 0, outline: "none", color: "var(--txb)", fontFamily: "'JetBrains Mono',monospace", fontSize: "var(--t135)" }}
          />
          <span style={{ fontSize: "var(--t95)", letterSpacing: 1.5, color: "var(--txl)", border: "1px solid color-mix(in srgb, var(--acc) 20%, transparent)", padding: "2px 7px" }}>ESC</span>
        </div>
        <div className="mscroll" style={{ maxHeight: "56vh", overflowY: "auto", padding: "4px 6px 10px" }}>
          {hits.length === 0 && (
            <div style={{ padding: "24px 12px", textAlign: "center", fontSize: "var(--t12)", letterSpacing: 1, color: "var(--txl)" }}>// no shortcut for that</div>
          )}
          {WHERE.map((w) => {
            const group = hits.filter((s) => s.where === w);
            if (!group.length) return null;
            return (
              <section key={w} aria-label={w}>
                <div style={{ padding: "12px 11px 6px", fontSize: "var(--t95)", letterSpacing: 1.5, color: "var(--txl)" }}>{w.toUpperCase()}</div>
                {group.map((s) => (
                  <div key={s.label} style={{ display: "flex", alignItems: "center", gap: 12, padding: "6px 11px" }}>
                    <span style={{ flex: 1, fontSize: "var(--t12)", color: "var(--txh)" }}>
                      {s.label}
                      {s.app && !app && <span style={{ marginLeft: 8, fontSize: "var(--t95)", color: "var(--txl)" }}>· app only</span>}
                    </span>
                    <Keys k={s.keys} />
                  </div>
                ))}
              </section>
            );
          })}
        </div>
      </div>
    </div>
  );
}
