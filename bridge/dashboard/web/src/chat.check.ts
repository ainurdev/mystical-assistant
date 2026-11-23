// Run: node bridge/dashboard/web/src/chat.check.ts
// Guards the one thing long-session performance rests on: mergeDelta must hand
// back the SAME turn objects it was given when a poll brings nothing new for
// them, so the memoized RunStream can skip re-rendering past turns.
import { derivePending, mergeDelta } from "./chat.ts";
import type { StoreEvent, StoreTurn, Transcript } from "./api.ts";

const ok = (cond: boolean, what: string) => {
  if (!cond) throw new Error(`FAIL: ${what}`);
  console.log(`ok - ${what}`);
};

const storeTurn = (id: string, seq: number): StoreTurn => ({
  id, seq, prompt: `p${seq}`, attachments: [], status: "done",
  cost: null, elapsed: null, started: 0,
});
const text = (turn_id: string, seq: number): StoreEvent =>
  ({ type: "text", text: "hi", seq, turn_id });
const tx = (turns: StoreTurn[], events: StoreEvent[]): Transcript =>
  ({ session: null, turns, events, next_cursor: 0 });

const first = mergeDelta([], tx([storeTurn("a", 0), storeTurn("b", 1)],
  [text("a", 0), text("b", 1)]));
ok(first.length === 2 && first[0].id === "a", "turns load in store order");
ok(first[0].events.length === 1, "events land on their turn");

// An idle re-poll: same turns, no new events.
const same = mergeDelta(first, tx([storeTurn("a", 0), storeTurn("b", 1)], []));
ok(same === first, "an empty delta returns the very same array");

// A new event on turn b: b changes, a must not.
const grown = mergeDelta(first, tx([storeTurn("a", 0), storeTurn("b", 1)], [text("b", 2)]));
ok(grown !== first, "a real delta returns a new array");
ok(grown[0] === first[0], "untouched turn keeps its identity");
ok(grown[1] !== first[1], "the turn that grew is a new object");
ok(grown[1].events.length === 2, "the new event was appended");

// A duplicate seq (overlapping cursor) must change nothing at all.
const dup = mergeDelta(grown, tx([storeTurn("a", 0), storeTurn("b", 1)], [text("b", 2)]));
ok(dup === grown, "a re-delivered event is a no-op");

// A status flip must still produce a new object (the row has to repaint).
const running = { ...storeTurn("b", 1), status: "running" as const };
const flipped = mergeDelta(grown, tx([storeTurn("a", 0), running], []));
ok(flipped[1] !== grown[1] && flipped[1].status === "running", "status change repaints");
ok(flipped[0] === grown[0], "sibling turn still untouched by a status change");

// A question nobody answered: pending while the turn runs, gone once it ends.
const ask = (turn_id: string, seq: number): StoreEvent =>
  ({ type: "question", request_id: "r1", questions: [], seq, turn_id });
const asked = mergeDelta([], tx([{ ...storeTurn("a", 0), status: "running" }], [ask("a", 0)]));
ok(asked[0].pending.length === 1, "an unanswered question blocks while the turn runs");
const over = mergeDelta(asked, tx([{ ...storeTurn("a", 0), status: "error" }], []));
ok(over[0].pending.length === 0, "the turn ending clears the unanswered question");

// A delta that repeats a seq inside itself keeps the first, in arrival order; and a
// long turn loads in linear time (one copy per event was quadratic).
{
  const twice = mergeDelta(first, tx([storeTurn("a", 0), storeTurn("b", 1)],
    [text("b", 5), text("a", 4), text("b", 5), text("b", 3), text("b", 1)]));
  ok(twice[1].events.map((e) => (e as { seq?: number }).seq).join() === "1,5,3", "in-delta duplicates dropped, order kept");
  ok(twice[0].events.length === 2, "each turn gets its own events");
  const many = Array.from({ length: 20000 }, (_, i) => text("a", i));
  const t0 = performance.now();
  const big = mergeDelta([], tx([storeTurn("a", 0)], many));
  ok(big[0].events.length === 20000, "a 20k-event turn loads whole");
  ok(performance.now() - t0 < 1000, "and in well under a second");
}

console.log("all mergeDelta identity checks passed");

// A turn's outline comes with a tailed load only; the polls after it carry none
// and must neither drop it nor cost a re-render.
{
  const sum = { answer: "Done.", tools: 3, ended: 9, marks: [] };
  const loaded = mergeDelta([], tx([{ ...storeTurn("a", 0), sum, elapsed: 42 }], []));
  ok(loaded[0].sum?.answer === "Done." && loaded[0].elapsed === 42, "a tailed load brings the outline and the elapsed");
  const polled = mergeDelta(loaded, tx([{ ...storeTurn("a", 0), elapsed: 42 }], []));
  ok(polled === loaded, "a poll without an outline changes nothing");
  ok(polled[0].sum === sum, "and keeps the outline it had");
  const again = mergeDelta(loaded, tx([{ ...storeTurn("a", 0), sum: { ...sum }, elapsed: 42 }], []));
  ok(again === loaded, "the same outline sent again is no change either");
  const moved = mergeDelta(loaded, tx([{ ...storeTurn("a", 0), sum: { ...sum, answer: "Shipped." }, elapsed: 42 }], []));
  ok(moved[0].sum?.answer === "Shipped.", "a new outline replaces the old");
}

// A secret waits like a question, and its answer retires it.
{
  const asked = derivePending([{ type: "secret_request", request_id: "gw-1", name: "K", why: "w" }]);
  if (asked.length !== 1 || asked[0].kind !== "secret" || asked[0].request_id !== "gw-1") throw new Error("a secret request is pending");
  if (derivePending([{ type: "secret_request", request_id: "gw-1", name: "K", why: "w" }, { type: "secret_answered", request_id: "gw-1", given: false }]).length) throw new Error("answered, it isn't");
  console.log("ok - a secret is pending until answered");
}
