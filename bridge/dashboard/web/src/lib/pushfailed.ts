/** The unsent first message of a session opened from a failed push (the push
 *  buttons' HANDLE IN A NEW SESSION): git's own words and the ask. The human
 *  sends it, so the push that session makes is one they asked for — retrying in
 *  the session that failed reads as a bypass to the permission check. Hook
 *  output can run to pages; the tail is where git says why. */
const MAX_OUTPUT = 3000;

export function pushFailedDraft(branch: string | null | undefined, output: string): string {
  const out = output.trim();
  const said = out.length > MAX_OUTPUT ? `…${out.slice(-MAX_OUTPUT)}` : out || "(git printed nothing)";
  return `Pushing ${branch ? `\`${branch}\`` : "this branch"} failed:\n\n\`\`\`\n${said}\n\`\`\`\n\n`
    + "Find out why and fix it (fetch, then rebase or merge onto the remote, and re-run the checks), then push.";
}

/** The GIT tab's Merge / Merge & push handed to a new session (a merge that
 *  would clash, or one that failed): merge, not rebase, so the branch's commits
 *  keep their shas. It pushes only when `push` says so: Merge stops before it. */
export function divergedDraft(branch: string, upstream: string, ahead: number, behind: number,
  o: { push: boolean; clash?: string[]; dirty?: number }): string {
  const n = (k: number, w = "commit") => `${k} ${w}${k === 1 ? "" : "s"}`;
  const clash = o.clash ?? [];
  const named = clash.slice(0, 10).map((f) => `\`${f}\``).join(", ") + (clash.length > 10 ? `, and ${clash.length - 10} more` : "");
  return `\`${branch}\` has diverged from \`${upstream}\`: ${n(ahead)} here, ${n(behind)} there, as of the last fetch.`
    + (clash.length ? ` Merging them clashes in ${n(clash.length, "file")}: ${named}.` : "")
    + (o.dirty ? ` This checkout also has ${n(o.dirty, "uncommitted file")}: keep them safe.` : "")
    + `\n\nFetch, merge \`${upstream}\` into \`${branch}\` (a merge, not a rebase), resolve any clashes keeping both sides' intent, `
    + (o.push ? "re-run the checks, then push." : "and re-run the checks. Then stop: don't push, I'll do that myself.");
}
