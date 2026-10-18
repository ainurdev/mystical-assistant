import type { GitStatus } from "../api";

/* Where the open tree's branch stands against its remote, as the GIT tab's
   readout and the rail's GIT badge say it. ahead/behind are as of the last
   fetch, by any checkout of the repo (GitStatus.fetched_at says when).
   upstream "" is a branch origin has never seen, and a backend too old to send
   an upstream gets no sync state at all rather than a guess. Pure, so
   gitsync.check.ts can pin it. */
export type Sync =
  | { kind: "none" }
  | { kind: "detached" }
  | { kind: "local" }                    // no origin to push to
  | { kind: "publish"; n: number }       // n = commits on no remote branch yet
  | { kind: "synced"; upstream: string }
  | { kind: "ahead"; n: number; upstream: string }
  | { kind: "behind"; n: number; upstream: string }
  | { kind: "diverged"; ahead: number; behind: number; upstream: string };

export function syncOf(git: GitStatus | null | undefined): Sync {
  if (!git?.is_repo || git.upstream === undefined) return { kind: "none" };
  if (git.branch === "(detached)") return { kind: "detached" };
  const { upstream, ahead, behind } = git;
  if (!upstream) return git.unpublished === null ? { kind: "local" } : { kind: "publish", n: git.unpublished ?? 0 };
  if (ahead && behind) return { kind: "diverged", ahead, behind, upstream };
  if (ahead) return { kind: "ahead", n: ahead, upstream };
  if (behind) return { kind: "behind", n: behind, upstream };
  return { kind: "synced", upstream };
}

const cap = (n: number) => (n > 99 ? "99+" : String(n));

/** The rail's GIT badge on a clean tree: what the header's git dot used to say. */
export function syncBadge(s: Sync): string | null {
  switch (s.kind) {
    case "ahead": return `↑${cap(s.n)}`;
    case "behind": return `↓${cap(s.n)}`;
    case "diverged": return "↑↓";
    case "publish": return s.n > 0 ? `↑${cap(s.n)}` : null;
    default: return null;
  }
}
