// Run: node bridge/dashboard/web/src/lib/reviewnotes.check.ts
import { parseDiff } from "./diff.ts";
import {
  countByPath, lineLabel, loadNotes, noteRange, notesKey, notesMessage, reanchor, saveNotes, type Note,
} from "./reviewnotes.ts";

const ok = (cond: boolean, what: string) => {
  if (!cond) throw new Error(`FAIL: ${what}`);
  console.log(`ok - ${what}`);
};

// --- picking lines off the diff ---------------------------------------------
const rows = parseDiff([
  "@@ -31,4 +31,5 @@ export class S {",
  "   constructor() {}",
  "-  // TODO",
  "+  group() {",
  "+    return 1;",
  "+  }",
  "   list() {}",
].join("\n"));
// rows: 0 hunk · 1 ctx 31 · 2 del · 3 add 32 · 4 add 33 · 5 add 34 · 6 ctx 35
const r = noteRange(rows, 2, 4);
ok(r?.start === 32 && r?.end === 33 && r?.code === "  group() {", "a drag over a deleted line cites only the lines still in the file");
ok(noteRange(rows, 4, 3)?.start === 32, "dragging up gives the same range as dragging down");
ok(noteRange(rows, 2, 2) === null && noteRange(rows, 0, 0) === null, "a deleted line or a hunk header alone takes no note");
ok(lineLabel(45, 45) === "L45" && lineLabel(36, 37) === "L36–37", "thread headers read L45 and L36–37");
ok(r?.prev === "  constructor() {}" && noteRange(rows, 1, 1)?.prev === undefined, "a note keeps the line above it, when the diff shows it");

// --- SEND re-finds each line in the tree as it is now ------------------------
const n = (o: Partial<Note>): Note => ({ id: "x", path: "s.ts", start: 32, end: 33, code: "  group() {", text: "t", at: 0, ...o });
const same = Array.from({ length: 40 }, (_, i) => (i === 31 ? "  group() {" : `l${i + 1}`));
ok(reanchor(n({}), same).start === 32 && !reanchor(n({}), same).lost, "an untouched line keeps its number");
const moved = ["a", "b", "  group() {", "c"];
const m = reanchor(n({}), moved);
ok(m.start === 3 && m.end === 4 && !m.lost, "a line the agent moved is found again, and the range keeps its length");
const twice = Array.from({ length: 50 }, (_, i) => (i === 2 || i === 35 ? "  group() {" : `l${i}`));
ok(reanchor(n({}), twice).start === 36, "with two candidates the nearer one wins");
ok(reanchor(n({}), ["nothing here"]).lost === true, "a line that's gone is marked lost and keeps its old number");
ok(reanchor(n({}), null).lost === true, "an unreadable file loses the note's line too");
// A CRLF file: git's diff lines and the file's lines both keep their "\r", so they still match.
const crlf = parseDiff("@@ -1,2 +1,2 @@\r\n-a\r\n+b\r\n c\r\n");
const crow = noteRange(crlf, 2, 2);
ok(crow?.code === "b\r" && !reanchor(n({ start: 1, end: 1, code: crow!.code }), "b\r\nc\r\n".split("\n")).lost,
  "a note on a CRLF file is found again at SEND");
// What the bridge actually serves (checked 2026-10-06): git.diff runs git in a
// text-mode subprocess, which turns "\r\n" into "\n", while files/read decodes
// raw bytes and keeps the "\r". The note's code has no "\r"; the file's lines do.
ok(!reanchor(n({ start: 1, end: 1, code: "b" }), "b\r\nc\r\n".split("\n")).lost
  && reanchor(n({ start: 1, end: 1, code: "b" }), "x\r\nb\r\n".split("\n")).start === 2,
  "a CRLF line is found again when only the file read keeps its \\r");

// A "}" is everywhere: the line above it has to come along, or it isn't the same line.
const brace = n({ start: 3, end: 3, code: "}", prev: "  return a;" });
ok(reanchor(brace, ["function b() {", "  return b;", "}", "function a() {", "  return a;", "}"]).start === 6,
  "a moved } is found by its neighbour, not by the first } at its old number");
ok(reanchor(brace, ["x", "y", "}", "z", "}"]).lost === true, "a } whose neighbour is gone is lost, not moved to another }");
ok(reanchor(n({ start: 2, end: 2, code: "b", prev: "a\r" }), ["a", "b"]).start === 2, "the neighbour ignores a trailing \\r too");

// --- the message (sheet A) ---------------------------------------------------
const msg = notesMessage("feat/inbox-grouping", [
  n({ path: "frontend/src/routes/inbox.tsx", start: 88, end: 88, text: "show the client's name here, not its id" }),
  n({ path: "backend/src/inbox/group.service.ts", start: 45, end: 45, text: "sort groups by client name so the inbox order stays stable" }),
  n({ path: "backend/src/inbox/group.service.ts", start: 36, end: 37, text: "flatten these two ifs — const key = item.meeting?.clientId; if (!key) continue;" }),
]);
ok(msg === [
  "Review notes on ⎇ feat/inbox-grouping (3):",
  "backend/src/inbox/group.service.ts:36-37",
  "  flatten these two ifs — const key = item.meeting?.clientId; if (!key) continue;",
  "backend/src/inbox/group.service.ts:45",
  "  sort groups by client name so the inbox order stays stable",
  "frontend/src/routes/inbox.tsx:88",
  "  show the client's name here, not its id",
].join("\n"), "the message is sheet A's, sorted by file then line");
ok(notesMessage("b", [n({ text: "one\ntwo", lost: true })]).endsWith("s.ts:32-33 (that line has changed since)\n  one\n  two"),
  "a multi-line note indents every line, and a lost one says so");
ok(countByPath([n({}), n({ id: "y" }), n({ path: "t.ts" })])["s.ts"] === 2, "file rows count their notes");

// --- storage -----------------------------------------------------------------
const mem = new Map<string, string>();
(globalThis as unknown as { localStorage: Pick<Storage, "getItem" | "setItem" | "removeItem"> }).localStorage = {
  getItem: (k) => mem.get(k) ?? null,
  setItem: (k, v) => { mem.set(k, String(v)); },
  removeItem: (k) => { mem.delete(k); },
};
const k = notesKey("ainurhq/rivendell", "feat/x");
ok(loadNotes(k).length === 0, "a branch with no notes loads empty");
saveNotes(k, [n({})]);
ok(loadNotes(k)[0].text === "t" && loadNotes(notesKey("ainurhq/rivendell", "main")).length === 0, "notes belong to their branch");
saveNotes(k, []);
ok(mem.size === 0, "clearing removes the key instead of storing []");
mem.set("review-notes:" + k, "{not json");
ok(loadNotes(k).length === 0, "a corrupt entry loads as no notes, not a crash");

console.log("\nall reviewnotes checks passed");
