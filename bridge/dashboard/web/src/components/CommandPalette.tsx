import { useEffect, useMemo, useState } from "react";

export interface Command {
  id: string;
  label: string;
  group: string;
  icon: string;
  run: () => void;
}

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

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return commands;
    return commands.filter(
      (c) => c.label.toLowerCase().includes(q) || c.group.toLowerCase().includes(q),
    );
  }, [commands, query]);

  // Reset query/highlight whenever the palette opens.
  useEffect(() => {
    if (open) {
      setQuery("");
      setHighlight(0);
    }
  }, [open]);

  // Keep the highlight in range as the filtered list changes.
  useEffect(() => {
    setHighlight((h) => (filtered.length === 0 ? 0 : Math.min(h, filtered.length - 1)));
  }, [filtered.length]);

  if (!open) return null;

  const run = (c: Command | undefined) => {
    if (!c) return;
    c.run();
    onClose();
  };

  return (
    <div
      onClick={onClose}
      className="fixed inset-0 z-[90] flex items-start justify-center bg-[rgba(4,7,7,.7)] pt-[14vh]"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="panel w-[560px] max-w-[92vw] overflow-hidden border border-[var(--border-bright)] bg-[rgba(7,13,13,.97)] shadow-[0_0_60px_rgba(0,0,0,.7),0_0_30px_var(--accent)] animate-[mpop_.15s_ease]"
      >
        <div className="flex items-center gap-2.5 border-b border-border px-4 py-3.5">
          <span className="text-[13px] text-primary">~ ❯</span>
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
                onClose();
              }
            }}
            placeholder="search projects, sessions, or run a command…"
            className="flex-1 bg-transparent font-mono text-[13.5px] text-foreground-bright outline-none placeholder:text-muted-2"
          />
          <span className="border border-input px-[7px] py-0.5 text-[9.5px] tracking-[1.5px] text-muted-2">ESC</span>
        </div>
        <div className="max-h-[46vh] overflow-y-auto p-1.5">
          {filtered.length === 0 ? (
            <div className="px-3 py-6 text-center text-[12px] tracking-[1px] text-muted-2">// no commands</div>
          ) : (
            filtered.map((c, i) => (
              <button
                key={c.id}
                onClick={() => run(c)}
                onMouseMove={() => setHighlight(i)}
                className="flex w-full items-center gap-3 border-l-2 px-2.5 py-2.5 text-left"
                style={{
                  background: i === highlight ? "var(--accent)" : "transparent",
                  borderColor: i === highlight ? "var(--primary)" : "transparent",
                }}
              >
                <span className="w-[18px] flex-none text-center text-[11px] text-primary">{c.icon}</span>
                <span className="flex-1 text-[12.5px] text-[#cfe9e3]">{c.label}</span>
                <span className="text-[9.5px] tracking-[1px] text-muted-2">{c.group.toUpperCase()}</span>
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
