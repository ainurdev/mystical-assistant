import { useEffect, useState } from "react";
import { api } from "../api";
import { parseDiff, type DiffRow } from "../lib/diff";

const ROW: Record<DiffRow["kind"], { bg: string; sign: string; color: string }> = {
  add: { bg: "rgba(90,209,140,.08)", sign: "var(--success)", color: "#a7e6c3" },
  del: { bg: "rgba(229,115,107,.08)", sign: "var(--danger)", color: "#f0a9a3" },
  ctx: { bg: "transparent", sign: "var(--muted-2)", color: "#8a829e" },
  hunk: { bg: "rgba(139,109,255,.07)", sign: "var(--brand-soft)", color: "var(--brand-soft)" },
};

export function DiffTab({ file }: { file: { project: string; path: string } | null }) {
  const [rows, setRows] = useState<DiffRow[]>([]);
  const [empty, setEmpty] = useState(false);

  useEffect(() => {
    if (!file) return;
    let live = true;
    void (async () => {
      try {
        const r = await api.gitDiff(file.project, file.path);
        if (!live) return;
        const parsed = parseDiff(r.diff);
        setRows(parsed);
        setEmpty(parsed.length === 0);
      } catch {
        /* ignore */
      }
    })();
    return () => {
      live = false;
    };
  }, [file]);

  if (!file)
    return (
      <div className="p-4 text-xs text-muted-foreground">Select a changed file in the Git tab.</div>
    );

  return (
    <div className="p-4">
      <div className="mb-3 flex items-center gap-2 rounded-[9px] border border-border bg-card px-3 py-2 font-mono text-[11.5px] text-card-foreground">
        <span className="flex-1 truncate" style={{ direction: "rtl" }}>
          {file.path}
        </span>
      </div>
      <div className="overflow-hidden rounded-[9px] border border-border bg-[#100d18] font-mono text-[11.5px] leading-[1.75]">
        {empty ? (
          <div className="px-3 py-2 text-muted-2">No textual diff.</div>
        ) : (
          rows.map((d, i) => {
            const c = ROW[d.kind];
            return (
              <div key={i} className="flex" style={{ background: c.bg }}>
                <span className="w-[34px] shrink-0 select-none border-r border-[#1c1828] pr-2 text-right text-[#4a4460]">
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
