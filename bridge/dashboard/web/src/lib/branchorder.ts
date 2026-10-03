/* The WORKTREE picker's order: the picked branch, then branches that are
   already checked out somewhere, then the rest. Git's own order (newest commit
   first) is the tiebreak inside each group — sort is stable, so a rank is all
   it takes. `held` is empty until the worktree list answers, which leaves git's
   order as it was. */
export function orderBranches(branches: string[], picked: string, held: ReadonlySet<string>): string[] {
  const rank = (b: string) => (b === picked ? 0 : held.has(b) ? 1 : 2);
  return branches.slice().sort((a, b) => rank(a) - rank(b));
}
