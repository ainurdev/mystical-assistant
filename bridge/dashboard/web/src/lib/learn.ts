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
