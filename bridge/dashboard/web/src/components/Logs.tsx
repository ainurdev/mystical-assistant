import { useEffect, useRef } from "react";

export function Logs({ lines }: { lines: string[] }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.scrollTo({ top: ref.current.scrollHeight });
  }, [lines.length]);
  return (
    <div className="flex h-full flex-col p-4">
      <div className="mb-3 flex items-center gap-2 text-[11px] text-success">
        <span className="h-[7px] w-[7px] rounded-full bg-success animate-[mpulse_2.2s_infinite]" />
        <span className="font-mono">dev server logs</span>
      </div>
      <div
        ref={ref}
        className="min-h-0 flex-1 overflow-y-auto rounded-[9px] border border-border bg-[rgba(0,0,0,.25)] p-3 font-mono text-[11px] leading-relaxed text-muted-foreground"
      >
        {lines.length === 0 ? (
          <div className="text-muted-2">no output</div>
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
