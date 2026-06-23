import { surfaceFor } from "../lib/surfaces";

export function ChatHeader({
  title,
  origin,
  model,
  turnCount,
}: {
  title: string;
  origin: string | null | undefined;
  model: string;
  turnCount: number;
}) {
  const surf = surfaceFor(origin);
  return (
    <div className="flex h-[46px] shrink-0 items-center gap-3 border-b border-[#1c1828] px-5">
      <span className="truncate text-sm font-semibold">{title || "New chat"}</span>
      <span
        className="shrink-0 rounded-md border px-2 py-0.5 font-mono text-[11px]"
        style={{ color: surf.color, background: surf.bg, borderColor: surf.color + "55" }}
      >
        {surf.label} · this machine
      </span>
      <div className="flex-1" />
      <span className="shrink-0 font-mono text-[11.5px] text-muted-2">
        {model} · {turnCount} {turnCount === 1 ? "turn" : "turns"}
      </span>
    </div>
  );
}
