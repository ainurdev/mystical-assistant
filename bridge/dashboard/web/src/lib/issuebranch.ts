/** A git branch name for a GitHub issue: `issue-<n>-<slug of the title>`.
 *
 * The name goes straight to `git worktree add -b`, and git's ref rules are
 * fussier than they look — a space, a `..`, a trailing dot or a leading dash
 * are all rejected, and the bridge derives the worktree's directory from this
 * same string. Rather than encode git's grammar we keep only what is plainly
 * safe (lowercase letters, digits, dashes), which is a subset of every rule it
 * has. The number carries the identity, so a title that slugs to nothing still
 * produces a usable, unique branch. */
export function branchForIssue(num: number, title: string): string {
  const slug = (title || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");           // the slice may have landed mid-separator
  return slug ? `issue-${num}-${slug}` : `issue-${num}`;
}
