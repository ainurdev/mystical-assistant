import type { TrayItem } from "@selector/controller";

export function SelectionTray({
  items, onNote, onRemove,
}: {
  items: TrayItem[];
  onNote: (id: string, note: string) => void;
  onRemove: (id: string) => void;
}) {
  if (!items.length) return <p className="text-xs text-[var(--tg-hint)]">Select elements or drop a pin to begin.</p>;
  return (
    <ul className="space-y-2">
      {items.map(({ capture: c, note }) => (
        <li key={c.id} className="rounded-lg bg-[var(--tg-secondary-bg)] p-2 text-xs">
          <div className="mb-1 flex items-center justify-between gap-2">
            <span className="truncate font-mono">
              {c.kind === "element" ? `<${c.tag}>${c.mloc ? ` · ${c.mloc}` : ""}` : `PIN (${Math.round(c.point.x)},${Math.round(c.point.y)})`}
            </span>
            <button onClick={() => onRemove(c.id)} className="shrink-0 px-2 py-1 text-[var(--tg-hint)] active:opacity-70">✕</button>
          </div>
          <input value={note} onChange={(e) => onNote(c.id, e.target.value)} placeholder="note (optional)"
            className="w-full rounded-lg bg-[var(--tg-bg)] px-2 py-1.5 outline-none" />
        </li>
      ))}
    </ul>
  );
}
