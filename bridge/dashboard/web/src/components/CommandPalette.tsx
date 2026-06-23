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
      className="fixed inset-0 z-50 flex items-start justify-center bg-[rgba(8,6,14,.62)] pt-[13vh] backdrop-blur-[3px]"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-[580px] max-w-[92vw] overflow-hidden rounded-2xl border border-[#322a48] bg-[#16121f] shadow-[0_24px_70px_rgba(0,0,0,.6)] animate-[mpop_.16s_ease]"
      >
        <div className="flex items-center gap-2.5 border-b border-border px-4 py-3.5">
          <span className="text-[15px] text-muted-2">⌕</span>
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
            placeholder="Search projects, sessions, or run a command…"
            className="flex-1 bg-transparent text-[14.5px] text-foreground outline-none placeholder:text-muted-2"
          />
          <span className="rounded-[5px] border border-input px-1.5 font-mono text-[11px] text-muted-2">esc</span>
        </div>
        <div className="max-h-[50vh] overflow-y-auto p-2">
          {filtered.length === 0 ? (
            <div className="px-3 py-6 text-center text-[13px] text-muted-foreground">No commands.</div>
          ) : (
            filtered.map((c, i) => (
              <button
                key={c.id}
                onClick={() => run(c)}
                onMouseMove={() => setHighlight(i)}
                className={`flex w-full items-center gap-3 rounded-[9px] px-3 py-2.5 text-left ${
                  i === highlight ? "bg-[#211a33]" : ""
                }`}
              >
                <span className="flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-[7px] bg-muted font-mono text-[13px] text-brand-soft">
                  {c.icon}
                </span>
                <span className="flex-1 text-[13.5px] text-card-foreground">{c.label}</span>
                <span className="font-mono text-[10.5px] text-muted-2">{c.group}</span>
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
