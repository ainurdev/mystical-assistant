import { useEffect, useRef } from "react";

export function Logs({ lines }: { lines: string[] }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.scrollTo({ top: ref.current.scrollHeight });
  }, [lines.length]);
  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-zinc-800 px-3 py-2 text-xs font-semibold uppercase tracking-wide text-zinc-400">
        Dev server logs
      </div>
      <div
        ref={ref}
        className="flex-1 overflow-y-auto bg-black/30 p-2 font-mono text-xs leading-relaxed text-zinc-300"
      >
        {lines.length === 0 ? (
          <div className="text-zinc-600">no output</div>
        ) : (
          lines.map((l, i) => (
            <div key={i} className="whitespace-pre-wrap">
              {l}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
