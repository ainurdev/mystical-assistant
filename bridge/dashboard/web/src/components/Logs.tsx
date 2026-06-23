import { useEffect, useRef } from "react";

export function Logs({ lines }: { lines: string[] }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.scrollTo({ top: ref.current.scrollHeight });
  }, [lines.length]);
  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-border px-3 py-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        Dev server logs
      </div>
      <div
        ref={ref}
        className="flex-1 overflow-y-auto bg-black/30 p-2 font-mono text-xs leading-relaxed text-foreground"
      >
        {lines.length === 0 ? (
          <div className="text-muted-foreground">no output</div>
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
