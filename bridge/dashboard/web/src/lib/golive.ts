// The rail's ⟳ (components/hud/LiveButton.tsx): what going live does, and when it pops.
import type { LiveCommit, LivePart } from "../api";

/** The button's verb: rebuild the apps that are behind, restart when the bridge is. */
export function verb(parts: LivePart[]): string {
  const rebuild = parts.some((p) => p.act === "rebuild");
  const restart = parts.some((p) => p.act === "restart");
  return rebuild && restart ? "REBUILD & RESTART" : restart ? "RESTART" : "REBUILD";
}

/** Every part's commits once (a commit can touch two parts), newest first. */
export function commitsOf(parts: LivePart[]): LiveCommit[] {
  const by = new Map<string, LiveCommit>();
  for (const p of parts) for (const c of p.commits) by.set(c.sha, c);
  return [...by.values()].sort((a, b) => b.at - a.at);
}

/** Whether ⟳ pops: a commit that isn't live landed after `seen` (the newest commit time it
 *  last popped for, or saw at all). The newest such commit, and how many are new. */
export function popFor(parts: LivePart[], seen: number): { newest: LiveCommit; fresh: number } | null {
  const cs = commitsOf(parts).filter((c) => c.at > seen);
  return cs.length ? { newest: cs[0], fresh: cs.length } : null;
}
