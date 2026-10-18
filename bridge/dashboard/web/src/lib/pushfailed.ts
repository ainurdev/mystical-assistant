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

/** HANDLE IN A NEW SESSION on a diverged branch: no push was tried, since git
 *  would refuse it and a pull can't fast-forward. Merge, not rebase: the
 *  branch's commits keep their shas. */
export function divergedDraft(branch: string, upstream: string, ahead: number, behind: number): string {
  const n = (k: number) => `${k} commit${k === 1 ? "" : "s"}`;
  return `\`${branch}\` has diverged from \`${upstream}\`: ${n(ahead)} here, ${n(behind)} there, as of the last fetch. `
    + "A push would be refused and a pull can't fast-forward.\n\n"
    + `Fetch, merge \`${upstream}\` into \`${branch}\`, re-run the checks, then push.`;
}
