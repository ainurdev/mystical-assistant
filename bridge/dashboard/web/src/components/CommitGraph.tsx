import { useEffect, useMemo, useState } from "react";
import { Cloud, Copy, GitBranch, Tag } from "lucide-react";
import { api, type CompareFile, type GitCommit } from "../api";
import { diffColor } from "../lib/resultfields";
import { FileIcon } from "../lib/fileicon";
import { DOT_Y, ROW_H, laneColor, layout, unpushed, type Seg } from "../lib/gitgraph";
import { ago } from "../lib/surfaces";
import { Skeleton } from "./ui";

/* Commit graph — `git log --all` laid out into lanes (see lib/gitgraph), VS
   Code Source Control Graph style: one row per commit, rails on the left
   showing where branches forked and merged back. The subject comes first and
   takes the row; a commit carrying refs grows a second line for its chips, so
   a message never pays for them. Commits the upstream hasn't got are hollow
   dots and HEAD is ringed. Clicking a row opens its files under it, a file
   its diff. Held by the GIT tab (hud/GitPanel) and the project modal's
   history pane; styles under GIT TAB in index.css. */

const REF_H = 18;   // the chips line under a subject

// ponytail: remote refs spotted by prefix — the two usual names plus the
// upstream's own remote. A local branch really named "origin/x" would
// mis-chip, and nobody does that.
function chip(r: string, remotes: string[]): { label: string; kind: "head" | "tag" | "remote" | "local" } {
  if (r.startsWith("tag: ")) return { label: r.slice(5), kind: "tag" };
  if (r.startsWith("HEAD -> ")) return { label: r.slice(8), kind: "head" };
  if (r === "HEAD") return { label: "HEAD", kind: "head" };
  if (remotes.some((n) => r.startsWith(`${n}/`))) return { label: r, kind: "remote" };
  return { label: r, kind: "local" };
}

const MARK_COLOR: Record<string, string> = {
  A: "var(--ok)", D: "var(--err)", R: "var(--info)", C: "var(--info)",
};

// "Oct 18 · 07:05" — the card is 275px wide; the full date is on hover.
const when = (ts: number) => {
  const d = new Date(ts * 1000);
  return `${d.toLocaleDateString(undefined, { month: "short", day: "numeric" })} · ${d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}`;
};

const SEG: Record<Seg, (h: number) => [number, number]> = {
  in: () => [0, DOT_Y], thru: (h) => [0, h], out: (h) => [DOT_Y, h],
};

export function CommitGraph({ project, branch, upstream, ahead = 0, behind = 0, nonce = 0 }: {
  project: string;
  branch?: string;
  /** the open worktree's upstream and its distance — the HEAD chip's count and the hollow dots */
  upstream?: string;
  ahead?: number;
  behind?: number;
  /** bump to re-read the log now */
  nonce?: number;
}) {
  const [commits, setCommits] = useState<GitCommit[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [limit, setLimit] = useState(200);
  // Click a row → its changed files; click a file → that file's diff in the commit.
  const [openSha, setOpenSha] = useState<string | null>(null);
  const [files, setFiles] = useState<CompareFile[] | null>(null);
  const [openFile, setOpenFile] = useState<string | null>(null);
  const [diff, setDiff] = useState<string | null>(null);

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
  }, [project, branch, limit, nonce]);

  function pickCommit(sha: string) {
    setOpenFile(null);
    setDiff(null);
    if (sha === openSha) return setOpenSha(null);
    setOpenSha(sha);
    setFiles(null);
    void api.gitShow(project, sha)
      .then((r) => setFiles(r.files ?? []))
      .catch(() => setFiles([]));
  }

  function pickFile(sha: string, name: string) {
    if (name === openFile) return setOpenFile(null);
    setOpenFile(name);
    setDiff(null);
    void api.gitShow(project, sha, name)
      .then((r) => setDiff(r.diff ?? ""))
      .catch(() => setDiff(""));
  }

  const { rows, width } = useMemo(() => layout(commits ?? []), [commits]);
  const hollow = useMemo(() => unpushed(commits ?? [], upstream), [commits, upstream]);
  const remotes = useMemo(
    () => ["origin", "upstream", ...(upstream?.includes("/") ? [upstream.split("/")[0]] : [])], [upstream]);
  // Every row pays for the deepest lane in the whole log, so a repo with five
  // branch lines spent a quarter of the rail panel's row on rails no commit on
  // screen uses. Cap the gutter near 48px; the pitch falls out of it.
  const laneW = Math.max(6, Math.min(13, Math.floor(48 / width)));
  const gw = width * laneW;
  const x = (l: number) => l * laneW + laneW / 2;
  const path = (a: number, b: number, y1: number, y2: number) =>
    a === b
      ? `M${x(a)},${y1}V${y2}`
      : `M${x(a)},${y1}C${x(a)},${(y1 + y2) / 2} ${x(b)},${(y1 + y2) / 2} ${x(b)},${y2}`;
  const dist = ahead > 0 || behind > 0
    ? [ahead > 0 ? `↑${ahead}` : "", behind > 0 ? `↓${behind}` : ""].filter(Boolean).join(" ")
    : "";

  if (commits === null)
    return (
      <div className="gg gg-skel">
        {[0, 1, 2, 3, 4].map((i) => (
          <Skeleton key={i} className="h-5 w-full" />
        ))}
      </div>
    );
  if (err)
    return (
      <div className="gg gg-note">
        Graph unavailable — {err}. Restart the bridge if it predates this endpoint.
      </div>
    );
  if (commits.length === 0) return <div className="gg gg-note">No commits yet.</div>;

  return (
    <div className="gg">
      {rows.map(({ c, lane, edges }) => {
        const isHead = c.refs.some((r) => r === "HEAD" || r.startsWith("HEAD -> "));
        const color = laneColor(lane);
        const open = c.sha === openSha;
        const h = c.refs.length ? ROW_H + REF_H : ROW_H;
        return (
          <div key={c.sha}>
            <div
              onClick={() => pickCommit(c.sha)}
              title={`${c.sha.slice(0, 12)}\n${c.subject}\n${c.author} · ${new Date(c.ts * 1000).toLocaleString()}`}
              className={`gg-row${isHead ? " head" : ""}${open ? " open" : ""}`}
              style={{ minHeight: h }}
            >
              <svg width={gw} height={h} className="gg-rails">
                {edges.map((e, i) => {
                  const [y1, y2] = SEG[e.seg](h);
                  return <path key={i} d={path(e.a, e.b, y1, y2)} stroke={e.color} />;
                })}
                {isHead ? (
                  <>
                    <circle cx={x(lane)} cy={DOT_Y} r={6.5} fill="none" stroke={color} strokeWidth={1.25} opacity={0.5} />
                    <circle cx={x(lane)} cy={DOT_Y} r={3.5} fill={color} />
                  </>
                ) : hollow.has(c.sha) ? (
                  <circle cx={x(lane)} cy={DOT_Y} r={3.25} fill="var(--panel)" stroke={color} strokeWidth={1.5} />
                ) : (
                  <circle cx={x(lane)} cy={DOT_Y} r={3.5} fill={color} />
                )}
              </svg>
              <div className="gg-main">
                <div className="gg-line">
                  <span className="gg-sub">{c.subject}</span>
                  <span className="gg-ago">{ago(c.ts)}</span>
                </div>
                {/* Two chips max, then a count — the panel is narrow. */}
                {c.refs.length > 0 && (
                  <div className="gg-refs">
                    {c.refs.slice(0, 2).map((r) => {
                      const { label, kind } = chip(r, remotes);
                      return (
                        <span key={r} className={`gg-chip ${kind}`} title={r}>
                          {kind === "tag" ? <Tag size={9} strokeWidth={2} />
                            : kind === "remote" ? <Cloud size={9} strokeWidth={2} />
                            : <GitBranch size={9} strokeWidth={2} />}
                          <span>{label}</span>
                          {kind === "head" && dist && <u>{dist}</u>}
                        </span>
                      );
                    })}
                    {c.refs.length > 2 && (
                      <span className="gg-more" title={c.refs.join(", ")}>+{c.refs.length - 2}</span>
                    )}
                  </div>
                )}
              </div>
            </div>
            {/* ponytail: the card splits the rails of any lane passing this
                row — its left rule keeps the opened commit's own lane readable,
                which is the one you're looking at. */}
            {open && (
              <div className="gg-card" style={{ marginLeft: x(lane) + 10, borderLeftColor: color }}>
                <div className="gg-meta" title={new Date(c.ts * 1000).toLocaleString()}>
                  <code>{c.sha.slice(0, 8)}</code>
                  <span className="who">{c.author}</span>
                  <span>{when(c.ts)}</span>
                  <button className="gg-ib" title="copy the full sha"
                    onClick={() => { try { void navigator.clipboard?.writeText(c.sha); } catch { /* ignore */ } }}>
                    <Copy size={12} />
                  </button>
                </div>
                {files === null && <div className="gg-note">Loading files…</div>}
                {files?.length === 0 && <div className="gg-note">No file changes.</div>}
                {files?.map((f) => {
                  const cut = f.name.lastIndexOf("/");
                  const name = cut < 0 ? f.name : f.name.slice(cut + 1);
                  return (
                    <div key={f.name}>
                      <div
                        onClick={() => pickFile(c.sha, f.name)}
                        title={f.name}
                        className={`gg-file${openFile === f.name ? " open" : ""}`}
                      >
                        <FileIcon name={name} size={14} />
                        <span className="gg-fname">{name}</span>
                        {/* rtl keeps the nearest folder visible when the path is cut */}
                        <span className="gg-fdir" dir="rtl">{cut < 0 ? "" : f.name.slice(0, cut)}</span>
                        <span className="gg-fig"><i>+{f.add}</i><i>−{f.del}</i></span>
                        <span className="gg-mark" style={{ color: MARK_COLOR[f.mark] ?? "var(--warn)" }}>{f.mark}</span>
                      </div>
                      {openFile === f.name && (
                        <pre className="gg-diff">
                          {diff === null
                            ? "loading…"
                            : diff.split("\n").map((l, i) => (
                                <div key={i} style={{ color: diffColor(l) }}>
                                  {l || " "}
                                </div>
                              ))}
                        </pre>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
      {commits.length >= limit && (
        <button onClick={() => setLimit((l) => l + 200)} className="gg-older">
          Load older commits
        </button>
      )}
    </div>
  );
}
