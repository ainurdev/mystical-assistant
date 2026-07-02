import { useEffect, useMemo, useRef, useState } from "react";

export interface Command {
  id: string;
  label: string;
  group: string;
  icon: string;
  iconColor?: string;
  run: () => void;
}

/* COMMAND PALETTE — matches the HUD design mock (hud.dc.html lines 1259–1282):
   backdrop + panel with prompt row, ESC badge, and a scrolling command list. */
export function CommandPalette({
  open,
  commands,
  onClose,
}: {
  open: boolean;
  commands: Command[];
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [highlight, setHighlight] = useState(0);
  const [closing, setClosing] = useState(false);
  const closeTimer = useRef<number | null>(null);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return commands;
    return commands.filter(
      (c) => c.label.toLowerCase().includes(q) || c.group.toLowerCase().includes(q),
    );
  }, [commands, query]);

  // Reset query/highlight/closing whenever the palette opens.
  useEffect(() => {
    if (open) {
      setQuery("");
      setHighlight(0);
      setClosing(false);
    }
  }, [open]);

  // Keep the highlight in range as the filtered list changes.
  useEffect(() => {
    setHighlight((h) => (filtered.length === 0 ? 0 : Math.min(h, filtered.length - 1)));
  }, [filtered.length]);

  useEffect(() => () => {
    if (closeTimer.current) window.clearTimeout(closeTimer.current);
  }, []);

  if (!open) return null;

  // Animated close (design animCloseModal — modalOut/backdropOut, then unmount).
  const requestClose = () => {
    if (closing) return;
    setClosing(true);
    closeTimer.current = window.setTimeout(() => onClose(), 280);
  };

  const run = (c: Command | undefined) => {
    if (!c) return;
    c.run();
    requestClose();
  };

  return (
    <div
      onClick={requestClose}
      style={{ position: "fixed", inset: 0, background: "rgba(4,7,7,.7)", zIndex: 90, display: "flex", alignItems: "flex-start", justifyContent: "center", paddingTop: "14vh", animation: closing ? "backdropOut .2s ease forwards" : "backdropIn .2s ease both" }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="panel"
        style={{ width: 560, maxWidth: "92vw", border: "1px solid rgba(127,233,216,.4)", background: "rgba(7,13,13,.97)", boxShadow: "0 0 60px rgba(0,0,0,.7),0 0 30px rgba(127,233,216,.08)", animation: closing ? "modalOut .28s ease-in forwards" : "modalIn .46s cubic-bezier(.16,.84,.3,1) both" }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 11, padding: "14px 16px", borderBottom: "1px solid rgba(127,233,216,.16)" }}>
          <span style={{ color: "#7fe9d8" }}>~ ❯</span>
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setHighlight((h) => (filtered.length ? (h + 1) % filtered.length : 0));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setHighlight((h) => (filtered.length ? (h - 1 + filtered.length) % filtered.length : 0));
              } else if (e.key === "Enter") {
                e.preventDefault();
                run(filtered[highlight]);
              } else if (e.key === "Escape") {
                e.preventDefault();
                e.stopPropagation(); // keep App's window handler from unmounting mid-animation
                requestClose();
              }
            }}
            placeholder="search projects, sessions, or run a command…"
            style={{ flex: 1, background: "transparent", border: 0, outline: "none", color: "#dff8f2", fontFamily: "'JetBrains Mono',monospace", fontSize: 13.5 }}
          />
          <span style={{ fontSize: 9.5, letterSpacing: 1.5, color: "#3c544f", border: "1px solid rgba(127,233,216,.2)", padding: "2px 7px" }}>ESC</span>
        </div>
        <div className="mscroll" style={{ maxHeight: "46vh", overflowY: "auto", padding: 6 }}>
          {filtered.length === 0 ? (
            <div style={{ padding: "24px 12px", textAlign: "center", fontSize: 12, letterSpacing: 1, color: "#3c544f" }}>// no commands</div>
          ) : (
            filtered.map((c, i) => (
              <button
                key={c.id}
                onClick={() => run(c)}
                onMouseMove={() => setHighlight(i)}
                style={{
                  width: "100%", appearance: "none", cursor: "pointer", fontFamily: "inherit", textAlign: "left",
                  display: "flex", alignItems: "center", gap: 12, padding: "9px 11px",
                  border: 0, borderLeft: `2px solid ${i === highlight ? "#7fe9d8" : "transparent"}`,
                  background: i === highlight ? "rgba(127,233,216,.08)" : "transparent",
                  animation: "mfadeup .3s ease both", animationDelay: `${i * 50}ms`,
                }}
              >
                <span style={{ fontSize: 11, color: c.iconColor ?? "#7fe9d8", width: 18, textAlign: "center", flex: "none" }}>{c.icon}</span>
                <span style={{ flex: 1, fontSize: 12.5, color: "#cfe9e3" }}>{c.label}</span>
                <span style={{ fontSize: 9.5, letterSpacing: 1, color: "#3c544f" }}>{c.group.toUpperCase()}</span>
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
