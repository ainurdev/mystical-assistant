import { useCallback, useEffect, useRef, useState } from "react";
import { code, queryClient } from "../../lib/queries";
import { api } from "../../api";
import { autoClean, type BranchPr, type BranchStatus, type ShownRow } from "../../lib/branchrows";
import { notify } from "./Notifications";

/** The open session's repo's branches and their PRs: the BRANCHES tab draws them
 *  and the rail tile counts what's ready to land (App). One poll, every 30s
 *  while the tab is open and every minute otherwise, and again on `nonce` (a
 *  commit, a push, a checkout). The PRs come a beat later (gh is slower than
 *  git); the first time they name a base the bridge hadn't measured against,
 *  the branches are read once more (bridge prstatus.cached_bases). */
export function useBranches(project: string | null, nonce: number, open: boolean) {
  const [data, setData] = useState<BranchStatus | null>(null);
  const [prs, setPrs] = useState<Record<string, BranchPr>>({});
  const [err, setErr] = useState("");
  const cur = useRef(project);
  const reread = useRef("");   // the project already read again for its PR bases
  cur.current = project;

  const load = useCallback(async () => {
    if (!project) return;
    try {
      const d = await queryClient.fetchQuery(code.branchStatus({ project }));
      if (cur.current !== project) return;
      setData(d); setErr("");
      // gh only for a repo with something pushed: a local-only one has no PRs to find
      if (!d.branches.some((b) => b.upstream && b.name !== d.base)) { setPrs({}); return; }
      const p = await api.branchPrs(project).then((r) => r.prs ?? {}, () => ({} as Record<string, BranchPr>));
      if (cur.current !== project) return;
      setPrs(p);
      const off = d.branches.some((b) => b.name && p[b.name]?.base && b.target !== undefined && !(b.name in (d.picks ?? {}))
        && b.target.replace(/^origin\//, "") !== p[b.name].base);
      if (off && reread.current !== project) {
        reread.current = project;
        const again = await queryClient.fetchQuery({ ...code.branchStatus({ project }), staleTime: 0 });
        if (cur.current === project) setData(again);
      }
    } catch (e) { if (cur.current === project) setErr((e as Error).message); }
  }, [project]);

  useEffect(() => { setData(null); setPrs({}); setErr(""); }, [project]);
  useEffect(() => {
    void load();
    // shortcut: its own timer, paused while hidden, until ticket 14 makes it a listed poll
    const id = setInterval(() => { if (!document.hidden) void load(); }, open ? 30000 : 60000);
    return () => clearInterval(id);
  }, [load, nonce, open]);
  return { data, prs, err, load };
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
