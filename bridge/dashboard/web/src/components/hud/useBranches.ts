import { useCallback, useEffect, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { code, reread } from "../../lib/queries";
import { api } from "../../api";
import { autoClean, type BranchPr, type ShownRow } from "../../lib/branchrows";
import { notify } from "./Notifications";

const NO_PRS: Record<string, BranchPr> = {};

/** The open session's repo's branches and their PRs: the BRANCHES tab draws them
 *  and the rail tile counts what's ready to land (App). Polled every 30s while
 *  the tab is open and every minute otherwise; a commit, a push or a checkout
 *  invalidates them (lib/queries). The PRs come a beat later (gh is slower than
 *  git); the first time they name a base the bridge hadn't measured against,
 *  the branches are read once more (bridge prstatus.cached_bases). */
export function useBranches(project: string | null, open: boolean) {
  const every = open ? 30000 : 60000;
  const bq = useQuery({ ...code.branchStatus({ project: project ?? "" }), enabled: !!project, refetchInterval: every });
  const data = project ? bq.data ?? null : null;
  // gh only for a repo with something pushed: a local-only one has no PRs to find
  const pushed = !!data?.branches.some((b) => b.upstream && b.name !== data.base);
  const pq = useQuery({ ...code.branchPrs({ project: project ?? "" }), enabled: pushed, refetchInterval: every });
  const prs = (pushed && pq.data?.prs) || NO_PRS;
  const again = useRef("");   // the project already read again for its PR bases
  useEffect(() => {
    if (!project || !data || prs === NO_PRS || again.current === project) return;
    const off = data.branches.some((b) => b.name && prs[b.name]?.base && b.target !== undefined && !(b.name in (data.picks ?? {}))
      && b.target.replace(/^origin\//, "") !== prs[b.name].base);
    if (off) { again.current = project; void reread(code.branchStatus({ project }).queryKey); }
  }, [project, data, prs]);
  const load = useCallback(() => {
    if (!project) return;
    void reread(code.branchStatus({ project }).queryKey);
    void reread(code.branchPrs({ project }).queryKey);
  }, [project]);
  return { data, prs, err: project && bq.isError ? bq.error.message : "", load };
}

/** Auto clean-up: landed branches nothing holds go by themselves (lib/branchrows
 *  autoClean), each tried once per page, a worktree's scratch archived first
 *  (bridge git.archive_scratch). A notice says what went. */
export function useAutoClean(on: boolean, project: string | null, rows: ShownRow[] | null,
                             recent: ReadonlySet<string>, reload: () => void) {
  const tried = useRef(new Set<string>());
  useEffect(() => {
    if (!on || !project || !rows) return;
    const go = autoClean(rows, recent).filter((r) => !tried.current.has(`${project} ${r.name}`));
    if (!go.length) return;
    for (const r of go) tried.current.add(`${project} ${r.name}`);
    void (async () => {
      const gone: string[] = [];
      let kept = false;
      for (const r of go) {
        // a squash-merged branch (its PR merged at the tip) isn't in git's merged list: -D, as Clean up does
        const res: { ok: boolean; kept?: string } = await (r.worktree ? api.worktreeRemove(project, r.worktree, r.name, true, true)
          : api.deleteBranch(project, r.name, !r.merged)).catch(() => ({ ok: false }));
        if (res.ok) { gone.push(r.label); kept ||= !!res.kept; }
      }
      if (!gone.length) return;
      const where = kept ? " Their scratch is in .mystical/archive." : "";
      notify("info", gone.length === 1 ? `Cleaned up ${gone[0]}: it had landed.${where}`
        : `Cleaned up ${gone.length} landed branches: ${gone.join(", ")}.${where}`);
      reload();
    })();
  }, [on, project, rows, recent, reload]);
}
