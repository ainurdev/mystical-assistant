import { useEffect, useMemo, useState } from "react";
import { api, type GitCommit } from "../api";
import { ROW_H, laneColor, layout } from "../lib/gitgraph";
import { ago } from "../lib/surfaces";
import { Skeleton } from "./ui";

/* Commit graph — `git log --all` laid out into lanes (see lib/gitgraph), VS
   Code Source Control Graph style: one row per commit, rails on the left
   showing where branches forked and merged back. */

// ponytail: remote refs spotted by prefix — a local branch really named
// "origin/x" would mis-chip, and nobody does that.
function chip(r: string): { label: string; kind: "head" | "tag" | "remote" | "local" } {
  if (r.startsWith("tag: ")) return { label: r.slice(5), kind: "tag" };
  if (r.startsWith("HEAD -> ")) return { label: r.slice(8), kind: "head" };
  if (r === "HEAD") return { label: "HEAD", kind: "head" };
  if (/^(origin|upstream)\//.test(r)) return { label: r, kind: "remote" };
  return { label: r, kind: "local" };
}

const CHIP_CLASS: Record<string, string> = {
  head: "border-primary text-foreground-bright bg-[var(--ac-12)]",
  local: "border-border text-primary",
  remote: "border-[var(--txl)] text-muted-foreground",
  tag: "border-[var(--warn)] text-[var(--warn)]",
};

export function CommitGraph({ project, branch }: { project: string; branch?: string }) {
  const [commits, setCommits] = useState<GitCommit[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [limit, setLimit] = useState(200);

  useEffect(() => {
    let live = true;
    const load = async () => {
      try {
        const r = await api.gitLog(project, limit, branch);
        if (live) {
          setCommits(r.commits);
          setErr(null);
        }
      } catch (e) {
        // A bridge started before this endpoint existed 404s here — say so
        // rather than spinning a skeleton forever.
        if (live) {
          setCommits([]);
          setErr((e as Error).message);
        }
      }
    };
    void load();
    const id = setInterval(() => void load(), 15000);
    return () => {
      live = false;
      clearInterval(id);
    };
  }, [project, branch, limit]);

  const { rows, width } = useMemo(() => layout(commits ?? []), [commits]);
  // Squeeze the rails when a repo has many branches in flight, so the graph
  // never eats the whole (narrow) panel.
  const laneW = width > 7 ? Math.max(6, Math.floor(96 / width)) : 13;
  const gw = width * laneW;
  const x = (l: number) => l * laneW + laneW / 2;
  const path = (a: number, b: number, y1: number, y2: number) =>
    a === b
      ? `M${x(a)},${y1}V${y2}`
      : `M${x(a)},${y1}C${x(a)},${(y1 + y2) / 2} ${x(b)},${(y1 + y2) / 2} ${x(b)},${y2}`;

  if (commits === null)
    return (
      <div className="space-y-1.5 px-2.5 py-2">
        {[0, 1, 2, 3, 4].map((i) => (
          <Skeleton key={i} className="h-5 w-full" />
        ))}
      </div>
    );
  if (err)
    return (
      <div className="px-2.5 py-2 text-xs text-muted-foreground">
        Graph unavailable — {err}. Restart the bridge if it predates this endpoint.
      </div>
    );
  if (commits.length === 0)
    return <div className="px-2.5 py-2 text-xs text-muted-foreground">No commits yet.</div>;

  return (
    <div>
      {rows.map(({ c, lane, edges }) => {
        const isHead = c.refs.some((r) => r === "HEAD" || r.startsWith("HEAD -> "));
        const color = laneColor(lane);
        return (
          <div
            key={c.sha}
            title={`${c.sha.slice(0, 12)}\n${c.subject}\n${c.author} · ${new Date(c.ts * 1000).toLocaleString()}`}
            className="flex items-center gap-2 rounded px-1 hover:bg-accent"
            style={{ height: ROW_H }}
          >
            <svg width={gw} height={ROW_H} className="shrink-0 overflow-visible">
              {edges.map((e, i) => (
                <path
                  key={i}
                  d={path(e.a, e.b, e.y1, e.y2)}
                  fill="none"
                  stroke={e.color}
                  strokeWidth={1.5}
                  opacity={0.75}
                />
              ))}
              <circle
                cx={x(lane)}
                cy={ROW_H / 2}
                r={isHead ? 4.5 : 3.5}
                fill={isHead ? "var(--panel)" : color}
                stroke={color}
                strokeWidth={isHead ? 2 : 0}
              />
            </svg>
            {/* Two chips max — the panel is narrow and the subject matters more. */}
            {c.refs.slice(0, 2).map((r) => {
              const { label, kind } = chip(r);
              return (
                <span
                  key={r}
                  className={`shrink-0 truncate rounded border px-1 font-mono text-[9.5px] leading-[15px] ${CHIP_CLASS[kind]}`}
                  style={{ maxWidth: 80 }}
                >
                  {label}
                </span>
              );
            })}
            {c.refs.length > 2 && (
              <span className="shrink-0 font-mono text-[9.5px] text-muted-2" title={c.refs.join(", ")}>
                +{c.refs.length - 2}
              </span>
            )}
            <span className="flex-1 truncate text-[11.5px] text-card-foreground">{c.subject}</span>
            <span className="shrink-0 font-mono text-[10px] text-muted-2">{ago(c.ts)}</span>
          </div>
        );
      })}
      {commits.length >= limit && (
        <button
          onClick={() => setLimit((l) => l + 200)}
          className="mt-1 w-full rounded-lg border border-input bg-secondary py-1.5 text-[11px] text-muted-foreground hover:bg-accent"
        >
          Load older commits
        </button>
      )}
    </div>
  );
}
