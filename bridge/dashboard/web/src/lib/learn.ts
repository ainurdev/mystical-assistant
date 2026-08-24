import type { Lesson } from "../api";

/* The LEARN tab's pure parts — grouping lessons onto concept shelves, and
   pulling a lesson's closing question out of its markdown so it can be asked
   before the lesson is shown. Kept out of the component so both are checkable
   (learn.check.ts). */

/** A lesson's identity across repos. The file name alone is not one: every repo
 *  numbers from 0001, so `0001-….md` names a different lesson in each. */
export const lessonKey = (l: { project?: string; file: string }) =>
  `${l.project ?? ""}::${l.file}`;

export const UNSORTED = "unsorted";

export interface Shelf {
  concept: string;
  lessons: Lesson[];
  unread: number;
}

/** Lessons grouped onto concept shelves, each shelf ordered newest-first and the
 *  shelves themselves ordered by their newest lesson — so the concept you were
 *  working in today sits at the top. Lessons written before concepts existed
 *  land on `unsorted`, which is always last however recent it is. */
export function shelves(list: Lesson[], read: Set<string>): Shelf[] {
  const by = new Map<string, Lesson[]>();
  for (const l of list) {
    const c = l.concept || UNSORTED;
    (by.get(c) ?? by.set(c, []).get(c)!).push(l);
  }
  return [...by.entries()]
    .map(([concept, ls]) => {
      const lessons = [...ls].sort((a, b) => b.at - a.at);
      return { concept, lessons, unread: lessons.filter((l) => !read.has(lessonKey(l))).length };
    })
    .sort((a, b) =>
      (a.concept === UNSORTED ? 1 : 0) - (b.concept === UNSORTED ? 1 : 0) ||
      b.lessons[0].at - a.lessons[0].at);
}

/** The lesson's own closing question, so the tab can ask it before showing the
 *  answer. The section runs to the next blank line or the footer rule; "" when
 *  the model skipped it (older lessons, and it is only ever asked for). */
export function checkYourself(md: string): string {
  const m = md.match(/\*\*Check yourself\*\*\s*[—–:-]?\s*([\s\S]*?)(?:\n\s*\n|\n---|$)/i);
  return (m?.[1] || "").replace(/\s+/g, " ").trim();
}

/** The next lesson worth opening: the newest one not yet read, else nothing —
 *  an all-read shelf should not nag you with a question you have answered. */
export const nextUnread = (list: Lesson[], read: Set<string>): Lesson | undefined =>
  [...list].sort((a, b) => b.at - a.at).find((l) => !read.has(lessonKey(l)));

// ── study scheduler ──────────────────────────────────────────────────────────
// Gentle mode: GOT IT on a lesson outside the ladder retires it for good; only
// REVIEW AGAIN enters the 1d → 3d → 7d ladder, and climbing off the top
// retires. Retired = no entry here + present in the read set. Times: epoch ms.

export interface SchedEntry { box: 1 | 2 | 3; due: number }
export type Sched = Record<string, SchedEntry>;

const DAY_MS = 86_400_000;
const STEP_MS = { 1: DAY_MS, 2: 3 * DAY_MS, 3: 7 * DAY_MS } as const;

export function grade(sched: Sched, key: string,
  verdict: "got" | "review" | "skip", now: number): Sched {
  const next = { ...sched };
  const cur = next[key];
  if (verdict === "review") next[key] = { box: 1, due: now + STEP_MS[1] };
  else if (verdict === "got" && cur && cur.box < 3) {
    const box = (cur.box + 1) as 2 | 3;
    next[key] = { box, due: now + STEP_MS[box] };
  } else delete next[key]; // skip, got-at-top, or got outside the ladder
  return next;
}

export const dueCount = (list: Lesson[], sched: Sched, now: number): number =>
  list.filter((l) => (sched[lessonKey(l)]?.due ?? Infinity) <= now).length;

/** STUDY's next card: overdue reviews first (most overdue first), then fresh
 *  unread oldest-first — skipping the concept just dealt, so one shelf's
 *  same-day run of lessons interleaves with the others. */
export function deal(list: Lesson[], read: Set<string>, sched: Sched, now: number,
  lastConcept?: string): Lesson | undefined {
  const due = list
    .filter((l) => (sched[lessonKey(l)]?.due ?? Infinity) <= now)
    .sort((a, b) => sched[lessonKey(a)]!.due - sched[lessonKey(b)]!.due);
  if (due.length) return due[0];
  const fresh = list
    .filter((l) => !read.has(lessonKey(l)) && !sched[lessonKey(l)])
    .sort((a, b) => a.at - b.at);
  return fresh.find((l) => (l.concept || UNSORTED) !== lastConcept) ?? fresh[0];
}
