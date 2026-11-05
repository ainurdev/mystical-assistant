/* The Git tab's PIPE: Mac (working tree) -> branch (commits) -> origin, as three
   stations, the arrows that would carry work along, and the one button that
   closes the first open gap. Pure, so gitpipe.check.ts pins it. Counts come
   from the panel's own syncOf(); nothing here re-reads git.
   Amber (warn) is what came from origin, accent is yours to move. */

export type PipeSync = { kind: string; n?: number; ahead?: number; behind?: number };
export type Station = { key: "mac" | "branch" | "origin"; big: string; sub: string; hot: boolean; warm: boolean };
export type Flow = { gap: 0 | 1; dir: 1 | -1; tone: "acc" | "warn" };
export type PipeAction = { verb: "Commit" | "Publish" | "Pull"; n: number; gap: 0 | 1; tone: "acc" | "warn" };
export type Pipe = { stations: Station[]; flows: Flow[]; action: PipeAction | null; say: string };

const cap = (n: number) => (n > 99 ? "99+" : String(n));
const files = (n: number) => `${n} file${n === 1 ? "" : "s"}`;
const commits = (n: number) => `${n} commit${n === 1 ? "" : "s"}`;

export function pipe(sync: PipeSync, changed: number, hasUpstream: boolean): Pipe {
  const up = sync.kind === "diverged" ? sync.ahead ?? 0 : sync.kind === "ahead" || sync.kind === "publish" ? sync.n ?? 0 : 0;
  const down = sync.kind === "diverged" ? sync.behind ?? 0 : sync.kind === "behind" ? sync.n ?? 0 : 0;
  // Whichever end has work waiting lights up: edits first, then origin's, then yours.
  const hot = changed ? 0 : down ? 2 : up ? 1 : -1;
  const stations: Station[] = [
    { key: "mac", big: changed ? cap(changed) : "✓", sub: changed ? "edits" : "clean", hot: hot === 0, warm: false },
    { key: "branch", big: up ? cap(up) : "✓", sub: up ? (up === 1 ? "commit" : "commits") : "even", hot: hot === 1, warm: false },
    {
      key: "origin", big: !hasUpstream ? "—" : down ? cap(down) : "✓",
      sub: !hasUpstream ? "not pushed" : down ? "incoming" : "origin", hot: hot === 2, warm: hot === 2,
    },
  ];
  const flows: Flow[] = [];
  if (changed) flows.push({ gap: 0, dir: 1, tone: "acc" });
  if (up) flows.push({ gap: 1, dir: 1, tone: "acc" });
  if (down) flows.push({ gap: 1, dir: -1, tone: "warn" });
  const action: PipeAction | null = changed ? { verb: "Commit", n: changed, gap: 0, tone: "acc" }
    : down ? { verb: "Pull", n: down, gap: 1, tone: "warn" }
    : up ? { verb: "Publish", n: up, gap: 1, tone: "acc" }
    : null;
  const say = changed ? `${files(changed)} edited, not committed`
    : down && up ? `${down} new on origin, then publish ${up}`
    : down ? `${down} new on origin`
    : up ? `${commits(up)} only on this Mac`
    : sync.kind === "synced" ? "Everything is on origin"
    : sync.kind === "local" ? "No remote, this repo lives only here"
    : sync.kind === "detached" ? "Detached HEAD, no branch to push"
    : "Nothing to push";
  return { stations, flows, action, say };
}
