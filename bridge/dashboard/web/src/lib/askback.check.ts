// Run: node bridge/dashboard/web/src/lib/askback.check.ts
import { askBack } from "./askback.ts";

// The screenshot's result: two alternatives offered in prose.
const real = askBack(
  "Not live yet — the dashboard serves a prebuilt dist from the launch checkout, which is sitting on branch `remove-preview`, not master. Want me to build+deploy it there, or leave the change on master?",
)!;
console.assert(real !== null, "trailing question detected");
console.assert(
  real.question === "Want me to build+deploy it there, or leave the change on master?",
  `question: ${JSON.stringify(real.question)}`,
);
console.assert(real.body.endsWith("not master."), `body: ${JSON.stringify(real.body.slice(-24))}`);
console.assert(
  real.options.join(" | ") === "Build+deploy it there | Leave the change on master",
  `options: ${JSON.stringify(real.options)}`,
);

// A plain yes/no ask.
console.assert(askBack("Done. Should I commit this?")!.options.join() === "Yes,No", "yes/no");
console.assert(askBack("Is that what you meant?")!.options.join() === "Yes,No", "bare yes/no");
console.assert(askBack("Want me to do it?")!.body === "", "question-only result has no body");

// A bare imperative — no auxiliary leads it, so it used to get no chips and had
// to be typed out on a phone. This is the shape that stranded sessions in ASK.
console.assert(askBack("Still uncommitted. Commit it now?")!.options.join() === "Yes,No", "imperative ask");
console.assert(askBack("Ship it?")!.options.join() === "Yes,No", "two-word imperative");

// Open-ended: highlight it, but don't invent Yes/No for it.
console.assert(askBack("What should I name the flag?")!.options.length === 0, "open question");

// "or" outside a Want-me-to lead-in must not become two chips.
console.assert(askBack("Is this a bug or a feature?")!.options.join() === "Yes,No", "unsafe or-split");

// An alternative too long to fit a chip falls back.
console.assert(
  askBack("Want me to " + "x".repeat(70) + ", or stop?")!.options.join() === "Yes,No",
  "long alternative falls back",
);

// Not a question at the end = nothing to highlight.
console.assert(askBack("All tests pass.") === null, "statement");
console.assert(askBack("Fixed? No — I ran tsc and it failed.") === null, "question mid-text");

// A question split across paragraphs keeps only the last line.
const para = askBack("First line.\n\nSecond thing done.\n\nShould I push?")!;
console.assert(para.question === "Should I push?", `para: ${JSON.stringify(para.question)}`);
console.assert(para.body.endsWith("Second thing done."), `para body: ${JSON.stringify(para.body)}`);

// Lettered options in prose above a "Which…?" become its chips.
const dirs = askBack(
  "Drew three directions.\n\n- **A · TOKEN** (recommended): one chip.\n- **B · HEADER**: a band on top.\n" +
  "- **C · SEGMENT**: a solid segment.\n\nWhich direction do you want?",
)!;
console.assert(dirs.options.join("|") === "A · TOKEN|B · HEADER|C · SEGMENT", `lettered: ${JSON.stringify(dirs.options)}`);
const plain = askBack("Two ways:\n\nA) Redis, fast\nB) SQLite — simple\n**Option 3:** neither\n\nWhich one?")!;
console.assert(plain.options.join("|") === "A · Redis, fast|B · SQLite|3 · neither", `plain: ${JSON.stringify(plain.options)}`);
console.assert(askBack("A) only one\n\nWhich one?")!.options.length === 0, "one option is not a choice");
console.assert(askBack("Done.\n\nWhat should I call it?")!.options.length === 0, "an open question stays open");
console.assert(askBack("- **A · x**: y\n- **B · z**: w\n\nWant me to go with A?")!.options.join() === "Yes,No", "yes/no wins over a list");

console.log("askback ok");
