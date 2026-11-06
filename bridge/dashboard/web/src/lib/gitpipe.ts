/* The Git tab's PIPE: Mac (working tree) -> branch (commits) -> origin, as three
   stations, the arrows that would carry work along, and the one button that
   closes the first open gap. An upstream never fetched (or whose last fetch failed) is `unchecked`: it never claims "on origin". Pure, so gitpipe.check.ts pins it. Counts come
   from the panel's own syncOf(); nothing here re-reads git.
   `where` names the upstream when it is not origin/<same branch>.
   Amber (warn) is what came from origin, accent is yours to move. */

export type PipeSync = { kind: string; n?: number; ahead?: number; behind?: number };
export type Station = { key: "mac" | "branch" | "origin"; big: string; sub: string; hot: boolean; warm: boolean };
export type Flow = { gap: 0 | 1; dir: 1 | -1; tone: "acc" | "warn" };
export type PipeAction = { verb: "Commit" | "Publish" | "Pull" | "Merge"; n: number; gap: 0 | 1; tone: "acc" | "warn" };
/** The second button: Push/Publish under Commit (edits plus unpushed commits, nothing incoming); on a
 *  diverged branch Merge & push beside Merge, or Merge under Commit. Merge & push's n is what the push sends. */
export type PipeAlt = { verb: "Publish" | "Push" | "Merge" | "Merge & push"; n: number };
export type Pipe = { stations: Station[]; flows: Flow[]; action: PipeAction | null; alt: PipeAlt | null; say: string };

const cap = (n: number) => (n > 99 ? "99+" : String(n));
const files = (n: number) => `${n} file${n === 1 ? "" : "s"}`;
const commits = (n: number) => `${n} commit${n === 1 ? "" : "s"}`;

export function pipe(sync: PipeSync, changed: number, hasUpstream: boolean, unchecked = false, where = "origin"): Pipe {
  const up = sync.kind === "diverged" ? sync.ahead ?? 0 : sync.kind === "ahead" || sync.kind === "publish" ? sync.n ?? 0 : 0;
  const down = sync.kind === "diverged" ? sync.behind ?? 0 : sync.kind === "behind" ? sync.n ?? 0 : 0;
  // Whichever end has work waiting lights up: edits first, then origin's, then yours.
  const hot = changed ? 0 : down ? 2 : up ? 1 : -1;
  const stations: Station[] = [
    { key: "mac", big: changed ? cap(changed) : "✓", sub: changed ? "edits" : "clean", hot: hot === 0, warm: false },
    { key: "branch", big: up ? cap(up) : "✓", sub: up ? (up === 1 ? "commit" : "commits") : "even", hot: hot === 1, warm: false },
    {
      key: "origin", big: !hasUpstream ? "—" : down ? cap(down) : unchecked ? "—" : "✓",
      sub: !hasUpstream ? "not pushed" : down ? "incoming" : unchecked ? "not checked" : "origin", hot: hot === 2, warm: hot === 2,
    },
  ];
  const flows: Flow[] = [];
  if (changed) flows.push({ gap: 0, dir: 1, tone: "acc" });
  if (up) flows.push({ gap: 1, dir: 1, tone: "acc" });
  if (down) flows.push({ gap: 1, dir: -1, tone: "warn" });
  // Edits come first, except when only origin is ahead: a fast-forward is the move git allows, and the
  // hero is the only pull entry. Diverged can't fast-forward: Merge (a merge commit, never a rebase),
  // with Merge & push beside it, so pushing is always its own choice; with edits, Commit then Merge.
  const both = up > 0 && down > 0;
  const action: PipeAction | null = changed ? (down && !up ? { verb: "Pull", n: down, gap: 1, tone: "warn" } : { verb: "Commit", n: changed, gap: 0, tone: "acc" })
    : down ? { verb: both ? "Merge" : "Pull", n: down, gap: 1, tone: "warn" }
    : up ? { verb: "Publish", n: up, gap: 1, tone: "acc" }
    : null;
  const alt: PipeAlt | null = both ? (changed ? { verb: "Merge", n: down } : { verb: "Merge & push", n: up + 1 })
    : changed && up ? { verb: sync.kind === "publish" ? "Publish" : "Push", n: up } : null;
  const say = changed ? `${files(changed)} edited, not committed`
    : both ? "You and origin both moved on"
    : down ? `${down} new on origin`
    : up ? `${commits(up)} only on this Mac`
    : sync.kind === "synced" ? (unchecked ? "Not checked against origin yet" : `Everything is on ${where}`)
    : sync.kind === "local" ? "No remote, this repo lives only here"
    : sync.kind === "detached" ? "Detached HEAD, no branch to push"
    : "Nothing to push";
  return { stations, flows, action, alt, say };
}

/** The delivery tracker's view of a Pipe: where the work is (`at`: 0 Mac, 1 committed, 2 origin; -1 = landed),
 *  one sentence, the next hop, and three stops. Real counts come in as `n` (stations carry a capped string). */
export type Stop = { key: "mac" | "branch" | "origin"; label: string; value: string; tone: "acc" | "ok" | "warn" | "dim" };
/** `then`: a hop that stays reachable behind the primary (edits under an incoming Pull). */
export type Track = { say: string; next: string; at: -1 | 0 | 1 | 2; stops: Stop[]; then: { verb: "Commit"; n: number } | null };

export function counts(sync: PipeSync) {
  return {
    up: sync.kind === "diverged" ? sync.ahead ?? 0 : sync.kind === "ahead" || sync.kind === "publish" ? sync.n ?? 0 : 0,
    down: sync.kind === "diverged" ? sync.behind ?? 0 : sync.kind === "behind" ? sync.n ?? 0 : 0,
  };
}

/** `clash`: diverged, how many files the merge's dry run says would clash (null/undefined: not known). */
export function track(p: Pipe, n: { changed: number; up: number; down: number }, clash?: number | null): Track {
  const a = p.action;
  const at = a ? ({ Commit: 0, Publish: 1, Pull: 2, Merge: 2 } as const)[a.verb] : -1;
  const origin = p.stations[2];
  const pullFirst = a?.verb === "Pull" && n.changed > 0;
  const both = n.up > 0 && n.down > 0;
  const next = !a ? ""
    : both && n.changed ? `next hop: commit ${files(n.changed)}, then merge ${n.down}`
    : both ? (clash ? `${files(clash)} changed on both sides` : `a merge joins them; your ${n.up} keep their ids`)
    : pullFirst ? `next hop: pull ${commits(a.n)}, then commit ${files(n.changed)}`
    : a.verb === "Commit" ? `next hop: commit ${files(n.changed)}${n.up && !n.down ? `, then publish ${commits(n.up)}` : ""}`
    : `next hop: ${a.verb.toLowerCase()} ${commits(a.n)}`;
  const say = pullFirst ? `${n.down} new on origin, your ${files(n.changed)} still here`
    : both ? "You and origin both moved on"
    : n.changed ? "Your work is still on this Mac"
    : n.up && !n.down ? "Committed, not on origin yet"
    : p.say;
  const stops: Stop[] = [
    { key: "mac", label: "On this Mac", value: n.changed ? files(n.changed) : "clean", tone: n.changed ? "acc" : "ok" },
    { key: "branch", label: "Committed", value: n.up ? commits(n.up) : "in sync", tone: n.up ? "acc" : "ok" },
    {
      key: "origin", label: "On origin",
      value: origin.sub === "not pushed" ? "not pushed" : n.down ? `${n.down} new` : origin.sub === "not checked" ? "not checked" : "up to date",
      tone: n.down ? "warn" : origin.sub === "not pushed" || origin.sub === "not checked" ? "dim" : "ok",
    },
  ];
  return { say, next, at, stops, then: pullFirst ? { verb: "Commit", n: n.changed } : null };
}
