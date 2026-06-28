import { useEffect, useState } from "react";
import { api } from "../api";
import { parseDiff, type DiffRow } from "../lib/diff";
import { Skeleton } from "./ui";

const ROW: Record<DiffRow["kind"], { bg: string; sign: string; color: string }> = {
  add: { bg: "rgba(143,217,168,.07)", sign: "var(--success)", color: "#a7e6c3" },
  del: { bg: "rgba(224,137,122,.07)", sign: "var(--danger)", color: "#f0b0a8" },
  ctx: { bg: "transparent", sign: "var(--muted-2)", color: "#6f938d" },
  hunk: { bg: "var(--ac-06)", sign: "var(--primary)", color: "var(--primary)" },
};

export function DiffTab({ file }: { file: { project: string; path: string } | null }) {
  const [rows, setRows] = useState<DiffRow[]>([]);
  const [empty, setEmpty] = useState(false);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!file) return;
    let live = true;
    setLoading(true);
    setRows([]); // clear the previous file's diff so it doesn't flash stale
    setEmpty(false);
    void (async () => {
      try {
        const r = await api.gitDiff(file.project, file.path);
        if (!live) return;
        const parsed = parseDiff(r.diff);
        setRows(parsed);
        setEmpty(parsed.length === 0);
      } catch {
        /* ignore */
      } finally {
        if (live) setLoading(false);
      }
    })();
    return () => {
      live = false;
    };
  }, [file]);

  if (!file)
    return (
      <div className="p-4 text-xs text-muted-foreground">Select a changed file to view its diff.</div>
    );

  return (
    <div className="p-4">
      <div className="mb-3 flex items-center gap-2 rounded-[9px] border border-border bg-card px-3 py-2 font-mono text-[11.5px] text-card-foreground">
        <span className="flex-1 truncate" style={{ direction: "rtl" }}>
          {file.path}
        </span>
      </div>
      <div className="overflow-hidden rounded-[9px] border border-border bg-[rgba(0,0,0,.25)] font-mono text-[11.5px] leading-[1.75]">
        {loading ? (
          <div className="space-y-1.5 px-3 py-2.5">
            {[80, 64, 72, 56, 68].map((w, i) => (
              <Skeleton key={i} className="h-3" style={{ width: `${w}%` }} />
            ))}
          </div>
        ) : empty ? (
          <div className="px-3 py-2 text-muted-2">No textual diff.</div>
        ) : (
          rows.map((d, i) => {
            const c = ROW[d.kind];
            return (
              <div key={i} className="flex" style={{ background: c.bg }}>
                <span className="w-[34px] shrink-0 select-none border-r border-border pr-2 text-right text-muted-2">
                  {d.ln}
                </span>
                <span className="w-3.5 shrink-0 px-1.5 text-center" style={{ color: c.sign }}>
                  {d.mark}
                </span>
                <span className="flex-1 whitespace-pre" style={{ color: c.color }}>
                  {d.text}
                </span>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
