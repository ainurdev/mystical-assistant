import { useCallback, useSyncExternalStore } from "react";

/** The CHANGES panel's commit box, kept outside the panel.
 *
 *  The rail rebuilds that panel on every tab or session switch (RightPanel keys
 *  its body on tab + worktree), so anything inside it — the message you typed,
 *  the GENERATE still running — died with it, and a generated message came back
 *  to a component that was gone. Keyed by worktree because that is what the
 *  message describes: two sessions on one branch share a box, two branches of
 *  one repo don't.
 *
 *  ponytail: module-level store like Notifications.tsx — one Map plus
 *  subscribers, no provider. Not persisted: a reload clears the box, as it
 *  always did. */

export interface Draft { msg: string; gen: boolean }

const EMPTY: Draft = { msg: "", gen: false };
const drafts = new Map<string, Draft>();
const subs = new Map<string, Set<() => void>>();

export const draftKey = (project: string | null | undefined, branch?: string | null) =>
  `${project ?? ""}@${branch ?? ""}`;

export function getDraft(key: string): Draft { return drafts.get(key) ?? EMPTY; }

export function patchDraft(key: string, patch: Partial<Draft>) {
  drafts.set(key, { ...getDraft(key), ...patch });
  for (const fn of subs.get(key) ?? []) fn();
}

export function subscribeDraft(key: string, fn: () => void): () => void {
  const set = subs.get(key) ?? new Set<() => void>();
  subs.set(key, set);
  set.add(fn);
  return () => { set.delete(fn); if (!set.size) subs.delete(key); };
}

/** Is a panel showing this worktree's box right now? A finished GENERATE
 *  either lands in it quietly or, with nobody watching, goes to the bell. */
export function watched(key: string): boolean { return (subs.get(key)?.size ?? 0) > 0; }

/** `null` reads an empty box and watches nothing — for the FILES mode of the
 *  same component, which shares the worktree but has no box to land in. */
export function useDraft(key: string | null): Draft {
  return useSyncExternalStore(
    useCallback((fn: () => void) => (key === null ? () => {} : subscribeDraft(key, fn)), [key]),
    () => (key === null ? EMPTY : getDraft(key)));
}
