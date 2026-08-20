/** A human title reduced to what is plainly safe in a git ref AND a directory
 *  name. These strings go straight to `git worktree add -b`, and git's ref rules
 *  are fussier than they look — a space, a `..`, a trailing dot or a leading dash
 *  are all rejected, and the bridge derives the worktree's directory from the same
 *  string. Rather than encode git's grammar we keep lowercase letters, digits and
 *  dashes, a subset of every rule it has. Can come back empty; both callers below
 *  have their own answer for that. */
function slug(title: string): string {
  return (title || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");           // the slice may have landed mid-separator
}

/** A git branch name for a GitHub issue: `issue-<n>-<slug of the title>`. The
 *  number carries the identity, so a title that slugs to nothing still produces a
 *  usable, unique branch. */
export function branchForIssue(num: number, title: string): string {
  const s = slug(title);
  return s ? `issue-${num}-${s}` : `issue-${num}`;
}

/** A branch for a session moving into its own worktree, named after the session.
 *
 * No issue number to carry identity here, so uniqueness comes from `taken` (the
 * repo's branch list) rather than a timestamp: `wt/x`, then `wt/x-2`. Checking
 * first is what makes this a one-press action — `git worktree add -b` on a name
 * that already exists just fails, and there is no box to retype it in. */
export function branchForSession(title: string, taken: string[] = []): string {
  const base = `wt/${slug(title) || "session"}`;
  if (!taken.includes(base)) return base;
  let n = 2;
  while (taken.includes(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}
