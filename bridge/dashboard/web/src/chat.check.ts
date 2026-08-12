// Run: node bridge/dashboard/web/src/chat.check.ts
// Guards the one thing long-session performance rests on: mergeDelta must hand
// back the SAME turn objects it was given when a poll brings nothing new for
// them, so the memoized RunStream can skip re-rendering past turns.
import { mergeDelta } from "./chat.ts";
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

console.log("all mergeDelta identity checks passed");
