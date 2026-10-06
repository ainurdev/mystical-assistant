# Review Loop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Send what a reviewer finds back to the agent in one click: notes left on GIT tab diff lines, a PR's failing check, or a review's comments. The chat header shows the branch's PR state.

**Architecture:** There are two independent halves.

- **A (diff notes)** is browser-only. `lib/reviewnotes.ts` holds the model, storage, re-anchoring and message. `ChangesTab` draws a gutter, an editor, threads and a send bar. SEND goes through App's existing `send()`, which already queues behind a running turn, and `send()` now reports whether the message went.
- **B/C (PR chip)** adds the stdlib module `bridge/prstatus.py`. It reads `gh pr view <branch>`. For failing Actions jobs it adds `gh run view --log-failed`, and for a changes-requested review it makes two REST calls. Results are cached for each (repo, branch), and a red build or a review pings Telegram once. `GET /local/github/pr/status` serves this to `PrChip.tsx` in the nameplate's caption row. The chip polls only while its tab is visible, and the bell repeats the pings.

**Tech Stack:** Python 3 stdlib plus the `gh` CLI (bridge). React 19 and TypeScript with inline styles and CSS variables (dashboard). pytest. Node-run `*.check.ts` files.

**Spec:** `docs/superpowers/specs/review-loop.md` (approved 2026-10-06). The mockups are in the main checkout's `.mystical/design-drafts/review-loop/` (`a-diff-comments.html`, `b-pr-chip.html`, `c-pr-states.html`; git-ignored).

## Global Constraints

- Backend: Python stdlib only, no new packages. Web: no new npm dependencies.
- Dashboard only. No Mini App route or UI, and no bot slash command. bridge-feature-slice rows skipped on purpose: 2 (storage uses the existing `settings` key-value table, with no schema change), 4/6/8 (Mini App, which the spec excludes), 9 (bot: a Telegram ping only), 10 (pubsub: the chip polls by design).
- Merging stays on GitHub. There is no MERGE button anywhere.
- Diff notes are localStorage drafts, one set for each project and branch. There is no server table.
- Review comments are sent all at once, with no per-comment ticking.
- Polling happens every 60s only while the session is open in a visible tab, plus on focus and after a dashboard push. The server keeps one cache for each (repo, branch).
- Pings go to the bell and Telegram once per head commit when checks turn red, and once per review when changes are requested. A green run clears the failing ping.
- Every failure is quiet. gh missing or signed out, no GitHub remote, no PR, rate-limited, or an old bridge that 404s the route: each one draws no chip. Never an error toast.
- Tokens: `--err` FAILING · `--warn` review comments · `--ok` green and READY (READY filled) · `--purple` notes and MERGED · `--acc` running and the gutter `+`. Chip type is 9px (`var(--t9)`) with `.6px` tracking.
- Copy, verbatim from the spec and mockups: `SEND TO AGENT ▸`, `SEND FAILURE TO AGENT ▸`, `SEND n COMMENTS TO AGENT ▸`, `ARCHIVE SESSION`, `REMOVE WORKTREE`, `Each asks first. Nothing is archived or removed on its own.`, `CHECKED EVERY 60S WHILE THE SESSION IS OPEN · VIA gh`, `new session here`, `⌘↵ ADD · ESC CANCEL`.
- Repo conventions: `ponytail:` comments mark a deliberate shortcut and name its ceiling. A new module gets a docstring saying why it is built the way it is. Tests never set env in the test module (`tests/conftest.py` pins it). Use the app's inline-style idiom with CSS variables.
- Commit messages are plain. No `Co-Authored-By` and no "Generated with" lines.
- Don't restart the bridge, push, switch branches or touch the main checkout. Any manual script uses `BRIDGE_DB=/tmp/plan-rl.db` and `TELEGRAM_BOT_TOKEN=` (empty).

## Review Focus

These are the failure modes the spec implies but no test would otherwise cover. Each one is pinned in the task that owns its code.

1. **An all-digit branch name** ("123", or "#45"). `gh pr view 123` reads it as PR number 123 (checked live), so the chip would show some other PR, and SEND FAILURE would hand another PR's log to the agent. The expected result is no chip. Pinned in Task 6: `test_an_all_digit_branch_gets_no_chip_rather_than_pr_number_59`.
2. **A note on a file with CRLF line endings.** git's diff lines and the file's lines both keep their `\r`, so SEND must still find the noted line. Pinned in Task 2's check: "a note on a CRLF file is found again at SEND".
3. **A commit status in ERROR**, for example an external CI that crashed. It must read as failing and turn the chip red, not spin as running forever. Pinned in Task 5: `test_a_commit_status_in_error_is_failing_and_pending_is_running`.
4. **Telegram unreachable or the bot token revoked.** The chip's read still answers, and the ping failure is only printed. Pinned in Task 6: `test_telegram_failing_never_breaks_the_read`.
5. **Esc while typing a note.** It cancels the note only. Without care it would also close the whole Project modal, because App closes overlays on a window-level Esc (`App.tsx` ~1006). Pinned in Task 3's code (`e.stopPropagation()`), with a manual step in Task 10, Step 7.

---

## Before you start

- **Where.** Worktree `/home/mhzrerfani/projects/.worktrees/mystical-assistant/feat-review-loop`, branch `feat/review-loop`, cut from master `666d29a1`. The spec is commit `b3fb2ab7`. Every path below is relative to the worktree root.
- **Backend suite.** `python3 -m pytest tests/ -q` currently gives `1460 passed, 2 skipped` in about 35s. After Task 7 it should give `1495 passed, 2 skipped`. Some existing tests make real HTTPS calls to Telegram with the fake test token, so an occasional stray `[telegram] sendMessage error: … 401 Unauthorized` line can show up. That predates this work: on 2026-10-06 it was traced to `test_bridge.py`, `test_limits.py` and a runner notify thread.
- **Web checks** run from the worktree root: `node bridge/dashboard/web/src/lib/<name>.check.ts`. Node 24 strips the types. In a checked lib file, runtime imports of other lib files need the `.ts` extension, while `import type` can stay bare. A check must not load anything that touches `window` or `location` at import time, which `api.ts` does. Importing types from it is fine.
- **Typecheck.** Run `cd bridge/dashboard/web && node_modules/.bin/tsc -p tsconfig.app.json` (not `tsc -p .`). `node_modules` in this worktree is a symlink to the main checkout's, which predates `remark-breaks` (added in `4a73fed3`). So the baseline is exactly one error, `src/components/Markdown.tsx(4,26): error TS2307: Cannot find module 'remark-breaks'`, and `vite build` fails for the same reason. Any other error is yours. Task 10 gives the worktree a private `node_modules`. Don't run `npm install` in the main checkout.
- **This shell carries the live bridge's `.env`.** `TELEGRAM_BOT_TOKEN` and `ALLOWED_CHAT_IDS` are set in it. Tests are safe, because conftest pins them. A manual server or script must still set `TELEGRAM_BOT_TOKEN=` (empty) and `BRIDGE_DB=/tmp/plan-rl.db`.
- **gh.** gh 2.92 is installed and signed in, with the `repo` and `read:org` scopes. The gh behaviour this plan relies on was checked live on 2026-10-06. The details are in `bridge/prstatus.py`'s docstring and the test fixtures.
- **Stopping servers.** Never use `pkill -f`, because it kills your own wrapper shell. Stop a server by the PID listening on its port.

## Decisions this plan makes (the spec left them open)

1. **Deleted lines take no note.** A `-` row has no working-tree line to cite. A drag across deleted lines cites only the lines still in the file.
2. **The GIT tab's numbering is fixed.** `parseDiffRows` (`AnalyzeModal.tsx:385`) counted deleted lines, so every number after a deletion was wrong. The tab now uses `lib/diff.ts`'s `parseDiff`, which nothing imported before. That was required for correct citations.
3. **"The working tree's line numbers at the moment you press SEND"** is done by re-anchoring. SEND reads each noted file again and finds the anchor line's text, taking the nearest match. A line that is gone is sent as `path:N (that line has changed since)`.
4. **SEND closes the modal and opens the target session**, so you see the agent pick the notes up. Notes are cleared only after `send()` says the message ran or was queued. A failed send keeps them. At SEND, the notes are re-read from storage, so a second tab can't send them twice.
5. **CLEAR asks first** (`askConfirm`). Notes are typed text, and CLEAR is the only way to lose them.
6. **Changes-requested pings once per review**, keyed by reviewer and time, not once per head commit. Otherwise every fix pushed while the review still says CHANGES_REQUESTED would ping again. Red checks ping once per head commit, and an all-green read clears that ping.
7. **Ping state lives in the `settings` table**, so a bridge restart doesn't ping again.
8. **The Telegram ping carries the existing Open Panel button** (`telegram.panel_kb`), not a SEND button. Mockup B's callout mentions "the same SEND button", but a Telegram SEND needs a new `dispatch.py` callback and server-side message composition. ponytail: deferred. The bell entry is a plain notice, and the SEND buttons stay in the popover.
9. **READY** also covers a green PR in a repo that asks for no review (`reviewDecision` empty and nobody requested), as well as APPROVED.
10. **Skipped and stale checks are hidden.** A re-run, or a workflow fired twice, collapses to its newest attempt. That is how `gh pr checks` does it.
11. **Review comments** are the changes-requested review's body plus its inline comments. `gh pr view` has no comment text, and the per-review REST endpoint returns `line: null` (checked on cli/cli#14456). So the code finds the review's numeric id, then filters `pulls/<n>/comments` by `pull_request_review_id`.
12. **ARCHIVE SESSION** uses `api.archiveSession` (`store.archive`, which sets archived=1 and lifecycle 'done') and keeps the chat on the session, so REMOVE WORKTREE is still reachable. **REMOVE WORKTREE** removes the worktree and keeps the branch. It is offered only when the session runs in a linked worktree, and it is disabled while a turn runs.
13. **All-digit branches get no chip** (Review Focus 1).
14. **PRs are looked up in `origin`'s repo**, the same as `create_pr`. A fork whose PRs live upstream shows no chip.
15. **"After a dashboard push"** is a `hud:pushed` window event fired by `api.gitPush` and `api.createPr`. The chip re-reads 8s later. A push the agent makes from its own shell is picked up by the 60s poll.
16. **The popover shows the last 6 lines** of each failing log. SEND sends the whole tail, up to 60 lines.
17. **Server cache:** TTL 45s, a 10s floor on forced reads, and a 300s back-off on errors, during which the last good PR stays on screen.

## File map

| File | | Responsibility |
|---|---|---|
| `bridge/prstatus.py` | new | gh → PR snapshot, cache, ping state, Telegram |
| `bridge/dashboard/server.py` | modify | `GET /local/github/pr/status` |
| `tests/test_prstatus.py` | new | prstatus logic |
| `tests/test_prstatus_endpoint.py` | new | the route |
| `bridge/dashboard/web/src/lib/diff.ts` | modify | unified diff → rows numbered by the working tree |
| `bridge/dashboard/web/src/lib/diff.check.ts` | new | its check |
| `bridge/dashboard/web/src/lib/reviewnotes.ts` | new | notes model, storage, re-anchoring, message |
| `bridge/dashboard/web/src/lib/reviewnotes.check.ts` | new | its check |
| `bridge/dashboard/web/src/lib/prchip.ts` | new | chip words and colours, durations, SEND messages, bell lines |
| `bridge/dashboard/web/src/lib/prchip.check.ts` | new | its check |
| `bridge/dashboard/web/src/components/hud/DiffNotes.tsx` | new | `NoteEditor`, `NoteThread`, `SendBar` |
| `bridge/dashboard/web/src/components/hud/PrChip.tsx` | new | chip, popover, polling, bell |
| `bridge/dashboard/web/src/components/hud/AnalyzeModal.tsx` | modify | `ChangesTab` wiring |
| `bridge/dashboard/web/src/components/hud/Terminal.tsx` | modify | the chip in the caption row |
| `bridge/dashboard/web/src/App.tsx` | modify | `send()`/`startIn()` return booleans; `onSendTo`; `onSendText`; `archiveOpen` |
| `bridge/dashboard/web/src/api.ts` | modify | PR types, `prStatus`, `PUSHED_EVENT` |
| `bridge/dashboard/web/src/index.css` | modify | the gutter's hover rule |

Edits below are given as exact find and replace blocks. A task's **Files** list cites master's line numbers. Each block's "around line N" is where it sits when you reach it, after the earlier steps' edits. Each block was applied in task order to a clean copy of `b3fb2ab7`, and each task's gate was run there. That includes every fail-first run, the full suite (1495 passed), tsc with a full install (0 errors), `vite build`, and every `*.check.ts`.

---

### Task 1: The GIT tab numbers diff lines the way the working tree does

**Files:**
- Modify: `bridge/dashboard/web/src/lib/diff.ts` (the whole file, 45 lines; `parseDiff` exists today but nothing imports it)
- Create: `bridge/dashboard/web/src/lib/diff.check.ts`
- Modify: `bridge/dashboard/web/src/components/hud/AnalyzeModal.tsx:19` (import), `:369-403` (`DiffLine`, `DIFF_VIEW`, `parseDiffRows`), `:465` (`rows`)

`parseDiffRows` (`AnalyzeModal.tsx:385`) increments its counter on `-` lines, a choice its comment says was made to match the HUD mock's numbering. After any deletion, every number below is wrong by one more. Review notes cite these numbers to the agent, so they must be the working tree's. The fix is to reuse `lib/diff.ts`'s `parseDiff`, which already gives deleted lines no number. Two bugs come with it and are fixed here: a phantom numbered row from the trailing newline, and `---`/`+++` content lines inside a hunk being taken for file headers.

**Interfaces:**
- Produces: `export interface DiffRow { ln: string; mark: string; text: string; kind: "add" | "del" | "ctx" | "hunk" }` and `export function parseDiff(text: string): DiffRow[]`. `ln` is the working-tree line number as a string. It is `""` for deleted lines and hunk headers.

- [ ] **Step 1: Write the failing check**

Create `bridge/dashboard/web/src/lib/diff.check.ts`:

````ts
// Run: node bridge/dashboard/web/src/lib/diff.check.ts
//
// The GIT tab's diff numbers are what a review note cites to the agent, so
// they have to be the working tree's. ChangesTab's own parser (parseDiffRows,
// deleted in this change) counted deleted lines as well, so every number after
// a deletion was off by one more.
import { parseDiff } from "./diff.ts";

const ok = (cond: boolean, what: string) => {
  if (!cond) throw new Error(`FAIL: ${what}`);
  console.log(`ok - ${what}`);
};

const rows = parseDiff([
  "diff --git a/s.ts b/s.ts",
  "index 1111111..2222222 100644",
  "--- a/s.ts",
  "+++ b/s.ts",
  "@@ -31,4 +31,5 @@ export class S {",
  "   constructor() {}",
  "-  // TODO(inbox): group items by client",
  "+  group() {",
  "+    return 1;",
  "+  }",
  "   list() {}",
  "\\ No newline at end of file",
  "",
].join("\n"));

ok(rows.length === 7, "headers, the newline marker and the trailing newline are not rows");
ok(rows[0].kind === "hunk" && rows[0].ln === "", "the hunk header is a row with no number");
ok(rows[1].ln === "31" && rows[1].text === "  constructor() {}", "context starts at the hunk's new-file line");
ok(rows[2].kind === "del" && rows[2].ln === "", "a deleted line has no working-tree number");
ok(rows[3].ln === "32" && rows[4].ln === "33" && rows[5].ln === "34", "added lines count on from the context, not past the deletion");
ok(rows[6].ln === "35", "context after the hunk's changes keeps counting");

const sneaky = parseDiff("@@ -1,2 +1,2 @@\n--- a SQL comment\n+++ a counter\n");
ok(sneaky[1].kind === "del" && sneaky[2].kind === "add", "inside a hunk, ---/+++ lines are content, not headers");

const two = parseDiff("@@ -1 +1 @@\n-a\n+b\ndiff --git a/t b/t\n--- a/t\n+++ b/t\n@@ -9 +9 @@\n-c\n+d\n");
ok(two.filter((r) => r.kind === "hunk").length === 2 && two[two.length - 1].ln === "9", "a second file's headers are skipped and its numbering restarts");

ok(parseDiff("Binary files /dev/null and b/x.png differ\n").length === 0, "a binary diff has no rows");

console.log("\nall diff checks passed");
````

- [ ] **Step 2: Run it to see it fail**

Run: `node bridge/dashboard/web/src/lib/diff.check.ts`
Expected: `Error: FAIL: headers, the newline marker and the trailing newline are not rows`. Today's `parseDiff` turns the trailing newline into a numbered row.

- [ ] **Step 3: Replace `lib/diff.ts`**

Create `bridge/dashboard/web/src/lib/diff.ts`:

````ts
export interface DiffRow {
  ln: string;
  mark: string;
  text: string;
  kind: "add" | "del" | "ctx" | "hunk";
}

/** Parse a unified diff into display rows. `ln` is the working tree's line
 *  number. Hunk headers reset it, and a deleted line gets none: it isn't in
 *  the file any more, so a review note can't cite it. Everything outside a
 *  hunk (diff/index/---/+++ headers, "Binary files differ") and git's
 *  "\ No newline at end of file" marker is dropped. */
export function parseDiff(text: string): DiffRow[] {
  const rows: DiffRow[] = [];
  let newLn = 0;
  let inHunk = false;
  for (const line of text.replace(/\n$/, "").split("\n")) {
    if (line.startsWith("@@")) {
      const m = /\+(\d+)/.exec(line);
      newLn = m ? parseInt(m[1], 10) : 0;
      inHunk = true;
      rows.push({ ln: "", mark: "@@", text: line, kind: "hunk" });
    } else if (line.startsWith("diff ")) {
      inHunk = false;            // the next file's headers
    } else if (!inHunk || line.startsWith("\\")) {
      continue;
    } else if (line.startsWith("+")) {
      rows.push({ ln: String(newLn++), mark: "+", text: line.slice(1), kind: "add" });
    } else if (line.startsWith("-")) {
      rows.push({ ln: "", mark: "-", text: line.slice(1), kind: "del" });
    } else {
      rows.push({
        ln: String(newLn++),
        mark: "",
        text: line.startsWith(" ") ? line.slice(1) : line,
        kind: "ctx",
      });
    }
  }
  return rows;
}
````

- [ ] **Step 4: Run the check**

Run: `node bridge/dashboard/web/src/lib/diff.check.ts`
Expected: nine `ok -` lines, then `all diff checks passed`.

- [ ] **Step 5: Point ChangesTab at it**

In `bridge/dashboard/web/src/components/hud/AnalyzeModal.tsx`, find (around line 19):

````tsx
import { useAiFeatures } from "../../lib/ai";
````

Replace it with:

````tsx
import { useAiFeatures } from "../../lib/ai";
import { parseDiff, type DiffRow } from "../../lib/diff";
````

In `bridge/dashboard/web/src/components/hud/AnalyzeModal.tsx`, find (around line 370):

````tsx
interface DiffLine {
  ln: string;
  mark: string;
  kind: "add" | "del" | "ctx" | "hunk";
  text: string;
}

const DIFF_VIEW: Record<DiffLine["kind"], { bg: string; sign: string; color: string }> = {
````

Replace it with:

````tsx
const DIFF_VIEW: Record<DiffRow["kind"], { bg: string; sign: string; color: string }> = {
````

Then delete `parseDiffRows`:

In `bridge/dashboard/web/src/components/hud/AnalyzeModal.tsx`, find (around line 377):

````tsx
/* Unified diff → numbered design rows (sequential numbers from each hunk's
   new-file start, matching the mock's numbering). */
function parseDiffRows(diff: string): DiffLine[] {
  const out: DiffLine[] = [];
  let n = 0;
  let inHunk = false;
  for (const ln of diff.split("\n")) {
    if (ln.startsWith("@@")) {
      const m = /\+(\d+)/.exec(ln);
      if (m) n = parseInt(m[1], 10);
      inHunk = true;
      out.push({ ln: "", mark: "@@", kind: "hunk", text: ` ${ln}` });
      continue;
    }
    if (!inHunk) continue;
    if (ln.startsWith("+")) out.push({ ln: String(n++), mark: "+", kind: "add", text: ln.slice(1) });
    else if (ln.startsWith("-")) out.push({ ln: String(n++), mark: "-", kind: "del", text: ln.slice(1) });
    else out.push({ ln: String(n++), mark: "", kind: "ctx", text: ln.startsWith(" ") ? ln.slice(1) : ln });
  }
  return out;
}

function ChangesTab(
````

Replace it with:

````tsx
function ChangesTab(
````

In `bridge/dashboard/web/src/components/hud/AnalyzeModal.tsx`, find (around line 437):

````tsx
  const rows = useMemo(() => parseDiffRows(diff), [diff]);
````

Replace it with:

````tsx
  const rows = useMemo(() => parseDiff(diff), [diff]);
````

Hunk header rows now render `@@ -31,9 +31,41 @@ …` without the old leading space. That is cosmetic and intended.

- [ ] **Step 6: Typecheck**

Run: `cd bridge/dashboard/web && node_modules/.bin/tsc -p tsconfig.app.json; cd -`
Expected: only the known `remark-breaks` error.

- [ ] **Step 7: Commit**

```bash
git add bridge/dashboard/web/src/lib/diff.ts bridge/dashboard/web/src/lib/diff.check.ts bridge/dashboard/web/src/components/hud/AnalyzeModal.tsx
git commit -m "dashboard(git): number diff rows by the working tree, not the mock

parseDiffRows counted deleted lines, so every number after a deletion was
off. ChangesTab now uses lib/diff.ts's parseDiff, which also stops a
trailing newline from becoming a row and reads ---/+++ inside a hunk as
content. Review notes cite these numbers."
```

---

### Task 2: The review notes model

**Files:**
- Create: `bridge/dashboard/web/src/lib/reviewnotes.ts`
- Create: `bridge/dashboard/web/src/lib/reviewnotes.check.ts`

**Interfaces:**
- Consumes: `DiffRow` (Task 1).
- Produces, all from `lib/reviewnotes.ts`:
  - `interface Note { id: string; path: string; start: number; end: number; code: string; text: string; at: number; lost?: boolean }`
  - `type NoteDraft = Omit<Note, "id" | "at" | "lost"> & { id?: string }`
  - `type SendTo = (text: string, to: { session: string } | { cwd: string }) => Promise<boolean>`
  - `notesKey(project: string, branch: string): string`
  - `loadNotes(key: string): Note[]`
  - `saveNotes(key: string, notes: Note[]): void` (an empty list removes the key)
  - `countByPath(notes: Note[]): Record<string, number>`
  - `noteRange(rows: DiffRow[], a: number, b: number): { start: number; end: number; code: string } | null`
  - `lineLabel(start: number, end: number): string` (`L45` or `L36–37`)
  - `reanchor(n: Note, lines: string[] | null): Note`
  - `notesMessage(branch: string, notes: Note[]): string`

- [ ] **Step 1: Write the failing check**

The CRLF lines pin Review Focus 2.

Create `bridge/dashboard/web/src/lib/reviewnotes.check.ts`:

````ts
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
````

- [ ] **Step 2: Run it to see it fail**

Run: `node bridge/dashboard/web/src/lib/reviewnotes.check.ts`
Expected: `Error [ERR_MODULE_NOT_FOUND]: Cannot find module '…/lib/reviewnotes.ts'`.

- [ ] **Step 3: Write the model**

Create `bridge/dashboard/web/src/lib/reviewnotes.ts`:

````ts
import type { DiffRow } from "./diff";

/** Review notes on the GIT tab's diff (review loop A,
 *  docs/superpowers/specs/review-loop.md). Each worktree and branch keeps its
 *  own drafts in this browser's localStorage until SEND or CLEAR. SEND hands
 *  them to the branch's session as one message.
 *
 *  ponytail: no server table, so the Mini App never sees these. Give them one
 *  if it ever needs to. */

export interface Note {
  id: string;
  path: string;     // repo-relative, the way git status names it
  start: number;    // working-tree line numbers, inclusive
  end: number;
  code: string;     // line `start`'s text when the note was left: how SEND finds it again
  text: string;
  at: number;       // ms epoch
  lost?: boolean;   // set at SEND only: that line isn't in the file any more
}

/** A note being written, or edited when `id` is set. */
export type NoteDraft = Omit<Note, "id" | "at" | "lost"> & { id?: string };

/** Where SEND goes: a session by id, or a new session started in this tree.
 *  Resolves true once the message ran or was queued. Only then are the notes
 *  dropped. */
export type SendTo = (text: string, to: { session: string } | { cwd: string }) => Promise<boolean>;

const STORE = "review-notes:";

export const notesKey = (project: string, branch: string) => `${project}@${branch}`;

export function loadNotes(key: string): Note[] {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(STORE + key) ?? "[]");
    return Array.isArray(v) ? (v as Note[]) : [];
  } catch {
    return [];
  }
}

export function saveNotes(key: string, notes: Note[]): void {
  try {
    if (notes.length) localStorage.setItem(STORE + key, JSON.stringify(notes));
    else localStorage.removeItem(STORE + key);
  } catch { /* storage full or blocked: the notes last as long as the tab */ }
}

export function countByPath(notes: Note[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const n of notes) out[n.path] = (out[n.path] ?? 0) + 1;
  return out;
}

/** The lines a drag from row `a` to row `b` covers. Only rows in the working
 *  tree count: a deleted line or a hunk header has no number to cite. */
export function noteRange(rows: DiffRow[], a: number, b: number): { start: number; end: number; code: string } | null {
  const picked = rows.slice(Math.min(a, b), Math.max(a, b) + 1).filter((r) => r.ln !== "");
  if (!picked.length) return null;
  return { start: Number(picked[0].ln), end: Number(picked[picked.length - 1].ln), code: picked[0].text };
}

/** "L45", or "L36–37" for a range (sheet A's thread header). */
export const lineLabel = (start: number, end: number) => (start === end ? `L${start}` : `L${start}–${end}`);

/** The note's lines in the file as it is now. The agent may have moved them
 *  since the note was left: the nearest line with the same text wins, and the
 *  range keeps its length. If the line is gone, the note is marked `lost`.
 *  `lines` is null when the file can't be read (deleted, binary). */
export function reanchor(n: Note, lines: string[] | null): Note {
  if (!lines) return { ...n, lost: true };
  if (lines[n.start - 1] === n.code) return n;
  let best = -1;
  lines.forEach((l, i) => {
    if (l === n.code && (best < 0 || Math.abs(i + 1 - n.start) < Math.abs(best + 1 - n.start))) best = i;
  });
  if (best < 0) return { ...n, lost: true };
  const d = best + 1 - n.start;
  return { ...n, start: n.start + d, end: n.end + d };
}

/** The one message the session gets (sheet A): a header, then each note's
 *  place and its words, in file then line order. */
export function notesMessage(branch: string, notes: Note[]): string {
  const sorted = [...notes].sort((x, y) => x.path.localeCompare(y.path) || x.start - y.start);
  const out = [`Review notes on ⎇ ${branch} (${notes.length}):`];
  for (const n of sorted) {
    const at = n.start === n.end ? `${n.start}` : `${n.start}-${n.end}`;
    out.push(`${n.path}:${at}${n.lost ? " (that line has changed since)" : ""}`);
    for (const l of n.text.trim().split("\n")) out.push(`  ${l}`);
  }
  return out.join("\n");
}
````

- [ ] **Step 4: Run the check**

Run: `node bridge/dashboard/web/src/lib/reviewnotes.check.ts`
Expected: seventeen `ok -` lines, then `all reviewnotes checks passed`.

- [ ] **Step 5: Typecheck**

Run: `cd bridge/dashboard/web && node_modules/.bin/tsc -p tsconfig.app.json; cd -`
Expected: only the known `remark-breaks` error.

- [ ] **Step 6: Commit**

```bash
git add bridge/dashboard/web/src/lib/reviewnotes.ts bridge/dashboard/web/src/lib/reviewnotes.check.ts
git commit -m "dashboard(git): review notes model — storage, re-anchoring, the message

Drafts for each project and branch in localStorage. SEND finds each note's
line again in the file as it is now. The message is the approved sheet A
format."
```

---

### Task 3: Notes on the diff: gutter, drag, editor, threads, ◆N

**Files:**
- Create: `bridge/dashboard/web/src/components/hud/DiffNotes.tsx` (`NoteEditor`, `NoteThread`)
- Modify: `bridge/dashboard/web/src/index.css:418-420` (after `.trow:hover`)
- Modify: `bridge/dashboard/web/src/components/hud/AnalyzeModal.tsx` (imports, ChangesTab state, file rows, diff rows)

What it does: hovering a numbered diff line shows an accent `+` in a new 18px gutter. Clicking the `+` or the line number, or dragging down the numbers, opens an editor under the range's last line. ⌘↵ or Ctrl+↵ adds the note, and Esc cancels it. A saved note keeps a purple `◆` on its lines and renders as a thread with EDIT and ✕. Each file row shows `◆N`. A note whose line has left the diff still renders, at the foot of the diff, so it can be seen and deleted.

The hover is CSS, not React state. A diff can be thousands of rows, and `.trow:hover` in `index.css` already uses CSS for that reason.

**Interfaces:**
- Consumes: Task 1 (`parseDiff`) and Task 2 (`Note`, `NoteDraft`, `loadNotes`, `saveNotes`, `notesKey`, `countByPath`, `noteRange`, `lineLabel`).
- Produces:
  - `NoteEditor({ start, end, initial, isNew, onSave(text), onCancel() })`
  - `NoteThread({ note, onEdit?, onDelete })`
  - In `ChangesTab`, for Task 4: `notes`, `setNotes(next: Note[])`, `setNotesState`, `nkey`, `editor`/`setEditor`, `drag`/`setDrag`, `fileNotes`, `noteCount`, `saveNote(text)`.

- [ ] **Step 1: Create the editor and thread components**

Create `bridge/dashboard/web/src/components/hud/DiffNotes.tsx`:

````tsx
import { useState } from "react";
import { lineLabel, type Note } from "../../lib/reviewnotes";
import { ago } from "../../lib/surfaces";

/* Review notes on the GIT tab's diff (review loop A, sheet A): the inline
   editor, a saved note's thread, and the send bar at the panel's foot.
   ChangesTab (AnalyzeModal.tsx) owns the notes and decides where each one
   renders. These pieces only draw and report. Plain text, no markdown:
   ponytail, since a note is a line or two typed at a diff. */

/** Under the gutter, the line-number column and the +/− mark (18 + 36 + 14),
 *  so a thread lines up with the code it is about. */
const INDENT = 68;

const btn = (on: boolean, tone = "var(--acc)") => ({
  appearance: "none" as const, cursor: "pointer", fontFamily: "inherit", fontSize: "var(--t9)",
  letterSpacing: 1.4, padding: "5px 10px", flex: "none" as const,
  border: `1px solid ${tone === "ghost" ? "color-mix(in srgb, var(--acc) 22%, transparent)" : tone}`,
  background: tone === "ghost" ? (on ? "color-mix(in srgb, var(--acc) 6%, transparent)" : "transparent")
    : `color-mix(in srgb, ${tone} ${on ? 22 : 12}%, transparent)`,
  color: tone === "ghost" ? "var(--txm)" : "var(--txb)",
});

export function NoteEditor({ start, end, initial, isNew, onSave, onCancel }: {
  start: number; end: number; initial: string; isNew: boolean;
  onSave: (text: string) => void; onCancel: () => void;
}) {
  const [text, setText] = useState(initial);
  const [hov, setHov] = useState("");
  const hp = (k: string) => ({ onMouseEnter: () => setHov(k), onMouseLeave: () => setHov("") });
  return (
    <div style={{ margin: `3px 12px 6px ${INDENT}px`, border: "1px solid var(--acc)", background: "color-mix(in srgb, var(--panel) 92%, transparent)", boxShadow: "0 0 0 3px color-mix(in srgb, var(--acc) 12%, transparent)" }}>
      <div style={{ fontSize: "var(--t85)", letterSpacing: 1.2, color: "var(--acc)", padding: "6px 9px 0" }}>
        ◆ {lineLabel(start, end)} · {isNew ? "NEW NOTE" : "EDIT NOTE"}
      </div>
      <textarea autoFocus value={text} rows={2} placeholder="what should change here?"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          // Esc must stop here: App's window handler would close the whole modal.
          if (e.key === "Escape") { e.stopPropagation(); onCancel(); }
          else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); onSave(text); }
        }}
        style={{ display: "block", width: "100%", boxSizing: "border-box", resize: "vertical", minHeight: 40, background: "transparent", border: 0, outline: "none", color: "var(--txb)", fontFamily: "inherit", fontSize: "var(--t105)", lineHeight: 1.5, padding: "5px 9px 8px" }} />
      <div style={{ display: "flex", alignItems: "center", gap: 7, padding: "6px 9px", borderTop: "1px solid color-mix(in srgb, var(--acc) 12%, transparent)" }}>
        <span style={{ fontSize: "var(--t85)", letterSpacing: 1, color: "var(--txl)", marginRight: "auto" }}>⌘↵ {isNew ? "ADD" : "SAVE"} · ESC CANCEL</span>
        <button onClick={onCancel} {...hp("cancel")} style={btn(hov === "cancel", "ghost")}>CANCEL</button>
        <button onClick={() => onSave(text)} disabled={!text.trim()} {...hp("add")}
          style={{ ...btn(hov === "add"), opacity: text.trim() ? 1 : 0.45, cursor: text.trim() ? "pointer" : "not-allowed" }}>
          {isNew ? "ADD NOTE" : "SAVE NOTE"}
        </button>
      </div>
    </div>
  );
}

export function NoteThread({ note, onEdit, onDelete }: {
  note: Note;
  /** Absent for a note whose line has left the diff: there's no row to edit it under. */
  onEdit?: () => void;
  onDelete: () => void;
}) {
  const [hov, setHov] = useState("");
  const hp = (k: string) => ({ onMouseEnter: () => setHov(k), onMouseLeave: () => setHov("") });
  const link = (k: string) => ({
    appearance: "none" as const, cursor: "pointer", border: 0, background: "transparent", padding: 0,
    fontFamily: "inherit", fontSize: "inherit", letterSpacing: "inherit",
    color: hov === k ? (k === "del" ? "var(--err)" : "var(--txb)") : "var(--txl)",
  });
  return (
    <div style={{ margin: `3px 12px 5px ${INDENT}px`, border: "1px solid color-mix(in srgb, var(--purple) 38%, transparent)", borderLeft: "2px solid var(--purple)", background: "color-mix(in srgb, var(--purple) 7%, transparent)", padding: "7px 9px", fontSize: "var(--t105)", lineHeight: 1.5 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 7, fontSize: "var(--t85)", letterSpacing: 1.2, color: "var(--purple-h)", marginBottom: 3 }}>
        <span>◆ {lineLabel(note.start, note.end)} · YOU · {ago(note.at / 1000) || "now"}</span>
        <span style={{ flex: 1 }} />
        {onEdit && <>
          <button onClick={onEdit} {...hp("edit")} style={link("edit")}>EDIT</button>
          <span style={{ color: "var(--txl)" }}>·</span>
        </>}
        <button onClick={onDelete} title="delete this note" {...hp("del")} style={link("del")}>✕</button>
      </div>
      <div style={{ color: "var(--txh)", whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{note.text}</div>
    </div>
  );
}
````

- [ ] **Step 2: Add the gutter's hover rule**

In `bridge/dashboard/web/src/index.css`, find (around line 418):

````css
.trow:hover {
  background: color-mix(in srgb, var(--acc) 6%, transparent);
}
````

Replace it with:

````css
.trow:hover {
  background: color-mix(in srgb, var(--acc) 6%, transparent);
}
/* GIT tab review notes: the gutter's + shows on the hovered diff line only.
   CSS, not React state, for the reason .trow gives: a diff can be thousands of
   rows. */
.dnote-row .dnote-plus { opacity: 0; }
.dnote-row:hover .dnote-plus { opacity: 1; }
````

- [ ] **Step 3: Wire ChangesTab: imports**

In `bridge/dashboard/web/src/components/hud/AnalyzeModal.tsx`, find (around line 1):

````tsx
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
````

Replace it with:

````tsx
import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
````

In `bridge/dashboard/web/src/components/hud/AnalyzeModal.tsx`, find (around line 22):

````tsx
import { useStickyFlag } from "../../lib/prefs";
````

Replace it with:

````tsx
import { useStickyFlag } from "../../lib/prefs";
import {
  countByPath, loadNotes, noteRange, notesKey, saveNotes, type Note, type NoteDraft,
} from "../../lib/reviewnotes";
````

In `bridge/dashboard/web/src/components/hud/AnalyzeModal.tsx`, find (around line 27):

````tsx
import { CommitGraph } from "../CommitGraph";
````

Replace it with:

````tsx
import { CommitGraph } from "../CommitGraph";
import { NoteEditor, NoteThread } from "./DiffNotes";
````

- [ ] **Step 4: Wire ChangesTab: notes state, drag and save**

In `bridge/dashboard/web/src/components/hud/AnalyzeModal.tsx`, find (around line 441):

````tsx
  const rows = useMemo(() => parseDiff(diff), [diff]);
  const selFile = files.find((f) => f.path === selName);
````

Replace it with:

````tsx
  const rows = useMemo(() => parseDiff(diff), [diff]);
  const selFile = files.find((f) => f.path === selName);

  // Review notes (lib/reviewnotes.ts): drafts on this branch's diff, kept in
  // localStorage until SEND or CLEAR.
  const nkey = notesKey(project, branch);
  const [notes, setNotesState] = useState<Note[]>(() => loadNotes(nkey));
  const [editor, setEditor] = useState<NoteDraft | null>(null);
  const [drag, setDrag] = useState<{ a: number; b: number } | null>(null);
  const setNotes = (next: Note[]) => { setNotesState(next); saveNotes(nkey, next); };
  useEffect(() => { setNotesState(loadNotes(nkey)); }, [nkey]);
  useEffect(() => { setEditor(null); }, [nkey, selName]);
  const fileNotes = notes.filter((x) => x.path === selName);
  const noteCount = useMemo(() => countByPath(notes), [notes]);

  // A drag down the line numbers ends where the mouse is let go. That is
  // caught on the window, so letting go outside the diff still opens the editor.
  useEffect(() => {
    if (!drag) return;
    const up = () => {
      const r = noteRange(rows, drag.a, drag.b);
      setDrag(null);
      if (r && selName) setEditor({ path: selName, ...r, text: "" });
    };
    window.addEventListener("mouseup", up);
    return () => window.removeEventListener("mouseup", up);
  }, [drag, rows, selName]);

  function saveNote(text: string) {
    if (!editor || !text.trim()) return;
    const kept = notes.filter((x) => x.id !== editor.id);
    setNotes([...kept, { ...editor, id: editor.id ?? crypto.randomUUID(), text: text.trim(), at: Date.now() }]);
    setEditor(null);
  }
````

- [ ] **Step 5: Show `◆N` on file rows**

In `bridge/dashboard/web/src/components/hud/AnalyzeModal.tsx`, find (around line 582):

````tsx
                    <span style={{ fontSize: "var(--t10)", flex: "none", display: "flex", gap: 5 }}><span style={{ color: "var(--ok)" }}>+{f.add}</span><span style={{ color: "var(--err)" }}>−{f.del}</span></span>
````

Replace it with:

````tsx
                    {noteCount[f.path] > 0 && <span title={`${noteCount[f.path]} review note${noteCount[f.path] === 1 ? "" : "s"}`} style={{ fontSize: "var(--t9)", letterSpacing: ".5px", color: "var(--purple)", flex: "none" }}>◆{noteCount[f.path]}</span>}
                    <span style={{ fontSize: "var(--t10)", flex: "none", display: "flex", gap: 5 }}><span style={{ color: "var(--ok)" }}>+{f.add}</span><span style={{ color: "var(--err)" }}>−{f.del}</span></span>
````

- [ ] **Step 6: Draw the gutter, the threads and the editor in the diff rows**

The editor's Esc handler calls `e.stopPropagation()`. App's window-level Escape handler would otherwise close the whole modal (Review Focus 5).

In `bridge/dashboard/web/src/components/hud/AnalyzeModal.tsx`, find (around line 624):

````tsx
              {rows.map((d, i) => {
                const v = DIFF_VIEW[d.kind];
                return (
                  <div key={i} style={{ display: "flex", background: v.bg }}>
                    <span style={{ width: 36, flex: "none", textAlign: "right", paddingRight: 9, color: "var(--txg)", userSelect: "none", borderRight: "1px solid color-mix(in srgb, var(--acc) 8%, transparent)" }}>{d.ln}</span>
                    <span style={{ width: 14, flex: "none", textAlign: "center", color: v.sign }}>{d.mark}</span>
                    <span style={{ color: v.color, whiteSpace: "pre", flex: 1 }}>{d.text || " "}</span>
                  </div>
                );
              })}
            </div>
````

Replace it with:

````tsx
              {rows.map((d, i) => {
                const v = DIFF_VIEW[d.kind];
                const ln = d.ln ? Number(d.ln) : 0;   // 0: a deleted line or a hunk header takes no note
                const noted = ln > 0 && fileNotes.some((x) => ln >= x.start && ln <= x.end);
                const dragged = !!drag && ln > 0 && i >= Math.min(drag.a, drag.b) && i <= Math.max(drag.a, drag.b);
                const grab = ln > 0 ? (e: { button: number; preventDefault: () => void }) => {
                  if (e.button !== 0) return;
                  e.preventDefault();               // no text selection while dragging a range
                  setDrag({ a: i, b: i });
                } : undefined;
                return (
                  <Fragment key={i}>
                    <div className="dnote-row" onMouseEnter={drag && ln > 0 ? () => setDrag({ ...drag, b: i }) : undefined}
                      style={{ display: "flex", background: v.bg, boxShadow: dragged ? "inset 0 0 0 1px color-mix(in srgb, var(--acc) 45%, transparent)" : undefined }}>
                      {/* The note gutter: ◆ on a noted line, + on the hovered one (index.css .dnote-plus). */}
                      <span onMouseDown={grab} style={{ width: 18, flex: "none", display: "flex", alignItems: "center", justifyContent: "center", userSelect: "none", cursor: grab ? "pointer" : undefined }}>
                        {noted ? <span style={{ color: "var(--purple)", fontSize: "var(--t9)" }}>◆</span>
                          : grab ? <span className="dnote-plus" title="note this line, or drag down the numbers for a range"
                              style={{ width: 14, height: 14, display: "flex", alignItems: "center", justifyContent: "center", background: "var(--acc)", color: "var(--acc-on)", fontWeight: 700, lineHeight: 1 }}>+</span>
                          : null}
                      </span>
                      <span onMouseDown={grab} style={{ width: 36, flex: "none", textAlign: "right", paddingRight: 9, color: noted ? "var(--purple-h)" : "var(--txg)", userSelect: "none", borderRight: "1px solid color-mix(in srgb, var(--acc) 8%, transparent)", cursor: grab ? "pointer" : undefined }}>{d.ln}</span>
                      <span style={{ width: 14, flex: "none", textAlign: "center", color: v.sign }}>{d.mark}</span>
                      <span style={{ color: v.color, whiteSpace: "pre", flex: 1 }}>{d.text || " "}</span>
                    </div>
                    {ln > 0 && fileNotes.filter((x) => x.end === ln && x.id !== editor?.id).map((x) => (
                      <NoteThread key={x.id} note={x} onEdit={() => setEditor({ ...x })}
                        onDelete={() => setNotes(notes.filter((y) => y.id !== x.id))} />
                    ))}
                    {ln > 0 && editor && editor.path === selName && editor.end === ln && (
                      <NoteEditor start={editor.start} end={editor.end} initial={editor.text} isNew={!editor.id}
                        onCancel={() => setEditor(null)} onSave={saveNote} />
                    )}
                  </Fragment>
                );
              })}
              {/* A note whose line has left the diff (the code changed since) still
                  goes on SEND, so it stays here where it can be seen and deleted. */}
              {fileNotes.filter((x) => !rows.some((r) => r.ln === String(x.end))).map((x) => (
                <NoteThread key={x.id} note={x} onDelete={() => setNotes(notes.filter((y) => y.id !== x.id))} />
              ))}
            </div>
````

- [ ] **Step 7: Typecheck**

Run: `cd bridge/dashboard/web && node_modules/.bin/tsc -p tsconfig.app.json; cd -`
Expected: only the known `remark-breaks` error.

- [ ] **Step 8: Commit**

The visual check and the Esc check (Review Focus 5) happen in Task 10 Step 7, on one scratch server shared by every UI task.

```bash
git add bridge/dashboard/web/src/components/hud/DiffNotes.tsx bridge/dashboard/web/src/index.css bridge/dashboard/web/src/components/hud/AnalyzeModal.tsx
git commit -m "dashboard(git): leave review notes on diff lines

Gutter + on hover, drag the numbers for a range, an inline editor (⌘↵ adds,
Esc cancels without closing the modal), purple threads with EDIT · ✕, and a
◆N count on file rows. Drafts only: nothing is sent yet."
```

---

### Task 4: SEND TO AGENT: the send bar, the target session, a queue-aware send

**Files:**
- Modify: `bridge/dashboard/web/src/components/hud/DiffNotes.tsx` (imports; add `SendBar`)
- Modify: `bridge/dashboard/web/src/components/hud/AnalyzeModal.tsx` (imports, `Props`, the ChangesTab mount and signature, state, send and clear, the bar)
- Modify: `bridge/dashboard/web/src/App.tsx:1058-1150` (`send`), `:1286-1302` (`startIn`), `:2189` (the AnalyzeModal mount)

How sending works. The target is the open session if it is on this branch, otherwise the branch's newest session. ▾ lists the branch's other sessions and "new session here". SEND re-reads the noted files and builds one message, then hands it to App:

- For a session, App opens it and calls `send(text, [], { sessionId, project, force: true })`. That is the existing path: `/local/run`, and if the session is mid-turn the bridge answers 409 `busy` and `send()` queues the message with `useSessionQueue.enqueue`. `force` skips the relevance hold, because review notes are this branch's work.
- For "new session here", App calls `startIn(project, text, { cwd, force: true })`, with `cwd` set to the branch's worktree path.

`send()` and `startIn()` now resolve true or false. Every current caller uses `void send(…)` or ignores the result, so nothing else changes.

**Interfaces:**
- Consumes: Task 2 (`SendTo`, `notesMessage`, `reanchor`, `loadNotes`) and Task 3 (ChangesTab notes state).
- Produces: the `AnalyzeModal` prop `onSendTo: SendTo`; `SendBar({ count, targets, target, tint, busy, onPick, onClear, onSend })`; `send(...): Promise<boolean>`; `startIn(...): Promise<boolean>`.

- [ ] **Step 1: Add the send bar to DiffNotes.tsx**

In `bridge/dashboard/web/src/components/hud/DiffNotes.tsx`, find (around line 1):

````tsx
import { useState } from "react";
import { lineLabel, type Note } from "../../lib/reviewnotes";
import { ago } from "../../lib/surfaces";
````

Replace it with:

````tsx
import { useState } from "react";
import type { SessionBrief } from "../../api";
import { lineLabel, type Note } from "../../lib/reviewnotes";
import { hairline } from "../../lib/shell";
import { ago } from "../../lib/surfaces";
````

Append to the end of `DiffNotes.tsx`:

Append to the end of `bridge/dashboard/web/src/components/hud/DiffNotes.tsx`:

````tsx
/** The diff panel's foot once a note exists: count · target session ▾ · CLEAR · SEND. */
export function SendBar({ count, targets, target, tint, busy, onPick, onClear, onSend }: {
  count: number;
  /** The sessions on this branch, newest first. */
  targets: SessionBrief[];
  /** Where SEND goes. null means "new session here". */
  target: SessionBrief | null;
  tint: string;
  busy: boolean;
  onPick: (id: string) => void;   // a session id, or "new"
  onClear: () => void;
  onSend: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [hov, setHov] = useState("");
  const hp = (k: string) => ({ onMouseEnter: () => setHov(k), onMouseLeave: () => setHov("") });
  const pick = (id: string) => { onPick(id); setOpen(false); };
  const row = (k: string) => ({
    width: "100%", appearance: "none" as const, cursor: "pointer", display: "flex", alignItems: "center", gap: 7,
    border: 0, background: hov === k ? "color-mix(in srgb, var(--purple) 10%, transparent)" : "transparent",
    color: "var(--txh)", fontFamily: "inherit", fontSize: "var(--t10)", padding: "7px 9px", textAlign: "left" as const,
  });
  return (
    <div style={{ position: "relative", flex: "none", display: "flex", alignItems: "center", gap: 9, padding: "8px 10px", borderTop: "1px solid color-mix(in srgb, var(--purple) 40%, transparent)", background: "color-mix(in srgb, var(--purple) 7%, transparent)" }}>
      <span style={{ fontSize: "var(--t95)", letterSpacing: 1.2, color: "var(--purple-h)", flex: "none" }}>◆ {count} NOTE{count === 1 ? "" : "S"}</span>
      <span style={hairline(11)} />
      <button onClick={() => setOpen((o) => !o)} title="which session gets the notes" {...hp("to")}
        style={{ appearance: "none", cursor: "pointer", border: 0, background: "transparent", padding: 0, display: "flex", alignItems: "center", gap: 6, minWidth: 0, flex: 1, fontFamily: "inherit", fontSize: "var(--t10)", color: hov === "to" || open ? "var(--txb)" : "var(--txm)" }}>
        →
        <span style={{ width: 5, height: 5, borderRadius: "50%", background: tint, flex: "none" }} />
        <span style={{ color: "var(--txh)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
          {target ? target.title || "untitled session" : "new session here"}
        </span>
        <span style={{ color: "var(--txl)", flex: "none" }}>▾</span>
      </button>
      <button onClick={onClear} {...hp("clear")} style={btn(hov === "clear", "ghost")}>CLEAR</button>
      <button onClick={onSend} disabled={busy} {...hp("send")}
        style={{ ...btn(hov === "send", "var(--purple)"), opacity: busy ? 0.6 : 1, cursor: busy ? "wait" : "pointer" }}>
        {busy ? "SENDING…" : "SEND TO AGENT ▸"}
      </button>
      {open && (
        <div style={{ position: "absolute", bottom: "calc(100% + 5px)", left: 10, zIndex: 30, minWidth: 260, maxWidth: "80%", border: "1px solid color-mix(in srgb, var(--purple) 40%, transparent)", background: "color-mix(in srgb, var(--panel2) 99%, transparent)", boxShadow: "0 12px 32px var(--shadow-pop)", padding: 5, animation: "mslide .16s ease both" }}>
          <div style={{ fontSize: "var(--t8)", letterSpacing: 1.5, color: "var(--txl)", padding: "5px 9px 7px" }}>SEND TO</div>
          {targets.map((s) => (
            <button key={s.id} onClick={() => pick(s.id)} {...hp(`t:${s.id}`)} style={row(`t:${s.id}`)}>
              <span style={{ flex: 1, minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{s.title || "untitled session"}</span>
              {s.id === target?.id && <span style={{ color: "var(--acc)", flex: "none" }}>✓</span>}
            </button>
          ))}
          <button onClick={() => pick("new")} {...hp("t:new")} style={row("t:new")}>
            <span style={{ flex: 1, color: "var(--purple-h)" }}>+ new session here</span>
            {!target && <span style={{ color: "var(--acc)", flex: "none" }}>✓</span>}
          </button>
        </div>
      )}
    </div>
  );
}
````

- [ ] **Step 2: AnalyzeModal: imports and the new prop**

In `bridge/dashboard/web/src/components/hud/AnalyzeModal.tsx`, find (around line 23):

````tsx
import {
  countByPath, loadNotes, noteRange, notesKey, saveNotes, type Note, type NoteDraft,
} from "../../lib/reviewnotes";
````

Replace it with:

````tsx
import {
  countByPath, loadNotes, noteRange, notesKey, notesMessage, reanchor, saveNotes,
  type Note, type NoteDraft, type SendTo,
} from "../../lib/reviewnotes";
````

In `bridge/dashboard/web/src/components/hud/AnalyzeModal.tsx`, find (around line 28):

````tsx
import { CommitGraph } from "../CommitGraph";
import { NoteEditor, NoteThread } from "./DiffNotes";
````

Replace it with:

````tsx
import { CommitGraph } from "../CommitGraph";
import { askConfirm } from "../ui/Ask";
import { NoteEditor, NoteThread, SendBar } from "./DiffNotes";
````

In `bridge/dashboard/web/src/components/hud/AnalyzeModal.tsx`, find (around line 68):

````tsx
  onWorktreeSession: (rel: string, branch: string, create: boolean, parent?: string,
                      firstPrompt?: string) => void;
}
````

Replace it with:

````tsx
  onWorktreeSession: (rel: string, branch: string, create: boolean, parent?: string,
                      firstPrompt?: string) => void;
  /** GIT tab review notes → a session on the branch, or a new one in its tree. */
  onSendTo: SendTo;
}
````

In `bridge/dashboard/web/src/components/hud/AnalyzeModal.tsx`, find (around line 335):

````tsx
            <ChangesTab project={project} branch={selectedBranch || cur} branchOpts={branchOpts}
              onPickBranch={setSelectedBranch} onRefreshGit={refreshGit} initialFile={props.initialFile} />
````

Replace it with:

````tsx
            <ChangesTab project={project} branch={selectedBranch || cur} branchOpts={branchOpts}
              onPickBranch={setSelectedBranch} onRefreshGit={refreshGit} initialFile={props.initialFile}
              sessions={props.sessions} activeSession={props.activeSession} worktrees={worktrees}
              onSendTo={props.onSendTo} />
````

In `bridge/dashboard/web/src/components/hud/AnalyzeModal.tsx`, find (around line 387):

````tsx
function ChangesTab({ project, branch, branchOpts, onPickBranch, onRefreshGit, initialFile }: {
  project: string; branch: string; branchOpts: BranchOpt[]; onPickBranch: (b: string) => void;
  onRefreshGit: () => void; initialFile?: string;
}) {
````

Replace it with:

````tsx
function ChangesTab({ project, branch, branchOpts, onPickBranch, onRefreshGit, initialFile,
                      sessions, activeSession, worktrees, onSendTo }: {
  project: string; branch: string; branchOpts: BranchOpt[]; onPickBranch: (b: string) => void;
  onRefreshGit: () => void; initialFile?: string;
  sessions: SessionBrief[]; activeSession?: string | null; worktrees: Worktree[]; onSendTo: SendTo;
}) {
````

- [ ] **Step 3: AnalyzeModal: the target session, CLEAR and SEND**

In `bridge/dashboard/web/src/components/hud/AnalyzeModal.tsx`, find (around line 457):

````tsx
  const [drag, setDrag] = useState<{ a: number; b: number } | null>(null);
  const setNotes = (next: Note[]) => { setNotesState(next); saveNotes(nkey, next); };
  useEffect(() => { setNotesState(loadNotes(nkey)); }, [nkey]);
  useEffect(() => { setEditor(null); }, [nkey, selName]);
  const fileNotes = notes.filter((x) => x.path === selName);
  const noteCount = useMemo(() => countByPath(notes), [notes]);
````

Replace it with:

````tsx
  const [drag, setDrag] = useState<{ a: number; b: number } | null>(null);
  const [sendTo, setSendTo] = useState("");   // "" = the branch's own session, "new" = a new one
  const [sending, setSending] = useState(false);
  const setNotes = (next: Note[]) => { setNotesState(next); saveNotes(nkey, next); };
  useEffect(() => { setNotesState(loadNotes(nkey)); setSendTo(""); }, [nkey]);
  useEffect(() => { setEditor(null); }, [nkey, selName]);
  const fileNotes = notes.filter((x) => x.path === selName);
  const noteCount = useMemo(() => countByPath(notes), [notes]);
  // The open session if it's on this branch, else the branch's newest; none = a new one.
  const onBranch = useMemo(() => sessions.filter((s) => s.branch === branch).sort((a, b) => b.updated - a.updated), [sessions, branch]);
  const target = sendTo === "new" ? null
    : onBranch.find((s) => s.id === sendTo) ?? onBranch.find((s) => s.id === activeSession) ?? onBranch[0] ?? null;
````

In `bridge/dashboard/web/src/components/hud/AnalyzeModal.tsx`, find (around line 486):

````tsx
    setNotes([...kept, { ...editor, id: editor.id ?? crypto.randomUUID(), text: text.trim(), at: Date.now() }]);
    setEditor(null);
  }
````

Replace it with:

````tsx
    setNotes([...kept, { ...editor, id: editor.id ?? crypto.randomUUID(), text: text.trim(), at: Date.now() }]);
    setEditor(null);
  }

  async function clearNotes() {
    if (await askConfirm(`Drop ${notes.length} review note${notes.length === 1 ? "" : "s"} on ${branch}?`)) setNotes([]);
  }

  async function sendNotes() {
    // Storage, not this tab's state: another tab may have sent or cleared them.
    const current = loadNotes(nkey);
    if (sending || !current.length) { setNotesState(current); return; }
    setSending(true);
    try {
      // Line numbers are the working tree's at the moment of SEND: each noted
      // file is read again and each note found again by its line's text.
      const paths = [...new Set(current.map((x) => x.path))];
      const files = await Promise.all(paths.map((p) => api.fileRead(project, p, branch || undefined)
        .then((f) => (f.ok && !f.binary && !f.too_large ? (f.content ?? "").split("\n") : null))
        .catch(() => null)));
      const text = notesMessage(branch, current.map((x) => reanchor(x, files[paths.indexOf(x.path)])));
      const cwd = worktrees.find((w) => w.branch === branch)?.path ?? "";
      // Dropped only once the message ran or was queued: a failed send keeps them.
      if (await onSendTo(text, target ? { session: target.id } : { cwd })) setNotes([]);
    } finally { setSending(false); }
  }
````

In `bridge/dashboard/web/src/components/hud/AnalyzeModal.tsx`, find (around line 700):

````tsx
                <NoteThread key={x.id} note={x} onDelete={() => setNotes(notes.filter((y) => y.id !== x.id))} />
              ))}
            </div>
````

Replace it with:

````tsx
                <NoteThread key={x.id} note={x} onDelete={() => setNotes(notes.filter((y) => y.id !== x.id))} />
              ))}
            </div>
            {notes.length > 0 && (
              <SendBar count={notes.length} targets={onBranch} target={target} tint={projectTint(project).color}
                busy={sending} onPick={setSendTo} onClear={() => void clearNotes()} onSend={() => void sendNotes()} />
            )}
````

- [ ] **Step 4: App: `send()` reports whether the prompt went**

In `bridge/dashboard/web/src/App.tsx`, find (around line 1058):

````tsx
  async function send(
    text: string, images: string[],
    opts?: { force?: boolean; sessionId?: string; project?: string },
  ) {
    const sid = opts?.sessionId ?? sessionId;
    if (!sid) return;
````

Replace it with:

````tsx
  // Resolves true once the prompt ran or was queued, false if it didn't go
  // (held as different work, or the request failed). Review notes are dropped
  // only on true.
  async function send(
    text: string, images: string[],
    opts?: { force?: boolean; sessionId?: string; project?: string },
  ): Promise<boolean> {
    const sid = opts?.sessionId ?? sessionId;
    if (!sid) return false;
````

In `bridge/dashboard/web/src/App.tsx`, find (around line 1075):

````tsx
        notify("info", goal ? `Goal set — ${goal.objective}` : "Goal cleared.");
      } catch (e) {
        notify("error", (e as Error).message);
      }
      return;
    }
````

Replace it with:

````tsx
        notify("info", goal ? `Goal set — ${goal.objective}` : "Goal cleared.");
        return true;
      } catch (e) {
        notify("error", (e as Error).message);
        return false;
      }
    }
````

In `bridge/dashboard/web/src/App.tsx`, find (around line 1099):

````tsx
    if (running && !opts?.sessionId) { enqueue(); return; }
````

Replace it with:

````tsx
    if (running && !opts?.sessionId) { enqueue(); return true; }
````

In `bridge/dashboard/web/src/App.tsx`, find (around line 1118):

````tsx
          notify("info", `Held a prompt in “${sessionName()}” — it may be different work.`);
        return;
      }
````

Replace it with:

````tsx
          notify("info", `Held a prompt in “${sessionName()}” — it may be different work.`);
        return false;
      }
````

In `bridge/dashboard/web/src/App.tsx`, find (around line 1128):

````tsx
        notify("info", `Started in “${sessionName()}” — the session you sent it from.`);
        return;
      }
````

Replace it with:

````tsx
        notify("info", `Started in “${sessionName()}” — the session you sent it from.`);
        return true;
      }
````

In `bridge/dashboard/web/src/App.tsx`, find (around line 1146):

````tsx
          started: Date.now() / 1000 },
      ]);
    } catch (e) {
      // Lost the race: the run slot filled between our check and the request.
      // Queue it rather than surfacing a "busy" error.
      if ((e as Error).message === "busy") enqueue();
      else notify("error", (e as Error).message);
    } finally {
````

Replace it with:

````tsx
          started: Date.now() / 1000 },
      ]);
      return true;
    } catch (e) {
      // Lost the race: the run slot filled between our check and the request.
      // Queue it rather than surfacing a "busy" error.
      if ((e as Error).message === "busy") { enqueue(); return true; }
      notify("error", (e as Error).message);
      return false;
    } finally {
````

- [ ] **Step 5: App: `startIn()` passes the answer on**

In `bridge/dashboard/web/src/App.tsx`, find (around line 1294):

````tsx
    opts?: { images?: string[]; title?: string; force?: boolean; cwd?: string },
  ) {
    openBlank();
    try {
      const { session } = await api.createSession(project, opts?.cwd, opts?.title);
      setSessions((prev) => [session, ...prev]);
      openSession(session.id);
      toChat();
      await send(prompt, opts?.images ?? [],
                 { sessionId: session.id, project, force: opts?.force });
    } catch (e) {
      setLoadingSession(false);
      notify("error", (e as Error).message);
    }
  }
````

Replace it with:

````tsx
    opts?: { images?: string[]; title?: string; force?: boolean; cwd?: string },
  ): Promise<boolean> {
    openBlank();
    try {
      const { session } = await api.createSession(project, opts?.cwd, opts?.title);
      setSessions((prev) => [session, ...prev]);
      openSession(session.id);
      toChat();
      return await send(prompt, opts?.images ?? [],
                        { sessionId: session.id, project, force: opts?.force });
    } catch (e) {
      setLoadingSession(false);
      notify("error", (e as Error).message);
      return false;
    }
  }
````

- [ ] **Step 6: App: give AnalyzeModal `onSendTo`**

In `bridge/dashboard/web/src/App.tsx`, find (around line 2196):

````tsx
                onWorktreeSession={(rel, branch, create, parent, firstPrompt) => { void worktreeSession(rel, branch, create, parent, firstPrompt); setAnalyzeProject(null); }}
              />
````

Replace it with:

````tsx
                onWorktreeSession={(rel, branch, create, parent, firstPrompt) => { void worktreeSession(rel, branch, create, parent, firstPrompt); setAnalyzeProject(null); }}
                // GIT tab review notes. The chat goes to where they went, so you
                // see the agent pick them up. A session mid-turn queues them.
                onSendTo={(text, to) => {
                  const project = analyzeProject;
                  setAnalyzeProject(null);
                  if ("cwd" in to) return startIn(project, text, { cwd: to.cwd || undefined, force: true });
                  const s = sessions.find((x) => x.id === to.session);
                  if (s) selectSession(s);
                  toChat();
                  return send(text, [], { sessionId: to.session, project, force: true });
                }}
              />
````

- [ ] **Step 7: Typecheck**

Run: `cd bridge/dashboard/web && node_modules/.bin/tsc -p tsconfig.app.json; cd -`
Expected: only the known `remark-breaks` error. A `Type 'void' is not assignable to type 'boolean'` error means a return in `send()` was missed.

- [ ] **Step 8: Commit**

```bash
git add bridge/dashboard/web/src/components/hud/DiffNotes.tsx bridge/dashboard/web/src/components/hud/AnalyzeModal.tsx bridge/dashboard/web/src/App.tsx
git commit -m "dashboard(git): SEND TO AGENT — review notes to the branch's session

The send bar picks the open session on the branch, another one on it, or
a new session in its tree. Line numbers are re-read at SEND. The message
takes send()'s existing path, so a session mid-turn queues it. send() and
startIn() now report whether the prompt went, and notes clear only then."
```

---

### Task 5: `bridge/prstatus.py`: gh's JSON into the chip's states

**Files:**
- Create: `bridge/prstatus.py` (the docstring, constants, `normalize`, `chip_state`, `failure_tail`, `alerts`, `next_pings`, `ping_text`)
- Create: `tests/test_prstatus.py`

The fixtures are real gh 2.92 output shapes, checked on 2026-10-06:

- A running CheckRun has `"completedAt": "0001-01-01T00:00:00Z"` and `"conclusion": ""`.
- A commit status is `{"__typename": "StatusContext", "context", "state", "targetUrl", "startedAt"}`.
- `--log-failed` lines are `job\tstep\ttimestamp text`. The first one carries a BOM, colour codes arrive as caret text (`^[[31m`), and when gh prints "UNKNOWN STEP" the whole job comes back. Its tail is then post-job cleanup, so the cut at the last `##[error]` line is what finds the failure.

**Interfaces:**
- Produces:
  - `normalize(raw: dict) -> dict`, the PR dict with keys `number, title, url, state, base, head, sha, additions, deletions, created, merged_at, checks, passed, failed, running, total, decision, requested, reviews, review, status`. Each check is `{name, workflow, state: "pass"|"fail"|"run", url, started, completed}`. `review` is `{by, at, body, comments: []}` or None.
  - `chip_state(pr) -> "running"|"failing"|"review"|"changes"|"ready"|"merged"|"closed"`
  - `failure_tail(log: str, n=60) -> str`
  - `alerts(pr) -> set[str]`
  - `next_pings(pinged: set[str], pr) -> tuple[set[str], list[str]]`
  - `ping_text(pr, key) -> str`
  - The constants `TTL=45`, `FORCE_FLOOR=10`, `ERR_TTL=300`, `LOG_LINES=60`, `FIELDS`, and the module-level `_cache`, `_locks`, `_logs` that Task 6 uses.

- [ ] **Step 1: Write the failing tests**

The ERROR-status test pins Review Focus 3.

Create `tests/test_prstatus.py`:

````python
"""bridge/prstatus.py: the PR chip's data. gh is faked at prstatus._gh. The
canned JSON and log lines are in the shapes real gh 2.92 returned on
2026-10-06 (ainurhq/rivendell, cli/cli, python/cpython).
Run: python3 -m pytest tests/test_prstatus.py -q"""

import json

import pytest

from bridge import prstatus, store

RUN = "https://github.com/acme/rivendell/actions/runs/9"


def _run(name, status="COMPLETED", conclusion="SUCCESS", job=1,
         started="2026-10-06T12:01:00Z", workflow="CI"):
    done = status == "COMPLETED"
    return {"__typename": "CheckRun", "name": name, "workflowName": workflow,
            "status": status, "conclusion": conclusion if done else "",
            "startedAt": started,
            "completedAt": "2026-10-06T12:03:14Z" if done else "0001-01-01T00:00:00Z",
            "detailsUrl": f"{RUN}/job/{job}"}


def _raw(**over):
    raw = {"number": 131, "title": "Inbox: group action items by client",
           "url": "https://github.com/acme/rivendell/pull/131", "state": "OPEN",
           "baseRefName": "main", "headRefName": "feat/inbox-grouping",
           "headRefOid": "abc123", "additions": 412, "deletions": 88,
           "createdAt": "2026-10-06T12:00:00Z", "mergedAt": None,
           "statusCheckRollup": [], "reviewDecision": "", "reviewRequests": [],
           "latestReviews": []}
    raw.update(over)
    return raw


# --- normalize / chip_state ---------------------------------------------------

def test_checks_failures_first_skips_dropped_zero_times_blank():
    pr = prstatus.normalize(_raw(statusCheckRollup=[
        _run("lint"),
        _run("e2e", status="IN_PROGRESS"),
        _run("backend", conclusion="FAILURE", job=7),
        _run("label", conclusion="SKIPPED"),
        {"__typename": "StatusContext", "context": "pre-commit.ci - pr",
         "state": "SUCCESS", "targetUrl": "https://pre-commit.ci/x",
         "startedAt": "2026-10-06T12:40:47Z"},
    ]))
    assert [c["name"] for c in pr["checks"]] == ["backend", "e2e", "lint", "pre-commit.ci - pr"]
    assert (pr["failed"], pr["running"], pr["passed"], pr["total"]) == (1, 1, 2, 4)
    assert pr["checks"][1]["completed"] == ""       # Go's zero time is not a finish
    assert pr["checks"][3]["started"] == ""         # a commit status has no duration
    assert pr["status"] == "failing"


def test_a_commit_status_in_error_is_failing_and_pending_is_running():
    status = lambda st: {"__typename": "StatusContext", "context": f"ci/{st}", "state": st,
                         "targetUrl": "", "startedAt": "2026-10-06T12:00:00Z"}
    pr = prstatus.normalize(_raw(statusCheckRollup=[status("ERROR"), status("PENDING")]))
    assert [(c["name"], c["state"]) for c in pr["checks"]] == [("ci/ERROR", "fail"), ("ci/PENDING", "run")]


def test_a_rerun_keeps_only_the_newest_attempt():
    pr = prstatus.normalize(_raw(statusCheckRollup=[
        _run("backend", conclusion="FAILURE", started="2026-10-06T12:01:00Z"),
        _run("backend", started="2026-10-06T12:09:00Z"),
    ]))
    assert [(c["name"], c["state"]) for c in pr["checks"]] == [("backend", "pass")]


@pytest.mark.parametrize("over, want", [
    ({"state": "MERGED"}, "merged"),
    ({"state": "CLOSED"}, "closed"),
    ({"statusCheckRollup": [_run("a", conclusion="TIMED_OUT")]}, "failing"),
    ({"reviewDecision": "CHANGES_REQUESTED",
      "latestReviews": [{"author": {"login": "mahdi"}, "state": "CHANGES_REQUESTED",
                         "submittedAt": "2026-10-06T12:30:00Z", "body": ""}]}, "changes"),
    ({"statusCheckRollup": [_run("a"), _run("b", status="QUEUED")]}, "running"),
    ({"statusCheckRollup": [_run("a")], "reviewDecision": "APPROVED"}, "ready"),
    ({"statusCheckRollup": [_run("a")]}, "ready"),        # no review asked for anywhere
    ({"statusCheckRollup": [_run("a")], "reviewDecision": "REVIEW_REQUIRED"}, "review"),
    ({"statusCheckRollup": [_run("a")],
      "reviewRequests": [{"__typename": "User", "login": "mahdi"}]}, "review"),
])
def test_chip_state_is_sheet_c(over, want):
    assert prstatus.normalize(_raw(**over))["status"] == want


# --- failure_tail -------------------------------------------------------------

LOG = (
    "backend\tUNKNOWN STEP\t\N{BYTE ORDER MARK}2026-10-04T17:58:16.1814983Z ##[group]Runner Image Provisioner\n"
    "backend\tUNKNOWN STEP\t2026-10-04T17:59:15.6636537Z ##[group]Run pnpm test\n"
    "backend\tUNKNOWN STEP\t2026-10-04T18:00:41.0000000Z FAIL portal/portal-auth.service.spec.ts\n"
    "backend\tUNKNOWN STEP\t2026-10-04T18:00:41.1000000Z   ^[[31m● keeps a new secret sealed^[[39m\n"
    "backend\tUNKNOWN STEP\t2026-10-04T18:00:42.9000000Z Tests:       2 failed, 1950 passed\n"
    "backend\tUNKNOWN STEP\t2026-10-04T18:00:42.9483346Z ##[error]Process completed with exit code 1.\n"
    "backend\tUNKNOWN STEP\t2026-10-04T18:00:43.6719116Z Post job cleanup.\n"
    "backend\tUNKNOWN STEP\t2026-10-04T18:00:43.8360923Z Cleaning up orphan processes\n"
)


def test_failure_tail_cuts_cleanup_and_strips_prefixes_and_colour():
    tail = prstatus.failure_tail(LOG)
    assert tail.splitlines()[0] == "##[group]Runner Image Provisioner"   # BOM + stamp gone
    assert "  ● keeps a new secret sealed" in tail.splitlines()
    assert tail.endswith("##[error]Process completed with exit code 1.")
    assert "cleanup" not in tail.lower()
    assert prstatus.failure_tail(LOG, n=2) == (
        "Tests:       2 failed, 1950 passed\n##[error]Process completed with exit code 1.")


def test_failure_tail_without_an_error_marker_keeps_the_end():
    assert prstatus.failure_tail("a\tb\t2026-01-01T00:00:00Z x\ny\n", n=1) == "y"


# --- pings --------------------------------------------------------------------

def _pr(**over):
    pr = {"state": "OPEN", "sha": "s1", "failed": 0, "running": 0, "review": None}
    pr.update(over)
    return pr


def test_red_pings_once_per_commit_and_only_green_clears_it():
    pinged, fresh = prstatus.next_pings(set(), _pr(failed=1))
    assert fresh == ["failing:s1"]
    pinged, fresh = prstatus.next_pings(pinged, _pr(running=1))        # re-run going
    assert fresh == [] and "failing:s1" in pinged
    pinged, fresh = prstatus.next_pings(pinged, _pr(failed=1))         # same commit red again
    assert fresh == []
    pinged, fresh = prstatus.next_pings(pinged, _pr())                 # all green
    assert pinged == set()
    assert prstatus.next_pings(pinged, _pr(failed=1))[1] == ["failing:s1"]
    assert prstatus.next_pings({"failing:s1"}, _pr(sha="s2", failed=1))[1] == ["failing:s2"]


def test_a_review_pings_once_and_a_new_push_doesnt_repeat_it():
    review = {"by": "mahdi", "at": "2026-10-06T12:30:00Z"}
    pinged, fresh = prstatus.next_pings(set(), _pr(review=review))
    assert fresh == ["changes:mahdi:2026-10-06T12:30:00Z"]
    assert prstatus.next_pings(pinged, _pr(sha="s2", review=review))[1] == []
    assert prstatus.next_pings(pinged, _pr())[0] == set()              # decision moved on


def test_merged_and_closed_never_ping():
    assert prstatus.next_pings(set(), _pr(state="MERGED", failed=1)) == (set(), [])


def test_ping_text_names_the_red_checks():
    red = prstatus.normalize(_raw(statusCheckRollup=[_run("backend", conclusion="FAILURE")]))
    assert prstatus.ping_text(red, "failing:abc123").splitlines() == [
        "✕ PR #131 checks failing — backend",
        "Inbox: group action items by client · ⎇ feat/inbox-grouping",
        "https://github.com/acme/rivendell/pull/131"]
````

- [ ] **Step 2: Run them to see them fail**

Run: `python3 -m pytest tests/test_prstatus.py -q`
Expected: `ImportError: cannot import name 'prstatus' from 'bridge'` (1 error during collection).

- [ ] **Step 3: Write the module**

Create `bridge/prstatus.py`:

````python
"""A branch's pull request, the way the dashboard's chat header shows it: the
PR chip and its popover (review loop B/C, docs/superpowers/specs/review-loop.md).

One `gh pr view <branch> --json …` answers nearly everything: state, checks,
review decision. Why it is shaped like this:

- **gh, not the API.** The user's own `gh auth` is the credential. The bridge
  holds no GitHub token, the same as bridge/github.py.
- **Polled, cached, shared.** The dashboard asks every 60s while a session is
  open in a visible tab, on focus, and after a push. Each answer is cached for
  each (repo, branch) for TTL seconds, so two tabs on one session make one gh
  call. `force` (focus, a push) only shortens that to FORCE_FLOOR.
  ponytail: no server-side poller. A PR that no visible tab has open is not
  watched, so its pings wait for the next look. Add a timer here if pings
  must reach Telegram while every dashboard tab is closed.
- **Quiet when it can't know.** gh missing or signed out, no GitHub remote,
  the default branch, no PR, a rate limit, a timeout: each one is `pr: None`,
  and the chip just isn't drawn. Errors back off for ERR_TTL, because a rate
  limit doesn't lift in 45s. A blip after a good read keeps the last good PR
  instead of blinking the chip out.
- **The failure, not the log.** A failing GitHub Actions check carries the
  last LOG_LINES lines of its failed step (`gh run view --job <id>
  --log-failed`). The log is cut at the runner's last `##[error]` line,
  because what follows it is post-job cleanup. Timestamps and colour codes are
  stripped. Each job's log is fetched once, since a finished job's log never
  changes. Other CI (commit statuses, third-party check runs) has no log here,
  only its link.
- **Several PRs on one branch.** `gh pr view <branch>` answers with the
  newest PR whose head is that branch, open or not. It ignores forks'
  same-named branches. Checked 2026-10-06 on a repo with a closed and a merged
  PR on one branch: it returned the merged, newer one.
- **Pings once.** Checks turning red ping Telegram once per head commit. A
  changes-requested review pings once per review, so pushing a fix doesn't
  ping again. Pings are remembered in the settings table, so a bridge restart
  doesn't repeat them. An all-green read clears the failing ping, so a later
  red on the same commit pings again. The dashboard bell mirrors `pinged`.

Not built: merging (it stays on GitHub), PR state on session rows, the Mini App.
"""

import json
import re
import threading
import time

from bridge import browser, config, git, github, store, telegram

TTL = 45           # s: under the dashboard's 60s poll, so each poll reads fresh
FORCE_FLOOR = 10   # s: focus, visibilitychange and a push can all ask at once
ERR_TTL = 300      # s: gh broken or rate-limited, so wait five minutes
LOG_LINES = 60
FIELDS = ("number,title,state,url,baseRefName,headRefName,headRefOid,additions,"
          "deletions,createdAt,mergedAt,statusCheckRollup,reviewDecision,"
          "reviewRequests,latestReviews")

_PASS = {"SUCCESS", "NEUTRAL"}
_SKIP = {"SKIPPED", "STALE"}
_ORDER = {"fail": 0, "run": 1, "pass": 2}
_JOB_RE = re.compile(r"/actions/runs/\d+/job/(\d+)")
# gh starts each log line with "<job>\t<step>\t<ISO time> ", and the first one
# with a BOM as well.
_STAMP_RE = re.compile(r"^\d{4}-\d\d-\d\dT[\d:.]+Z ?")
# Colour codes arrive raw, and also as caret text ("^[[31m"). A real Jest
# failure had both, 2026-10-06.
_ANSI_RE = re.compile(r"(?:\x1b|\^\[)\[[0-9;]*[A-Za-z]")

_cache: dict = {}   # (repo_dir, branch) -> {"at", "ttl", "pr", "pinged"}
_locks: dict = {}   # (repo_dir, branch) -> Lock: one gh read per key at a time
_logs: dict = {}    # job id -> failure tail


def _ts(v) -> str:
    """For a check that hasn't started or finished, gh writes Go's zero time."""
    return "" if not v or str(v).startswith("0001-") else str(v)


def _check(c: dict) -> "dict | None":
    if c.get("__typename") == "StatusContext":
        st = c.get("state") or ""
        # A commit status has a creation time and no duration, so it gets no start.
        return {"name": c.get("context") or "status", "workflow": "",
                "state": "pass" if st == "SUCCESS" else
                         "fail" if st in ("FAILURE", "ERROR") else "run",
                "url": c.get("targetUrl") or "", "started": "", "completed": ""}
    concl = c.get("conclusion") or ""
    if c.get("status") != "COMPLETED":
        state = "run"
    elif concl in _SKIP:
        return None
    else:
        state = "pass" if concl in _PASS else "fail"
    return {"name": c.get("name") or "check", "workflow": c.get("workflowName") or "",
            "state": state, "url": c.get("detailsUrl") or "",
            "started": _ts(c.get("startedAt")), "completed": _ts(c.get("completedAt"))}


def _checks(rollup: list) -> "list[dict]":
    """One row for each check, with the newest attempt winning. A re-run, or one
    workflow fired by both push and pull_request, repeats a name, and `gh pr
    checks` dedupes it the same way. Skipped checks are dropped. Failures
    come first."""
    latest: dict = {}
    for c in sorted(rollup, key=lambda c: _ts(c.get("startedAt"))):
        latest[(c.get("workflowName") or "", c.get("name") or c.get("context") or "")] = c
    rows = [r for r in map(_check, latest.values()) if r]
    return sorted(rows, key=lambda r: (_ORDER[r["state"]], r["name"]))


def chip_state(pr: dict) -> str:
    """Sheet C as one word. Merged and closed end it. Otherwise it is whatever
    needs doing next: a red check comes before a review's comments, and both
    come before waiting on CI."""
    if pr["state"] == "MERGED":
        return "merged"
    if pr["state"] == "CLOSED":
        return "closed"
    if pr["failed"]:
        return "failing"
    if pr["decision"] == "CHANGES_REQUESTED":
        return "changes"
    if pr["running"]:
        return "running"
    if pr["decision"] == "APPROVED" or (not pr["decision"] and not pr["requested"]):
        return "ready"      # approved, or nothing in the repo asks for a review
    return "review"


def _login(r) -> str:
    return ((r or {}).get("author") or {}).get("login") or ""


def normalize(raw: dict) -> dict:
    """gh's JSON → the chip's. `review` is the changes-requested review,
    whose inline comments fetch() adds."""
    checks = _checks(raw.get("statusCheckRollup") or [])
    latest = raw.get("latestReviews") or []
    decision = raw.get("reviewDecision") or ""
    asked = [r for r in latest if r.get("state") == "CHANGES_REQUESTED"]
    last = max(asked, key=lambda r: r.get("submittedAt") or "", default=None)
    pr = {
        "number": raw["number"], "title": raw.get("title") or "",
        "url": raw.get("url") or "", "state": raw.get("state") or "OPEN",
        "base": raw.get("baseRefName") or "", "head": raw.get("headRefName") or "",
        "sha": raw.get("headRefOid") or "",
        "additions": raw.get("additions") or 0, "deletions": raw.get("deletions") or 0,
        "created": _ts(raw.get("createdAt")), "merged_at": _ts(raw.get("mergedAt")),
        "checks": checks,
        "passed": sum(c["state"] == "pass" for c in checks),
        "failed": sum(c["state"] == "fail" for c in checks),
        "running": sum(c["state"] == "run" for c in checks),
        "total": len(checks),
        "decision": decision,
        "requested": [r.get("login") or r.get("name") or r.get("slug") or ""
                      for r in raw.get("reviewRequests") or []],
        "reviews": [{"by": _login(r), "state": r.get("state") or "",
                     "at": r.get("submittedAt") or ""} for r in latest],
        "review": ({"by": _login(last), "at": last.get("submittedAt") or "",
                    "body": (last.get("body") or "").strip(), "comments": []}
                   if decision == "CHANGES_REQUESTED" and last else None),
    }
    pr["status"] = chip_state(pr)
    return pr


def failure_tail(log: str, n: int = LOG_LINES) -> str:
    """The end of a failed step's log, read the way a person would read it:
    prefixes, colour and post-job cleanup off. With "UNKNOWN STEP" (gh can't
    always map a log to its step) --log-failed returns the whole job, and only
    the cut at `##[error]` finds the failure in it."""
    lines = []
    for raw in log.splitlines():
        parts = raw.split("\t", 2)
        text = (parts[2] if len(parts) == 3 else raw).lstrip("\N{BYTE ORDER MARK}")
        lines.append(_ANSI_RE.sub("", _STAMP_RE.sub("", text)).rstrip())
    errors = [i for i, line in enumerate(lines) if line.startswith("##[error]")]
    if errors:
        lines = lines[:errors[-1] + 1]
    return "\n".join(lines[-n:]).strip("\n")


def alerts(pr: dict) -> "set[str]":
    """What is worth a ping right now, keyed so that each one fires once."""
    if pr["state"] != "OPEN":
        return set()
    out = set()
    if pr["failed"]:
        out.add(f"failing:{pr['sha']}")
    if pr["review"]:
        out.add(f"changes:{pr['review']['by']}:{pr['review']['at']}")
    return out


def next_pings(pinged: "set[str]", pr: dict) -> "tuple[set[str], list[str]]":
    """Returns (what is pinged now, what to ping now). While a re-run is going,
    the red commit stays pinged, so it pings once per head commit. Only an
    all-green read clears it, and a red after that green pings again. A review
    stops counting once the decision is no longer CHANGES_REQUESTED."""
    cur = alerts(pr)
    keep = pinged | cur
    if pr["state"] != "OPEN" or (not pr["failed"] and not pr["running"]):
        keep = {k for k in keep if not k.startswith("failing:")}
    if not pr["review"]:
        keep = {k for k in keep if not k.startswith("changes:")}
    return keep, sorted(cur - pinged)


def ping_text(pr: dict, key: str) -> str:
    where = f"{pr['title']} · ⎇ {pr['head']}\n{pr['url']}"
    if key.startswith("failing:"):
        names = ", ".join(c["name"] for c in pr["checks"] if c["state"] == "fail")
        return f"✕ PR #{pr['number']} checks failing — {names}\n{where}"
    by = pr["review"]["by"] if pr["review"] else ""
    return f"◆ PR #{pr['number']} changes requested{f' by {by}' if by else ''}\n{where}"


````

- [ ] **Step 4: Run the tests**

Run: `python3 -m pytest tests/test_prstatus.py -q`
Expected: `18 passed`.

- [ ] **Step 5: Commit**

```bash
git add bridge/prstatus.py tests/test_prstatus.py
git commit -m "prstatus: read a PR's checks and review into the chip's states

normalize/chip_state follow sheet C. failure_tail cuts a --log-failed log at
the runner's last ##[error] and strips gh's prefixes and colour codes.
next_pings pings red once per head commit and changes once per review."
```

---

### Task 6: Reading gh: fetch, cache, pings, Telegram

**Files:**
- Modify: `bridge/prstatus.py` (append after `ping_text`)
- Modify: `tests/test_prstatus.py` (append)

**Interfaces:**
- Consumes: Task 5's functions and constants; `github._run`, `github.remote_slug`, `git.default_branch`, `store.get_setting`/`set_setting`, `telegram.panel_kb`/`send`, `browser.rel`.
- Produces:
  - `fetch(slug: str, branch: str) -> tuple[dict | None, int]` (the PR, and how long to trust the answer)
  - `snapshot(repo_dir: str, branch: str, *, force: bool = False, session: str = "") -> {"pr": dict | None, "pinged": list[str], "checked": float}`. This is what the route returns.

- [ ] **Step 1: Append the failing tests**

The all-digit branch test and the Telegram-down test pin Review Focus 1 and 4.

Append to the end of `tests/test_prstatus.py`:

````python
# --- reading gh: fetch, snapshot, Telegram ------------------------------------

def _fake_gh(monkeypatch, routes):
    """routes: [(args prefix, (rc, stdout, stderr))], matched in order."""
    calls = []

    def fake(*args, timeout=20):
        calls.append(args)
        for prefix, answer in routes:
            if args[:len(prefix)] == prefix:
                return answer
        raise AssertionError(f"unexpected gh call {args}")
    monkeypatch.setattr(prstatus, "_gh", fake)
    return calls


@pytest.fixture(autouse=True)
def sent(monkeypatch):
    """Fresh caches. gh's repo lookups are pinned. Telegram is captured and
    synchronous."""
    store.init()
    prstatus._cache.clear()
    prstatus._logs.clear()
    monkeypatch.setattr(prstatus.github, "remote_slug", lambda d: "acme/rivendell")
    monkeypatch.setattr(prstatus.git, "default_branch", lambda d: "main")
    monkeypatch.setattr(prstatus, "_spawn", lambda fn, *a: fn(*a))
    monkeypatch.setattr(prstatus.config, "NOTIFY_ENABLE", True)
    monkeypatch.setattr(prstatus.config, "DASH_CHAT_ID", 555)
    box = []
    monkeypatch.setattr(prstatus.telegram, "send",
                        lambda chat, text, kb=None: box.append(text))
    return box


# --- fetch --------------------------------------------------------------------

@pytest.mark.parametrize("answer, ttl", [
    ((1, "", 'no pull requests found for branch "feat/x"'), prstatus.TTL),
    ((4, "", "To get started with GitHub CLI, please run:  gh auth login"), prstatus.ERR_TTL),
    ((127, "", "[Errno 2] No such file or directory: 'gh'"), prstatus.ERR_TTL),
    ((1, "", "GraphQL: API rate limit exceeded for user ID 1."), prstatus.ERR_TTL),
    ((0, "not json", ""), prstatus.ERR_TTL),
])
def test_fetch_is_quiet_about_every_way_gh_cant_answer(monkeypatch, answer, ttl):
    _fake_gh(monkeypatch, [(("pr", "view"), answer)])
    assert prstatus.fetch("acme/rivendell", "feat/x") == (None, ttl)


def test_a_failing_check_carries_its_log_fetched_once_per_job(monkeypatch):
    calls = _fake_gh(monkeypatch, [
        (("pr", "view"), (0, json.dumps(_raw(statusCheckRollup=[
            _run("backend", conclusion="FAILURE", job=7)])), "")),
        (("run", "view", "--job", "7"), (0, LOG, "")),
    ])
    pr, _ = prstatus.fetch("acme/rivendell", "feat/x")
    assert pr["checks"][0]["log"].endswith("exit code 1.")
    prstatus.fetch("acme/rivendell", "feat/x")
    assert sum(1 for c in calls if c[0] == "run") == 1      # the job's log is cached


def test_a_log_that_isnt_there_yet_is_asked_for_again(monkeypatch):
    calls = _fake_gh(monkeypatch, [
        (("pr", "view"), (0, json.dumps(_raw(statusCheckRollup=[
            _run("backend", conclusion="FAILURE", job=7)])), "")),
        (("run", "view"), (1, "", "run 9 is still in progress; logs will be available when it is complete")),
    ])
    assert prstatus.fetch("acme/rivendell", "feat/x")[0]["checks"][0]["log"] == ""
    prstatus.fetch("acme/rivendell", "feat/x")
    assert sum(1 for c in calls if c[0] == "run") == 2


def test_changes_requested_brings_that_reviews_inline_comments(monkeypatch):
    raw = _raw(reviewDecision="CHANGES_REQUESTED", latestReviews=[
        {"author": {"login": "mahdi"}, "state": "CHANGES_REQUESTED",
         "submittedAt": "2026-10-06T12:30:00Z", "body": "two things"}])
    _fake_gh(monkeypatch, [
        (("pr", "view"), (0, json.dumps(raw), "")),
        (("api", "repos/acme/rivendell/pulls/131/reviews?per_page=100"), (0, json.dumps([
            {"id": 11, "user": {"login": "mahdi"}, "state": "COMMENTED",
             "submitted_at": "2026-10-06T11:00:00Z"},
            {"id": 12, "user": {"login": "mahdi"}, "state": "CHANGES_REQUESTED",
             "submitted_at": "2026-10-06T12:30:00Z"}]), "")),
        (("api", "repos/acme/rivendell/pulls/131/comments?per_page=100"), (0, json.dumps([
            {"pull_request_review_id": 11, "path": "old.ts", "line": 1, "body": "earlier"},
            {"pull_request_review_id": 12, "path": "backend/src/group.service.ts",
             "line": 45, "original_line": 44, "body": "sort by client name"},
            {"pull_request_review_id": 12, "path": "frontend/inbox.tsx",
             "line": None, "original_line": 88, "body": "show the name "}]), "")),
    ])
    pr, _ = prstatus.fetch("acme/rivendell", "feat/x")
    assert pr["status"] == "changes"
    assert pr["review"]["body"] == "two things"
    assert pr["review"]["comments"] == [
        {"path": "backend/src/group.service.ts", "line": 45, "body": "sort by client name"},
        {"path": "frontend/inbox.tsx", "line": 88, "body": "show the name"}]   # outdated: original_line


# --- snapshot -----------------------------------------------------------------

def _clock(monkeypatch, t=1000.0):
    now = [t]
    monkeypatch.setattr(prstatus.time, "time", lambda: now[0])
    return now


def test_two_reads_inside_the_ttl_share_one_gh_call_and_force_has_a_floor(monkeypatch):
    now = _clock(monkeypatch)
    calls = _fake_gh(monkeypatch, [(("pr", "view"), (0, json.dumps(_raw()), ""))])
    a = prstatus.snapshot("/r", "feat/share")
    b = prstatus.snapshot("/r", "feat/share")
    assert len(calls) == 1 and a == b and a["pr"]["number"] == 131
    now[0] += 5
    prstatus.snapshot("/r", "feat/share", force=True)      # inside the floor: still cached
    assert len(calls) == 1
    now[0] += prstatus.FORCE_FLOOR
    prstatus.snapshot("/r", "feat/share", force=True)
    assert len(calls) == 2
    now[0] += prstatus.TTL
    prstatus.snapshot("/r", "feat/share")
    assert len(calls) == 3


def test_an_error_backs_off_keeps_the_last_chip_and_outlasts_force(monkeypatch):
    now = _clock(monkeypatch)
    _fake_gh(monkeypatch, [(("pr", "view"), (0, json.dumps(_raw()), ""))])
    prstatus.snapshot("/r", "feat/blip")
    calls = _fake_gh(monkeypatch, [(("pr", "view"), (1, "", "HTTP 403: API rate limit exceeded"))])
    now[0] += prstatus.TTL
    assert prstatus.snapshot("/r", "feat/blip")["pr"]["number"] == 131   # the last good chip stays
    now[0] += prstatus.FORCE_FLOOR
    prstatus.snapshot("/r", "feat/blip", force=True)
    assert len(calls) == 1                                  # backing off, force or not
    now[0] += prstatus.ERR_TTL
    prstatus.snapshot("/r", "feat/blip")
    assert len(calls) == 2


def test_no_chip_without_a_remote_or_on_the_default_branch(monkeypatch):
    calls = _fake_gh(monkeypatch, [])
    assert prstatus.snapshot("/r", "main")["pr"] is None
    assert prstatus.snapshot("/r", "")["pr"] is None
    monkeypatch.setattr(prstatus.github, "remote_slug", lambda d: None)
    assert prstatus.snapshot("/r2", "feat/x")["pr"] is None
    assert calls == []


def test_red_pings_telegram_once_even_across_a_restart(monkeypatch, sent):
    now = _clock(monkeypatch)
    _fake_gh(monkeypatch, [
        (("pr", "view"), (0, json.dumps(_raw(headRefOid="r1", statusCheckRollup=[
            _run("backend", conclusion="FAILURE", job=8)])), "")),
        (("run", "view"), (0, LOG, "")),
    ])
    snap = prstatus.snapshot("/r", "feat/ping", session="sid")
    assert snap["pinged"] == ["failing:r1"]
    assert len(sent) == 1 and sent[0].startswith("✕ PR #131 checks failing — backend")
    prstatus._cache.clear()                               # what a bridge restart does
    now[0] += prstatus.TTL
    assert prstatus.snapshot("/r", "feat/ping")["pinged"] == ["failing:r1"]
    assert len(sent) == 1


def test_an_all_digit_branch_gets_no_chip_rather_than_pr_number_59(monkeypatch):
    calls = _fake_gh(monkeypatch, [])
    assert prstatus.snapshot("/r", "59")["pr"] is None
    assert prstatus.snapshot("/r", "#59")["pr"] is None
    assert calls == []


def test_telegram_failing_never_breaks_the_read(monkeypatch):
    _fake_gh(monkeypatch, [
        (("pr", "view"), (0, json.dumps(_raw(statusCheckRollup=[
            _run("backend", conclusion="FAILURE", job=9)])), "")),
        (("run", "view"), (1, "", "expired")),
    ])

    def down(*a, **k):
        raise OSError("telegram unreachable")
    monkeypatch.setattr(prstatus.telegram, "send", down)
    snap = prstatus.snapshot("/r", "feat/tg-down")
    assert snap["pr"]["status"] == "failing" and snap["pinged"] == ["failing:abc123"]
````

- [ ] **Step 2: Run them to see them fail**

Run: `python3 -m pytest tests/test_prstatus.py -q`
Expected: `32 errors`, each `AttributeError: <module 'bridge.prstatus'> has no attribute '_spawn'`. The autouse fixture patches it, so every test in the file errors.

- [ ] **Step 3: Append the reading code**

Append after `ping_text`, two blank lines apart:

Append to the end of `bridge/prstatus.py`:

````python
def _gh(*args: str, timeout: int = 20) -> "tuple[int, str, str]":
    return github._run("gh", *args, timeout=timeout)


def _failure_log(slug: str, url: str) -> str:
    m = _JOB_RE.search(url or "")
    if not m:
        return ""          # not GitHub Actions: only the link, no log we can fetch
    job = m.group(1)
    if job not in _logs:
        rc, out, _ = _gh("run", "view", "--job", job, "-R", slug, "--log-failed",
                         timeout=40)
        tail = failure_tail(out) if rc == 0 else ""
        if not tail:
            return ""      # the run is still going, or the log has expired: ask next read
        if len(_logs) > 200:
            _logs.clear()  # ponytail: a crude bound, far above one session's failures
        _logs[job] = tail
    return _logs[job]


def _review_comments(slug: str, number: int, review: dict) -> "list[dict]":
    """The changes-requested review's inline comments. gh pr view has no
    comment text, and the per-review REST list has no line numbers (checked
    2026-10-06). So the code finds the review's id first, then filters the
    PR's comment list by that id.
    ponytail: only the first page (100) of each, and three gh calls per read
    while changes are requested. Cache by review id if that ever shows up in
    the rate limit."""
    try:
        rc, out, _ = _gh("api", f"repos/{slug}/pulls/{number}/reviews?per_page=100")
        if rc != 0:
            return []
        rid = next((r["id"] for r in json.loads(out)
                    if r.get("submitted_at") == review["at"]
                    and (r.get("user") or {}).get("login") == review["by"]), None)
        if rid is None:
            return []
        rc, out, _ = _gh("api", f"repos/{slug}/pulls/{number}/comments?per_page=100")
        if rc != 0:
            return []
        return [{"path": c.get("path") or "",
                 "line": c.get("line") or c.get("original_line"),
                 "body": (c.get("body") or "").strip()}
                for c in json.loads(out) if c.get("pull_request_review_id") == rid]
    except (ValueError, TypeError, KeyError):
        return []


def fetch(slug: str, branch: str) -> "tuple[dict | None, int]":
    """Returns (pr, how long to trust the answer). A None pr means no chip."""
    rc, out, err = _gh("pr", "view", branch, "-R", slug, "--json", FIELDS)
    if rc != 0:
        # "no pull requests found" is an answer. Anything else (signed out,
        # rate-limited, offline, gh missing) means gh doesn't know, so back off.
        return None, (TTL if "no pull requests found" in err else ERR_TTL)
    try:
        pr = normalize(json.loads(out))
    except (ValueError, KeyError, TypeError):
        return None, ERR_TTL
    for c in pr["checks"]:
        if c["state"] == "fail":
            c["log"] = _failure_log(slug, c["url"])
    if pr["review"]:
        pr["review"]["comments"] = _review_comments(slug, pr["number"], pr["review"])
    return pr, TTL


def _spawn(fn, *args) -> None:
    threading.Thread(target=fn, args=args, daemon=True).start()


def _telegram(project: str, session: str, pr: dict, keys: "list[str]") -> None:
    """Best effort, like runner._notify: a failed ping is only a missed ping."""
    if not (config.NOTIFY_ENABLE and config.TOKEN and config.DASH_CHAT_ID):
        return
    try:
        kb = telegram.panel_kb(config.DASH_CHAT_ID, session or None, project)
        for k in keys:
            telegram.send(config.DASH_CHAT_ID, ping_text(pr, k), kb)
    except Exception as e:  # noqa: BLE001: a ping must never break a read
        print(f"prstatus: Telegram ping failed: {e}")


def _pings(repo_dir: str, slug: str, branch: str, pr: dict, session: str) -> "list[str]":
    key = f"pr_pinged:{slug}:{branch}"
    try:
        old = set(json.loads(store.get_setting(key) or "[]"))
    except ValueError:
        old = set()
    new, fresh = next_pings(old, pr)
    if new != old:
        store.set_setting(key, json.dumps(sorted(new)) if new else None)
    if fresh:
        _spawn(_telegram, browser.rel(repo_dir), session, pr, fresh)
    return sorted(new)


def _read(repo_dir: str, branch: str, session: str, old: "dict | None") -> dict:
    now = time.time()
    slug = github.remote_slug(repo_dir) if branch else None
    # PRs land on the default branch. They don't come from it. And gh pr view
    # reads "59" (or "#59") as PR number 59, not as a branch.
    # ponytail: an all-digit branch gets no chip. `gh pr list --head` if one matters.
    if not slug or branch.lstrip("#").isdigit() or branch == git.default_branch(repo_dir):
        return {"at": now, "ttl": TTL, "pr": None, "pinged": []}
    pr, ttl = fetch(slug, branch)
    if pr is None and ttl == ERR_TTL and old:
        pr = old["pr"]      # a blip keeps the last good chip instead of blinking it out
    pinged = _pings(repo_dir, slug, branch, pr, session) if pr else []
    return {"at": now, "ttl": ttl, "pr": pr, "pinged": pinged}


def snapshot(repo_dir: str, branch: str, *, force: bool = False,
             session: str = "") -> dict:
    """The PR for `branch` of the repo at `repo_dir`, in the shape the chip
    wants: {"pr": dict | None, "pinged": [alert keys], "checked": epoch s}.
    `session` is only used for the Telegram button."""
    key = (repo_dir, branch)
    with _locks.setdefault(key, threading.Lock()):
        hit = _cache.get(key)
        trust = hit["ttl"] if hit else 0
        if force and trust <= TTL:
            trust = min(trust, FORCE_FLOOR)   # a rate-limit backoff outlasts force
        if hit is None or time.time() - hit["at"] >= trust:
            hit = _cache[key] = _read(repo_dir, branch, session, hit)
    return {"pr": hit["pr"], "pinged": hit["pinged"], "checked": hit["at"]}
````

- [ ] **Step 4: Run the tests**

Run: `python3 -m pytest tests/test_prstatus.py -q`
Expected: `32 passed`, plus one printed `prstatus: Telegram ping failed: telegram unreachable`, which is the Telegram-down test working.

- [ ] **Step 5: Commit**

```bash
git add bridge/prstatus.py tests/test_prstatus.py
git commit -m "prstatus: read gh once per (repo, branch), quietly, and ping once

TTL 45s shared by every tab, a 10s floor on forced reads, and a 5-minute
back-off that keeps the last good chip. Failing Actions jobs carry their
log tail (fetched once per job). A changes-requested review brings its
inline comments. Pings persist in settings and go to Telegram best-effort."
```

---

### Task 7: `GET /local/github/pr/status`

**Files:**
- Modify: `bridge/dashboard/server.py:35` (the import list), and add a route after `:509` (`/local/github/issues`)
- Create: `tests/test_prstatus_endpoint.py`

The route is exact-match and comes after `/local/github/issues`. No `startswith` above it can swallow it, because the only `/local/`-prefix GET routes are `/local/sessions/…` and `/local/run/…`. On a bridge still running old code, the path falls through to the final `{"error": "not found"}, 404`, which the chip treats as no chip.

**Interfaces:**
- Consumes: `prstatus.snapshot` (Task 6).
- Produces: `GET /local/github/pr/status?project=<rel>&branch=<name>[&session=<id>][&force=1]` returns `{"pr": …|null, "pinged": [...], "checked": <epoch s>}`, or 400 `{"error": "invalid project"}`.

- [ ] **Step 1: Write the failing test**

Create `tests/test_prstatus_endpoint.py`:

````python
"""GET /local/github/pr/status on the dashboard, driven without sockets by
using the Handler.__new__ trick (as in test_breakdown_endpoint.py). The
caching and gh handling behind it are in test_prstatus.py.
Run: python3 -m pytest tests/test_prstatus_endpoint.py -q"""

import os

from bridge import config, prstatus
from bridge.dashboard import server as dash


def _handler():
    h = dash.Handler.__new__(dash.Handler)
    box = {}
    h._json = lambda obj, code=200: box.update(obj=obj, code=code)
    return h, box


def test_pr_status_hands_branch_force_and_session_to_the_snapshot(monkeypatch):
    os.makedirs(os.path.join(config.BASE_PATH, "rl-proj"), exist_ok=True)
    seen = {}

    def fake(repo_dir, branch, *, force=False, session=""):
        seen.update(repo_dir=repo_dir, branch=branch, force=force, session=session)
        return {"pr": None, "pinged": [], "checked": 1.0}
    monkeypatch.setattr(prstatus, "snapshot", fake)
    h, box = _handler()

    h._get_api("/local/github/pr/status", {
        "project": ["rl-proj"], "branch": [" feat/x "], "force": ["1"], "session": ["s1"]})

    assert box == {"obj": {"pr": None, "pinged": [], "checked": 1.0}, "code": 200}
    assert seen == {"repo_dir": os.path.realpath(os.path.join(config.BASE_PATH, "rl-proj")),
                    "branch": "feat/x", "force": True, "session": "s1"}


def test_pr_status_without_force_or_session_reads_the_cache(monkeypatch):
    os.makedirs(os.path.join(config.BASE_PATH, "rl-proj"), exist_ok=True)
    seen = {}
    monkeypatch.setattr(prstatus, "snapshot", lambda d, b, *, force=False, session="":
                        seen.update(force=force, session=session) or {"pr": None})
    h, box = _handler()

    h._get_api("/local/github/pr/status", {"project": ["rl-proj"], "branch": ["feat/x"]})

    assert box["code"] == 200 and seen == {"force": False, "session": ""}


def test_pr_status_for_an_unknown_project_is_400():
    h, box = _handler()

    h._get_api("/local/github/pr/status", {"project": ["../../etc"], "branch": ["x"]})

    assert box["code"] == 400
````

- [ ] **Step 2: Run it to see it fail**

Run: `python3 -m pytest tests/test_prstatus_endpoint.py -q`
Expected: `3 failed`. The route doesn't exist yet, so each one gets the 404 fall-through.

- [ ] **Step 3: Add the route**

In `bridge/dashboard/server.py`, find (around line 35):

````python
                    models, native, preview_detect, project_config,
````

Replace it with:

````python
                    models, native, preview_detect, project_config, prstatus,
````

In `bridge/dashboard/server.py`, find (around line 509):

````python
            return self._json(github.issues(abs_p))
````

Replace it with:

````python
            return self._json(github.issues(abs_p))
        if path == "/local/github/pr/status":
            # The chat header's PR chip (bridge/prstatus.py). The bridge caches it
            # for each (repo, branch), so every open tab polling it costs one gh call.
            abs_p = _abs_project(qs.get("project", [None])[0])
            if abs_p is None:
                return self._json({"error": "invalid project"}, 400)
            return self._json(prstatus.snapshot(
                abs_p, (qs.get("branch", [""])[0] or "").strip(),
                force=qs.get("force", ["0"])[0] == "1",
                session=(qs.get("session", [""])[0] or "").strip()))
````

- [ ] **Step 4: Run it, then the whole suite**

Run: `python3 -m pytest tests/test_prstatus_endpoint.py -q && python3 -m pytest tests/ -q`
Expected: `3 passed`, then `1495 passed, 2 skipped`.

- [ ] **Step 5: Commit**

```bash
git add bridge/dashboard/server.py tests/test_prstatus_endpoint.py
git commit -m "dashboard: GET /local/github/pr/status for the chat header's PR chip"
```

---

### Task 8: Client data: PR types, `prStatus`, the push event, the chip's words

**Files:**
- Modify: `bridge/dashboard/web/src/api.ts:304-312` (after `IssuesInfo`), `:1023-1048` (after `req`), `:1442-1446` (`gitPush`), `:1521-1525` (`createIssue`, to add `prStatus` after it), `:1634-1638` (`createPr`)
- Create: `bridge/dashboard/web/src/lib/prchip.ts`
- Create: `bridge/dashboard/web/src/lib/prchip.check.ts`

"After a dashboard push" is handled at the one place every push button passes through: `api.gitPush` (used by the GIT tab, the footer chain's PUSH and FILES) and `api.createPr` (OPEN PR, which pushes first). On success they fire `window` event `hud:pushed`. That is the same window-event pattern as `lib/opensettings.ts`'s `hud:settings`.

**Interfaces:**
- Consumes: the route's JSON (Task 7).
- Produces:
  - From `api.ts`: `PrCheck`, `PrComment`, `PrState`, `PrInfo`, `PrStatus`; `PUSHED_EVENT = "hud:pushed"`, with detail `{ project: string; branch: string }` (`branch` is `""` when unknown); and `api.prStatus(project, branch, session?, force = false): Promise<PrStatus>`.
  - From `lib/prchip.ts`: `TONE: Record<PrState, { fg, border, bg, num, ink, glyph }>`, `reviewItems(pr)`, `chipLabel(pr) -> { text, spin }`, `stateLine(pr)`, `duration(started, completed, now)`, `failureMessage(pr)`, `commentsMessage(pr)`, `pingText(pr, key)`, `freshPings(seen, pinged)`.

- [ ] **Step 1: Write the failing check**

Create `bridge/dashboard/web/src/lib/prchip.check.ts`:

````ts
// Run: node bridge/dashboard/web/src/lib/prchip.check.ts
import type { PrInfo } from "../api.ts";
import {
  chipLabel, commentsMessage, duration, failureMessage, freshPings, pingText, reviewItems, stateLine,
} from "./prchip.ts";

const ok = (cond: boolean, what: string) => {
  if (!cond) throw new Error(`FAIL: ${what}`);
  console.log(`ok - ${what}`);
};

const base: PrInfo = {
  number: 131, title: "Inbox: group action items by client", url: "https://github.com/acme/r/pull/131",
  state: "OPEN", base: "main", head: "feat/inbox-grouping", sha: "abc", additions: 412, deletions: 88,
  created: "2026-10-06T12:00:00Z", merged_at: "", checks: [], passed: 0, failed: 0, running: 0, total: 0,
  decision: "", requested: [], reviews: [], review: null, status: "ready",
};
const pr = (o: Partial<PrInfo>): PrInfo => ({ ...base, ...o });

// --- sheet C ------------------------------------------------------------------
ok(chipLabel(pr({ status: "running", passed: 2, total: 5 })).text === "2/5" && chipLabel(pr({ status: "running" })).spin, "RUNNING: finished out of total, with the ring");
ok(chipLabel(pr({ status: "failing", failed: 1 })).text === "✕ 1 FAILING", "FAILING counts the red checks");
ok(chipLabel(pr({ status: "review", passed: 5, total: 5 })).text === "✓ 5/5 · REVIEW", "GREEN/REVIEW");
ok(chipLabel(pr({ status: "review" })).text === "REVIEW", "no CI: REVIEW without a 0/0");
const changes = pr({
  status: "changes",
  review: { by: "mahdi", at: "2026-10-06T12:30:00Z", body: "", comments: [
    { path: "backend/src/group.service.ts", line: 45, body: "sort by client name — the order jumps between loads" },
    { path: "frontend/inbox.tsx", line: 88, body: "show the client's name here, not the id" }] },
});
ok(chipLabel(changes).text === "◆ 2 COMMENTS", "CHANGES REQUESTED counts the comments");
ok(chipLabel(pr({ status: "changes", review: { by: "m", at: "", body: "", comments: [] } })).text === "◆ CHANGES", "a bare changes-requested still says so");
ok(chipLabel(pr({ status: "ready" })).text === "✓ READY" && chipLabel(pr({ status: "merged" })).text === "MERGED", "READY and MERGED");
ok(stateLine(pr({ state: "MERGED", status: "merged" })) === "MERGED INTO MAIN" && stateLine(changes) === "CHANGES REQUESTED" && stateLine(pr({ status: "failing" })) === "OPEN", "popover state words");

// --- durations (sheet B) ------------------------------------------------------
ok(duration("2026-10-06T12:00:00Z", "2026-10-06T12:02:14Z", 0) === "2m 14s", "2m 14s");
ok(duration("2026-10-06T12:00:00Z", "2026-10-06T12:00:48Z", 0) === "48s", "48s");
ok(duration("2026-10-06T12:00:00Z", "2026-10-06T12:01:02Z", 0) === "1m 02s", "seconds pad under a minute count");
ok(duration("2026-10-06T12:00:00Z", "", Date.parse("2026-10-06T12:03:05Z")) === "3m 05s…", "a running check ticks with …");
ok(duration("", "", 0) === "", "a commit status has no duration");

// --- what the buttons send ----------------------------------------------------
const red = pr({
  status: "failing", failed: 1,
  checks: [{ name: "backend", workflow: "CI", state: "fail", url: "https://github.com/acme/r/actions/runs/9/job/7", started: "", completed: "", log: "FAIL x.spec.ts\n##[error]Process completed with exit code 1." },
           { name: "lint", workflow: "CI", state: "pass", url: "", started: "", completed: "" }],
});
ok(failureMessage(red) === [
  "Checks failed on PR #131 · ⎇ feat/inbox-grouping (1): https://github.com/acme/r/pull/131",
  "",
  "backend — https://github.com/acme/r/actions/runs/9/job/7",
  "```",
  "FAIL x.spec.ts",
  "##[error]Process completed with exit code 1.",
  "```",
].join("\n"), "SEND FAILURE: the PR, the failing check and its log, nothing about the green ones");
ok(failureMessage(pr({ checks: [{ name: "vercel", workflow: "", state: "fail", url: "", started: "", completed: "" }] })).endsWith("vercel\n(no log here, open the link)"), "a check with no log says so");
ok(commentsMessage(changes) === [
  "Changes requested by mahdi on PR #131 · ⎇ feat/inbox-grouping (2): https://github.com/acme/r/pull/131",
  "backend/src/group.service.ts:45",
  "  sort by client name — the order jumps between loads",
  "frontend/inbox.tsx:88",
  "  show the client's name here, not the id",
].join("\n"), "SEND 2 COMMENTS: one message, sheet A's shape");
const withBody = pr({ review: { by: "m", at: "", body: "two things", comments: [{ path: "a.ts", line: null, body: "x" }] } });
ok(reviewItems(withBody).length === 2 && commentsMessage(withBody).includes("\n  two things\na.ts\n  x"), "the review's own words lead, and an outdated comment cites no line");

// --- bell ---------------------------------------------------------------------
ok(pingText(red, "failing:abc") === "PR #131 · 1 check failing — backend", "the bell names the red check");
ok(pingText(changes, "changes:mahdi:t") === "PR #131 · changes requested by mahdi", "and who asked for changes");
ok(freshPings(["failing:a"], ["failing:a", "changes:m:t"]).join() === "changes:m:t", "only alerts this browser hasn't shown ring the bell");
ok(freshPings(["failing:a"], []).length === 0, "an alert that cleared rings nothing");

console.log("\nall prchip checks passed");
````

- [ ] **Step 2: Run it to see it fail**

Run: `node bridge/dashboard/web/src/lib/prchip.check.ts`
Expected: `Error [ERR_MODULE_NOT_FOUND]: Cannot find module '…/lib/prchip.ts'`.

- [ ] **Step 3: Write the chip's words**

Create `bridge/dashboard/web/src/lib/prchip.ts`:

````ts
import type { PrComment, PrInfo, PrState } from "../api";

/** The PR chip's words and colours, and the messages its buttons send
 *  (components/hud/PrChip.tsx, review loop B/C). Pure, so prchip.check.ts
 *  can run it under node. */

/** Sheet C in the app's tokens: --acc running, --err failing, --ok green
 *  (READY filled), --warn review comments, --purple merged. `ink` is the
 *  state's colour on the popover, where READY's fill would vanish. */
export const TONE: Record<PrState, { fg: string; border: string; bg: string; num: string; ink: string; glyph: string }> = {
  running: { fg: "var(--acc)", border: "color-mix(in srgb, var(--acc) 40%, transparent)", bg: "color-mix(in srgb, var(--acc) 8%, transparent)", num: "var(--txh)", ink: "var(--acc)", glyph: "◌" },
  failing: { fg: "var(--err-hi)", border: "color-mix(in srgb, var(--err) 45%, transparent)", bg: "color-mix(in srgb, var(--err) 10%, transparent)", num: "var(--txh)", ink: "var(--err)", glyph: "✕" },
  review: { fg: "var(--ok)", border: "color-mix(in srgb, var(--ok) 35%, transparent)", bg: "transparent", num: "var(--txh)", ink: "var(--ok)", glyph: "✓" },
  changes: { fg: "var(--warn)", border: "color-mix(in srgb, var(--warn) 45%, transparent)", bg: "color-mix(in srgb, var(--warn) 9%, transparent)", num: "var(--txh)", ink: "var(--warn)", glyph: "◆" },
  ready: { fg: "var(--acc-on)", border: "var(--ok)", bg: "var(--ok)", num: "var(--acc-on)", ink: "var(--ok)", glyph: "✓" },
  merged: { fg: "var(--purple-h)", border: "color-mix(in srgb, var(--purple) 45%, transparent)", bg: "color-mix(in srgb, var(--purple) 10%, transparent)", num: "var(--txh)", ink: "var(--purple)", glyph: "⇡" },
  closed: { fg: "var(--txl)", border: "color-mix(in srgb, var(--txl) 35%, transparent)", bg: "transparent", num: "var(--txm)", ink: "var(--txl)", glyph: "⇡" },
};

/** What SEND n COMMENTS sends: the review's own words first, if it has any,
 *  then each inline comment. */
export function reviewItems(pr: PrInfo): PrComment[] {
  const r = pr.review;
  if (!r) return [];
  return [...(r.body ? [{ path: "", line: null, body: r.body }] : []), ...r.comments];
}

/** The chip's text after "⇡ #131" (sheet C). `spin` draws the running ring. */
export function chipLabel(pr: PrInfo): { text: string; spin: boolean } {
  switch (pr.status) {
    case "running": return { text: `${pr.passed + pr.failed}/${pr.total}`, spin: true };
    case "failing": return { text: `✕ ${pr.failed} FAILING`, spin: false };
    case "review": return { text: pr.total ? `✓ ${pr.passed}/${pr.total} · REVIEW` : "REVIEW", spin: false };
    case "changes": {
      const n = reviewItems(pr).length;
      return { text: n ? `◆ ${n} COMMENT${n === 1 ? "" : "S"}` : "◆ CHANGES", spin: false };
    }
    case "ready": return { text: "✓ READY", spin: false };
    case "merged": return { text: "MERGED", spin: false };
    case "closed": return { text: "CLOSED", spin: false };
  }
}

/** The popover's state words: OPEN, CHANGES REQUESTED, MERGED INTO MAIN. */
export function stateLine(pr: PrInfo): string {
  if (pr.state === "MERGED") return `MERGED INTO ${pr.base.toUpperCase()}`;
  if (pr.state === "CLOSED") return "CLOSED";
  if (pr.status === "changes") return "CHANGES REQUESTED";
  if (pr.status === "ready") return "READY";
  return "OPEN";
}

/** A check's duration: "48s" or "2m 14s", with "…" while it runs. Blank
 *  without a start. */
export function duration(started: string, completed: string, now: number): string {
  const a = Date.parse(started);
  if (!started || Number.isNaN(a)) return "";
  const b = completed ? Date.parse(completed) : now;
  const s = Math.max(0, Math.round(((Number.isNaN(b) ? now : b) - a) / 1000));
  const txt = s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
  return completed ? txt : `${txt}…`;
}

/** SEND FAILURE TO AGENT: the PR, then each failing check with its link and
 *  log, as one message. */
export function failureMessage(pr: PrInfo): string {
  const bad = pr.checks.filter((c) => c.state === "fail");
  const out = [`Checks failed on PR #${pr.number} · ⎇ ${pr.head} (${bad.length}): ${pr.url}`];
  for (const c of bad) {
    out.push("", `${c.name}${c.url ? ` — ${c.url}` : ""}`);
    out.push(c.log ? "```\n" + c.log + "\n```" : "(no log here, open the link)");
  }
  return out.join("\n");
}

/** SEND n COMMENTS TO AGENT: shaped like the diff notes' message (sheet A). */
export function commentsMessage(pr: PrInfo): string {
  const items = reviewItems(pr);
  const by = pr.review?.by ? ` by ${pr.review.by}` : "";
  const out = [`Changes requested${by} on PR #${pr.number} · ⎇ ${pr.head} (${items.length}): ${pr.url}`];
  for (const c of items) {
    if (c.path) out.push(`${c.path}${c.line ? `:${c.line}` : ""}`);
    for (const l of c.body.trim().split("\n")) out.push(`  ${l}`);
  }
  return out.join("\n");
}

/** The bell's line for one of the bridge's alert keys. */
export function pingText(pr: PrInfo, key: string): string {
  if (key.startsWith("failing:")) {
    const names = pr.checks.filter((c) => c.state === "fail").map((c) => c.name).join(", ");
    return `PR #${pr.number} · ${pr.failed} check${pr.failed === 1 ? "" : "s"} failing${names ? ` — ${names}` : ""}`;
  }
  return `PR #${pr.number} · changes requested${pr.review?.by ? ` by ${pr.review.by}` : ""}`;
}

/** Bell pings due now: alerts the bridge holds that this browser hasn't shown yet. */
export const freshPings = (seen: string[], pinged: string[]) => pinged.filter((k) => !seen.includes(k));
````

- [ ] **Step 4: api.ts: the types**

In `bridge/dashboard/web/src/api.ts`, find (around line 304):

````ts
export interface IssuesInfo {
  has_remote: boolean;
  slug: string | null;
  gh_ok: boolean;
  error: string;
  open_count: number;
  closed_count: number;
  issues: Issue[];
}
````

Replace it with:

````ts
export interface IssuesInfo {
  has_remote: boolean;
  slug: string | null;
  gh_ok: boolean;
  error: string;
  open_count: number;
  closed_count: number;
  issues: Issue[];
}

/** One CI check on a PR (bridge/prstatus.py). Skipped checks are left out. */
export interface PrCheck {
  name: string;
  workflow: string;
  state: "pass" | "fail" | "run";
  url: string;        // the check's page on GitHub
  started: string;    // ISO; "" when unknown, and always for a commit status
  completed: string;  // ISO; "" while it runs
  log?: string;       // a failing Actions job: its failed step's last ~60 lines
}
export interface PrComment { path: string; line: number | null; body: string }
export type PrState = "running" | "failing" | "review" | "changes" | "ready" | "merged" | "closed";
export interface PrInfo {
  number: number;
  title: string;
  url: string;
  state: "OPEN" | "MERGED" | "CLOSED";
  base: string;
  head: string;
  sha: string;
  additions: number;
  deletions: number;
  created: string;
  merged_at: string;
  checks: PrCheck[];
  passed: number;
  failed: number;
  running: number;
  total: number;
  decision: string;     // gh reviewDecision: APPROVED | CHANGES_REQUESTED | REVIEW_REQUIRED | ""
  requested: string[];  // reviewers asked who haven't answered
  reviews: { by: string; state: string; at: string }[];
  /** The review asking for changes, with its inline comments; null otherwise. */
  review: { by: string; at: string; body: string; comments: PrComment[] } | null;
  status: PrState;      // the chip's state (sheet C)
}
export interface PrStatus {
  pr: PrInfo | null;    // null = no chip: no PR, no GitHub remote, gh missing or signed out
  pinged: string[];     // alerts the bridge has pinged (failing:<sha>, changes:<by>:<at>)
  checked: number;      // epoch s of the gh read behind this answer
}
````

- [ ] **Step 5: api.ts: the push event**

In `bridge/dashboard/web/src/api.ts`, find (around line 1089):

````ts
  return (await res.json()) as T;
}
````

Replace it with:

````ts
  return (await res.json()) as T;
}

/** Fired on window after a successful push from any dashboard button (the GIT
 *  tab, the footer chain, FILES, OPEN PR). The PR chip re-reads on it rather
 *  than waiting for its next minute. */
export const PUSHED_EVENT = "hud:pushed";
const pushed = (project: string, branch?: string) => <T extends { ok: boolean }>(r: T): T => {
  if (r.ok) window.dispatchEvent(new CustomEvent(PUSHED_EVENT, { detail: { project, branch: branch ?? "" } }));
  return r;
};
````

In `bridge/dashboard/web/src/api.ts`, find (around line 1493):

````ts
  gitPush: (project: string, branch?: string) =>
    req<{ ok: boolean; output: string }>("/local/git/push", {
      method: "POST",
      body: { project, ...(branch ? { branch } : {}) },
    }),
````

Replace it with:

````ts
  gitPush: (project: string, branch?: string) =>
    req<{ ok: boolean; output: string }>("/local/git/push", {
      method: "POST",
      body: { project, ...(branch ? { branch } : {}) },
    }).then(pushed(project, branch)),
````

In `bridge/dashboard/web/src/api.ts`, find (around line 1685):

````ts
  createPr: (project: string, head: string, base: string, title: string, body?: string) =>
    req<{ ok: boolean; url: string; number: number | null; output: string }>(
      "/local/github/pr",
      { method: "POST", body: { project, head, base, title, body } },
    ),
````

Replace it with:

````ts
  createPr: (project: string, head: string, base: string, title: string, body?: string) =>
    req<{ ok: boolean; url: string; number: number | null; output: string }>(
      "/local/github/pr",
      { method: "POST", body: { project, head, base, title, body } },
    ).then(pushed(project, head)),
````

- [ ] **Step 6: api.ts: `prStatus`**

In `bridge/dashboard/web/src/api.ts`, find (around line 1572):

````ts
  createIssue: (project: string, title: string, body: string) =>
    req<{ ok: boolean; output: string }>("/local/github/issue", {
      method: "POST",
      body: { project, title, body },
    }),
````

Replace it with:

````ts
  createIssue: (project: string, title: string, body: string) =>
    req<{ ok: boolean; output: string }>("/local/github/issue", {
      method: "POST",
      body: { project, title, body },
    }),
  // The chat header's PR chip. `force` (focus, a push) still has a 10s floor
  // in the bridge. `session` is only used for the Telegram ping's button.
  prStatus: (project: string, branch: string, session?: string, force = false) =>
    req<PrStatus>(
      `/local/github/pr/status?project=${encodeURIComponent(project)}&branch=${encodeURIComponent(branch)}${
        session ? `&session=${encodeURIComponent(session)}` : ""}${force ? "&force=1" : ""}`),
````

- [ ] **Step 7: Run the check and typecheck**

Run: `node bridge/dashboard/web/src/lib/prchip.check.ts && (cd bridge/dashboard/web && node_modules/.bin/tsc -p tsconfig.app.json)`
Expected: twenty-one `ok -` lines and `all prchip checks passed`, then only the known `remark-breaks` error.

- [ ] **Step 8: Commit**

```bash
git add bridge/dashboard/web/src/api.ts bridge/dashboard/web/src/lib/prchip.ts bridge/dashboard/web/src/lib/prchip.check.ts
git commit -m "dashboard: PR status client — types, prStatus, hud:pushed, chip words

lib/prchip.ts holds sheet C's labels and tones, check durations, and the
SEND FAILURE / SEND n COMMENTS messages. api.gitPush and api.createPr fire
hud:pushed on success so the chip re-reads after any dashboard push."
```

---

### Task 9: The PR chip and its popover in the chat header

**Files:**
- Create: `bridge/dashboard/web/src/components/hud/PrChip.tsx`
- Modify: `bridge/dashboard/web/src/components/hud/Terminal.tsx:17` (import), `:204` (destructure), `:260-263` (props), `:518` (the caption row, after the branch button)
- Modify: `bridge/dashboard/web/src/App.tsx` (`archiveOpen` before `setLifecycle` `:1969`, and the Terminal props after `onDropFiles` `:2088`)

The caption row (`Terminal.tsx:488`) is `height: 12, overflow: hidden`. The chip is a 12px border-box, so it fits. The popover can't live inside that row, so it is portalled into `[data-theme]` with `position: fixed`, positioned from the chip's rect. That is `UpdateButton.tsx:175`'s pattern: it portals out because an animated ancestor would otherwise become the containing block for fixed elements.

The popover closes on a click outside it, or on Esc. The Esc listener is a `keydown` that bubbles on `document`, so the HUD's confirm dialog gets Esc first, and App's window handler never sees this one.

REMOVE WORKTREE looks the path up with `api.worktrees(project)` (branch matches and `!is_main`). It then confirms, saying uncommitted changes in the tree will be deleted, and calls the existing `api.worktreeRemove(project, path, branch, false)`, which keeps the branch.

**Interfaces:**
- Consumes: Task 8 (`api.prStatus`, `PUSHED_EVENT`, the `lib/prchip` functions), `notify` (`Notifications.tsx`), `askConfirm` (`components/ui/Ask.tsx`), `initials` (`lib/rivendelltasks.ts`), `ago` (`lib/surfaces.ts`), `hairline` (`lib/shell.ts`), `api.archiveSession` (existing, previously unused), `api.worktrees`, `api.worktreeRemove`.
- Produces: `PrChip({ project, branch, sessionId, title, inWorktree, busy, onSend, onArchive })`, and the Terminal props `onSendText?: (text: string) => void` and `onArchive?: () => void`.

- [ ] **Step 1: Create the chip**

Create `bridge/dashboard/web/src/components/hud/PrChip.tsx`:

````tsx
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { api, PUSHED_EVENT, type PrStatus } from "../../api";
import { TONE, chipLabel, commentsMessage, duration, failureMessage, freshPings, pingText, reviewItems, stateLine } from "../../lib/prchip";
import { initials } from "../../lib/rivendelltasks";
import { hairline } from "../../lib/shell";
import { ago } from "../../lib/surfaces";
import { askConfirm } from "../ui/Ask";
import { notify } from "./Notifications";

/** The branch's PR in the chat header's caption row, and its popover
 *  (review loop B/C, docs/superpowers/specs/review-loop.md).
 *
 *  It polls GET /local/github/pr/status every 60s while this tab is visible,
 *  on focus, and a few seconds after any dashboard push (api.ts fires
 *  PUSHED_EVENT). Every failure is silent. A bridge still on pre-restart code
 *  404s the route, and gh may be missing or signed out. Neither draws a chip
 *  or raises a toast. The bell rings for the alerts the bridge pinged
 *  Telegram about (`pinged`), once per browser: the last set seen is kept in
 *  localStorage. */

const POLL_MS = 60_000;
const AFTER_PUSH_MS = 8_000;   // GitHub needs a moment to see the new head and queue its checks
const SEEN = (project: string, branch: string) => `pr-pinged:${project}@${branch}`;

function ringBell(project: string, branch: string, s: PrStatus) {
  let seen: string[] = [];
  try { seen = JSON.parse(localStorage.getItem(SEEN(project, branch)) ?? "[]"); } catch { /* first look */ }
  if (s.pr) for (const k of freshPings(seen, s.pinged)) notify(k.startsWith("failing:") ? "error" : "info", pingText(s.pr, k));
  try { localStorage.setItem(SEEN(project, branch), JSON.stringify(s.pinged)); } catch { /* full: may ring again */ }
}

/** "just now", "3m ago": `ago` speaks epoch seconds, gh speaks ISO. */
const since = (sec: number) => { const a = ago(sec); return !a || a === "now" ? "just now" : `${a} ago`; };
const sinceIso = (iso: string) => since(Date.parse(iso) / 1000);

export function PrChip({ project, branch, sessionId, title, inWorktree, busy, onSend, onArchive }: {
  project: string;
  branch: string;
  sessionId: string;
  title: string;
  /** The session runs in a linked worktree, so REMOVE WORKTREE applies. */
  inWorktree: boolean;
  /** A turn is running: removing its tree would pull it out from under it. */
  busy: boolean;
  onSend: (text: string) => void;
  onArchive: () => void;
}) {
  const [snap, setSnap] = useState<PrStatus | null>(null);
  const [open, setOpen] = useState(false);
  const [hov, setHov] = useState("");
  const chipRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const hp = (k: string) => ({ onMouseEnter: () => setHov(k), onMouseLeave: () => setHov("") });

  useEffect(() => {
    setSnap(null);
    setOpen(false);
    let live = true;
    let later = 0;
    const load = (force = false) => {
      if (document.visibilityState !== "visible") return;
      api.prStatus(project, branch, sessionId, force)
        .then((s) => { if (!live) return; setSnap(s); ringBell(project, branch, s); })
        .catch(() => { /* no chip: a pre-restart bridge (404) or offline. Never a toast. */ });
    };
    const onVisible = () => { if (document.visibilityState === "visible") load(true); };
    const onPushed = (e: Event) => {
      const d = (e as CustomEvent<{ project: string; branch: string }>).detail;
      if (d.project !== project || (d.branch && d.branch !== branch)) return;
      window.clearTimeout(later);
      later = window.setTimeout(() => load(true), AFTER_PUSH_MS);
    };
    load();
    const id = window.setInterval(() => load(), POLL_MS);
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    window.addEventListener(PUSHED_EVENT, onPushed);
    return () => {
      live = false;
      window.clearInterval(id);
      window.clearTimeout(later);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
      window.removeEventListener(PUSHED_EVENT, onPushed);
    };
  }, [project, branch, sessionId]);

  // Closes on a click outside or on Esc. The Esc listener bubbles on document,
  // so the HUD's confirm dialog takes Esc first, and App's window handler
  // (which closes overlays) never sees this one.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!chipRef.current?.contains(t) && !popRef.current?.contains(t)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); setOpen(false); } };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("pointerdown", onDown); document.removeEventListener("keydown", onKey); };
  }, [open]);

  const pr = snap?.pr;
  if (!pr || !snap) return null;
  const tone = TONE[pr.status];
  const lab = chipLabel(pr);

  function send(text: string) { onSend(text); setOpen(false); }

  async function archive() {
    if (await askConfirm(`Archive “${title || "this session"}”? It leaves the sessions list. HISTORY keeps it.`)) onArchive();
  }

  async function removeWorktree() {
    const wts = await api.worktrees(project).catch(() => null);
    const w = wts?.worktrees.find((x) => x.branch === branch && !x.is_main);
    if (!w) { notify("info", `No linked worktree holds ${branch}.`); return; }
    if (!(await askConfirm(`Remove the worktree at ${w.path}? Uncommitted changes in it are deleted. The branch stays.`))) return;
    const r = await api.worktreeRemove(project, w.path, branch, false)
      .catch((e: Error) => ({ ok: false, output: e.message }));
    notify(r.ok ? "info" : "error", r.ok ? `Removed the ${branch} worktree.` : `Remove failed: ${r.output}`);
  }

  const rect = chipRef.current?.getBoundingClientRect();
  const top = (rect?.bottom ?? 0) + 8;
  const left = Math.max(8, Math.min((rect?.left ?? 0) - 40, window.innerWidth - 438));
  const sect: CSSProperties = { borderTop: "1px solid color-mix(in srgb, var(--acc) 12%, transparent)", padding: "8px 12px 10px" };
  const head: CSSProperties = { display: "flex", alignItems: "center", gap: 8, fontSize: "var(--t85)", letterSpacing: 1.6, color: "var(--txl)", marginBottom: 6 };
  const wide = (ink: string, k: string): CSSProperties => ({
    width: "100%", marginTop: 9, appearance: "none", cursor: "pointer", fontFamily: "inherit", fontSize: "var(--t95)", letterSpacing: 1.4,
    padding: "8px 9px", border: `1px solid ${ink}`, color: ink,
    background: `color-mix(in srgb, ${ink} ${hov === k ? 18 : 10}%, transparent)`,
  });
  const spin = (size: number): CSSProperties => ({
    width: size, height: size, flex: "none", borderRadius: "50%", display: "inline-block",
    border: "1.5px solid color-mix(in srgb, var(--acc) 30%, transparent)", borderTopColor: "var(--acc)",
    animation: "introspin 1s linear infinite",
  });
  const items = reviewItems(pr);

  return (
    <>
      <span style={hairline(9)} />
      <button ref={chipRef} onClick={() => setOpen((o) => !o)} title={`PR #${pr.number}: checks and review`} {...hp("chip")}
        style={{ display: "inline-flex", alignItems: "center", gap: 5, flex: "none", height: 12, boxSizing: "border-box", padding: "0 5px", appearance: "none", cursor: "pointer", border: `1px solid ${tone.border}`, background: tone.bg, color: tone.fg, fontFamily: "var(--mono)", fontSize: "var(--t9)", letterSpacing: ".6px", lineHeight: 1, filter: hov === "chip" || open ? "brightness(1.2)" : undefined }}>
        <span style={{ color: tone.num }}>⇡ #{pr.number}</span>
        {lab.spin && <span aria-hidden style={spin(7)} />}
        {lab.text}
        <span aria-hidden style={{ opacity: 0.7 }}>▾</span>
      </button>
      {open && createPortal(
        <div ref={popRef} className="mscroll"
          style={{ position: "fixed", top, left, width: 430, maxHeight: `calc(100vh - ${top + 16}px)`, overflowY: "auto", zIndex: 80, fontFamily: "var(--mono)", border: "1px solid color-mix(in srgb, var(--acc) 40%, transparent)", background: "color-mix(in srgb, var(--panel2) 99%, transparent)", boxShadow: "0 14px 40px var(--shadow-pop)", animation: "mslide .16s ease both" }}>
          <div style={{ padding: "10px 12px 8px" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: "var(--t9)", letterSpacing: 1.3 }}>
              <span style={{ color: tone.ink }}>{tone.glyph}</span>
              <span style={{ color: "var(--txb)" }}>PR #{pr.number}</span>
              <span style={{ color: "var(--txl)" }}>· {stateLine(pr)}{pr.state === "MERGED" && pr.merged_at ? ` · ${sinceIso(pr.merged_at)}` : ""}</span>
              <span style={{ flex: 1 }} />
              <a href={pr.url} target="_blank" rel="noreferrer" {...hp("gh")} style={{ color: hov === "gh" ? "var(--txb)" : "var(--txm)", textDecoration: "none" }}>GITHUB ↗</a>
            </div>
            <div style={{ fontSize: "var(--t12)", color: "var(--txb)", margin: "5px 0 3px" }}>{pr.title}</div>
            {pr.state === "OPEN" && (
              <div style={{ fontSize: "var(--t95)", color: "var(--txl)", display: "flex", flexWrap: "wrap", gap: 6 }}>
                <span style={{ color: "var(--purple-d)" }}>⎇ {pr.head} → {pr.base}</span>·
                <span style={{ color: "var(--ok)" }}>+{pr.additions}</span><span style={{ color: "var(--err)" }}>−{pr.deletions}</span>·
                <span>opened {sinceIso(pr.created)}</span>
              </div>
            )}
          </div>

          {pr.state === "OPEN" && pr.total > 0 && (
            <div style={sect}>
              <div style={head}>
                CHECKS <span style={{ color: "var(--txh)" }}>{pr.passed + pr.failed}/{pr.total}</span>
                {pr.failed > 0 && <span style={{ color: "var(--err)" }}>· {pr.failed} FAILING</span>}
                <span style={{ marginLeft: "auto", letterSpacing: ".5px" }}>↻ {since(snap.checked)}</span>
              </div>
              {pr.checks.map((c) => (
                <div key={`${c.workflow}/${c.name}`}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: "var(--t105)", padding: "3px 0" }}>
                    <span style={{ width: 12, flex: "none", display: "flex", justifyContent: "center", color: c.state === "fail" ? "var(--err)" : "var(--ok)" }}>
                      {c.state === "run" ? <span aria-hidden style={spin(9)} /> : c.state === "fail" ? "✕" : "✓"}
                    </span>
                    <span style={{ flex: 1, minWidth: 0, color: c.state === "fail" ? "var(--err-hi)" : "var(--txh)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{c.name}</span>
                    <span style={{ color: "var(--txl)", fontSize: "var(--t95)", flex: "none" }}>{duration(c.started, c.completed, Date.now())}</span>
                    {c.url && <a href={c.url} target="_blank" rel="noreferrer" {...hp(`log:${c.name}`)}
                      style={{ flex: "none", fontSize: "var(--t85)", letterSpacing: 1, textDecoration: "none", padding: "1px 5px", border: "1px solid color-mix(in srgb, var(--acc) 22%, transparent)", color: hov === `log:${c.name}` ? "var(--txb)" : "var(--txm)" }}>LOG ▸</a>}
                  </div>
                  {c.state === "fail" && c.log && (
                    <div style={{ margin: "3px 0 7px 20px", borderLeft: "2px solid color-mix(in srgb, var(--err) 50%, transparent)", background: "color-mix(in srgb, var(--err) 5%, transparent)", padding: "4px 9px", fontSize: "var(--t95)", lineHeight: 1.55, color: "var(--txd)", whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
                      {c.log.split("\n").slice(-6).join("\n")}
                    </div>
                  )}
                </div>
              ))}
              {pr.failed > 0 && <button onClick={() => send(failureMessage(pr))} {...hp("sendfail")} style={wide("var(--err)", "sendfail")}>SEND FAILURE TO AGENT ▸</button>}
            </div>
          )}

          {pr.state === "OPEN" && (pr.review || pr.requested.length > 0 || pr.reviews.some((r) => r.state === "APPROVED")) && (
            <div style={sect}>
              {pr.review ? (
                <>
                  <div style={head}>REVIEW · <span style={{ color: "var(--txh)" }}>{pr.review.by.toUpperCase()}</span> · {items.length} COMMENT{items.length === 1 ? "" : "S"} · {sinceIso(pr.review.at)}</div>
                  {items.map((c, i) => (
                    <div key={i} style={{ borderLeft: "2px solid color-mix(in srgb, var(--warn) 60%, transparent)", background: "color-mix(in srgb, var(--warn) 5%, transparent)", padding: "5px 9px", marginBottom: 6, fontSize: "var(--t105)", lineHeight: 1.45, color: "var(--txh)" }}>
                      {c.path && <span style={{ display: "block", fontSize: "var(--t9)", letterSpacing: ".4px", color: "var(--warn)", marginBottom: 1 }}>{c.path.split("/").pop()}{c.line ? `:${c.line}` : ""}</span>}
                      <span style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{c.body}</span>
                    </div>
                  ))}
                  {items.length > 0 && <button onClick={() => send(commentsMessage(pr))} {...hp("sendrev")} style={wide("var(--warn)", "sendrev")}>SEND {items.length} COMMENT{items.length === 1 ? "" : "S"} TO AGENT ▸</button>}
                </>
              ) : (
                <>
                  <div style={head}>REVIEW</div>
                  {pr.requested.map((who) => (
                    <div key={who} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: "var(--t105)", color: "var(--txd)", padding: "2px 0" }}>
                      <span style={{ width: 18, height: 18, borderRadius: "50%", flex: "none", display: "grid", placeItems: "center", fontSize: "var(--t75)", color: "var(--txb)", background: "color-mix(in srgb, var(--txl) 40%, transparent)" }}>{initials(who.replace(/[-_.]/g, " "))}</span>
                      requested from {who} · no review yet
                    </div>
                  ))}
                  {pr.reviews.filter((r) => r.state === "APPROVED").map((r) => (
                    <div key={r.by} style={{ fontSize: "var(--t105)", color: "var(--ok)", padding: "2px 0" }}>✓ approved by {r.by}</div>
                  ))}
                </>
              )}
            </div>
          )}

          {pr.state === "MERGED" && (
            <div style={sect}>
              <div style={{ fontSize: "var(--t105)", color: "var(--txd)", lineHeight: 1.5, marginBottom: 9 }}>
                This branch's work is in <span style={{ color: "var(--txh)" }}>{pr.base}</span>. The session and its worktree can go.
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                <button onClick={() => void archive()} {...hp("arch")} style={{ ...wide("var(--purple)", "arch"), marginTop: 0, flex: 1, color: "var(--purple-h)" }}>ARCHIVE SESSION</button>
                {inWorktree && (
                  <button onClick={() => void removeWorktree()} disabled={busy} title={busy ? "a turn is running in it" : undefined} {...hp("rmwt")}
                    style={{ ...wide("var(--txm)", "rmwt"), marginTop: 0, flex: 1, background: "transparent", opacity: busy ? 0.45 : 1, cursor: busy ? "not-allowed" : "pointer" }}>REMOVE WORKTREE</button>
                )}
              </div>
              <div style={{ marginTop: 9, fontSize: "var(--t95)", color: "var(--txl)" }}>Each asks first. Nothing is archived or removed on its own.</div>
            </div>
          )}

          <div style={{ borderTop: "1px solid color-mix(in srgb, var(--acc) 10%, transparent)", padding: "6px 12px", fontSize: "var(--t85)", letterSpacing: 1, color: "var(--txg)" }}>
            CHECKED EVERY 60S WHILE THE SESSION IS OPEN · VIA gh
          </div>
        </div>,
        document.querySelector("[data-theme]") ?? document.body,
      )}
    </>
  );
}
````

- [ ] **Step 2: Terminal: put it in the caption row**

In `bridge/dashboard/web/src/components/hud/Terminal.tsx`, find (around line 17):

````tsx
import { SpendPanel } from "./SpendPanel";
````

Replace it with:

````tsx
import { SpendPanel } from "./SpendPanel";
import { PrChip } from "./PrChip";
````

In `bridge/dashboard/web/src/components/hud/Terminal.tsx`, find (around line 205):

````tsx
  onOpenProject, run, onOpenRun, onDropFiles, chrome, gridRow,
}: {
````

Replace it with:

````tsx
  onOpenProject, run, onOpenRun, onDropFiles, chrome, gridRow, onSendText, onArchive,
}: {
````

In `bridge/dashboard/web/src/components/hud/Terminal.tsx`, find (around line 261):

````tsx
  /** The shell grid rows the chat spans — the footer track too, when nothing
   *  sits under it. */
  gridRow?: string;
}) {
````

Replace it with:

````tsx
  /** The shell grid rows the chat spans — the footer track too, when nothing
   *  sits under it. */
  gridRow?: string;
  /** The PR chip's SEND buttons: a message to this session, queued if it's mid-turn. */
  onSendText?: (text: string) => void;
  /** The PR chip's ARCHIVE SESSION, after a merge. */
  onArchive?: () => void;
}) {
````

In `bridge/dashboard/web/src/components/hud/Terminal.tsx`, find (around line 520):

````tsx
                <span style={{ color: "var(--purple-g)" }}>⎇</span>{branch}
              </button>
            </>
          )}
````

Replace it with:

````tsx
                <span style={{ color: "var(--purple-g)" }}>⎇</span>{branch}
              </button>
            </>
          )}
          {/* The branch's PR (review loop B/C). Draws nothing, hairline included,
              until the bridge reports one. */}
          {branch && sessionId && sessionProject && onSendText && onArchive && (
            <PrChip project={sessionProject} branch={branch} sessionId={sessionId} title={selected?.title ?? ""}
              inWorktree={!!selected?.worktree} busy={!!activeId} onSend={onSendText} onArchive={onArchive} />
          )}
````

- [ ] **Step 3: App: ARCHIVE SESSION that keeps you on the session**

In `bridge/dashboard/web/src/App.tsx`, find (around line 1976):

````tsx
  async function setLifecycle(id: string, state: Lifecycle | null) {
````

Replace it with:

````tsx
  // MERGED ▸ ARCHIVE SESSION (PrChip). Unlike setLifecycle this keeps the
  // chat on the session: the popover's REMOVE WORKTREE is the other half of
  // the cleanup, and loadSessions keeps the open session listed until you
  // leave it.
  async function archiveOpen(id: string) {
    try {
      await api.archiveSession(id);
      await loadSessions();
      notify("info", "Archived. HISTORY keeps it.");
    } catch (e) { notify("error", (e as Error).message); }
  }

  async function setLifecycle(id: string, state: Lifecycle | null) {
````

- [ ] **Step 4: App: pass the chip its two callbacks**

In `bridge/dashboard/web/src/App.tsx`, find (around line 2107):

````tsx
                onDropFiles={(f) => composerFiles.current?.(f)}
````

Replace it with:

````tsx
                onDropFiles={(f) => composerFiles.current?.(f)}
                // PR chip: SEND FAILURE / SEND n COMMENTS go to this session, queued
                // behind a running turn. force skips the relevance hold: the PR
                // is this session's own work.
                onSendText={(text) => void send(text, [], { force: true })}
                onArchive={() => { if (sessionId) void archiveOpen(sessionId); }}
````

- [ ] **Step 5: Typecheck**

Run: `cd bridge/dashboard/web && node_modules/.bin/tsc -p tsconfig.app.json; cd -`
Expected: only the known `remark-breaks` error.

- [ ] **Step 6: Commit**

```bash
git add bridge/dashboard/web/src/components/hud/PrChip.tsx bridge/dashboard/web/src/components/hud/Terminal.tsx bridge/dashboard/web/src/App.tsx
git commit -m "dashboard: PR chip in the chat header — checks, review, merged cleanup

Sheet C's states in the caption row. The popover sends a failure or a
review's comments to the session (queued behind a running turn), links to
GitHub, and after a merge offers ARCHIVE SESSION and REMOVE WORKTREE, each
behind a confirm. Polls every 60s while visible, on focus, and after a
dashboard push. The bell rings for what the bridge pinged, once per browser."
```

---

### Task 10: Whole-branch verification

No new code. This proves the branch works as a whole, including what only pixels can show.

- [ ] **Step 1: Backend suite**

Run: `python3 -m pytest tests/ -q`
Expected: `1495 passed, 2 skipped`.

- [ ] **Step 2: Every web check**

Run: `for f in bridge/dashboard/web/src/lib/*.check.ts bridge/dashboard/web/src/chat.check.ts; do node "$f" >/dev/null || echo "FAILED $f"; done`
Expected: no `FAILED` lines.

- [ ] **Step 3: A private node_modules, then a clean typecheck and a build**

Remove only the symlink, with no `-r`, and install a full tree from the lockfile:

```bash
cd bridge/dashboard/web
test -L node_modules && rm node_modules
npm ci --no-audit --no-fund
node_modules/.bin/tsc -p tsconfig.app.json && echo TSC-CLEAN
node_modules/.bin/vite build
cd -
```
Expected: `TSC-CLEAN` (no errors now that `remark-breaks` is installed), then `✓ built in …`. `dist/` and `node_modules/` are both git-ignored, so `git status` stays clean.

- [ ] **Step 4: Start a scratch dashboard from the worktree**

This uses its own port, its own DB and no Telegram token. It never touches the live bridge on 8790.

```bash
rm -f /tmp/plan-rl.db*
env TELEGRAM_BOT_TOKEN= ALLOWED_CHAT_IDS=555 DASH_CHAT_ID=555 NOTIFY_ENABLE=0 \
    BRIDGE_DB=/tmp/plan-rl.db DASH_PORT=8899 DASH_TOKEN= BASE_PATH=$HOME/projects \
    python3 -c "import time; from bridge import store; store.init(); from bridge.dashboard import server; server.start(); time.sleep(3600)" \
    > /tmp/plan-rl-server.log 2>&1 &
until curl -sf -o /dev/null http://127.0.0.1:8899/local/state; do sleep 0.5; done
```

- [ ] **Step 5: Two scratch sessions to look at**

Creating a session row on a scratch server may need the user's OK in this harness. Ask if it is blocked. **Never send a prompt from this server.** SEND buttons there start real Claude runs.

```bash
curl -s -X POST -H 'Content-Type: application/json' \
  -d '{"project":"ainurhq/rivendell","cwd":"'$HOME'/projects/.worktrees/rivendell/slideshow-templates","title":"Slideshow templates"}' \
  http://127.0.0.1:8899/local/sessions
curl -s -X POST -H 'Content-Type: application/json' \
  -d '{"project":"mystical-assistant","cwd":"'$PWD'","title":"Review loop"}' \
  http://127.0.0.1:8899/local/sessions
```

Note both `session.id`s. `slideshow-templates` has merged PR #49 (ainurhq/rivendell), so it shows the MERGED chip. `feat/review-loop` has no PR, so it shows no chip.

- [ ] **Step 6: B/C: the chip and the MERGED popover**

`shot2.mjs` lives in the main checkout's `.mystical/probe/`. Run it, but don't edit it. Its arguments are `<url> <out.png> <w> <h> <waitMs> [seedJSON] [evalJS] [wait2Ms]`. Seeding `hud-last-session` opens that session on load.

```bash
P=$HOME/projects/mystical-assistant/.mystical/probe/shot2.mjs
node $P 'http://127.0.0.1:8899/?skipboot=1' /tmp/rl-chip.png 1280 800 5000 '{"hud-last-session":"<slideshow id>"}'
node $P 'http://127.0.0.1:8899/?skipboot=1' /tmp/rl-pop.png 1280 800 5000 '{"hud-last-session":"<slideshow id>"}' \
  'document.querySelector("button[title^=\"PR #\"]")?.click()' 1500
```

Read both PNGs. Look for:
- `⇡ #49 MERGED ▾` in purple after the branch, inside the 12px caption row and not clipped.
- The popover below the chip, not clipped by the header island: `⇡ PR #49 · MERGED INTO MAIN · …`, the title, ARCHIVE SESSION, REMOVE WORKTREE, the "Each asks first." line and the footer.

**Don't click ARCHIVE or REMOVE WORKTREE.** REMOVE WORKTREE would really delete that worktree.

Then open the review-loop session and confirm there is no chip and no stray hairline.

- [ ] **Step 7: A: notes on the diff, and Review Focus 5**

Make a scratch change to look at: `printf 'one\ntwo\n' >> README.md`. Then drive the modal:

```bash
node $P 'http://127.0.0.1:8899/?skipboot=1' /tmp/rl-notes.png 1280 900 5000 '{"hud-last-session":"<review-loop id>"}' '(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const btn = (t) => [...document.querySelectorAll("button")].find((b) => b.textContent.trim().startsWith(t));
  btn("⊞ PROJECT")?.click(); await sleep(1500);
  btn("GIT")?.click(); await sleep(1500);
  // ⊞ PROJECT opens on the main checkout's branch: switch to this worktree's.
  document.querySelector("button[title=\"switch branch — worktrees marked\"]")?.click(); await sleep(300);
  [...document.querySelectorAll("button")].find((b) => b.textContent.includes("feat/review-loop") && b.textContent.includes("WORKTREE"))?.click(); await sleep(1500);
  const num = [...document.querySelectorAll(".dnote-row")].map((r) => r.children[1]).find((c) => /\d/.test(c.textContent));
  num.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
  window.dispatchEvent(new MouseEvent("mouseup", { bubbles: true })); await sleep(400);
  const ta = document.querySelector("textarea[placeholder=\"what should change here?\"]");
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(ta, "sort groups by client name");
  ta.dispatchEvent(new Event("input", { bubbles: true }));
  ta.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true })); await sleep(400);
  num.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
  window.dispatchEvent(new MouseEvent("mouseup", { bubbles: true })); await sleep(400);
  document.querySelector("textarea[placeholder=\"what should change here?\"]").dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
})()' 1200
```

Read `/tmp/rl-notes.png`. Look for:
- A purple `◆` and a purple number on the noted line.
- The thread `◆ L<n> · YOU · now` with `EDIT · ✕` and the note text.
- `◆1` on README.md's file row.
- The send bar at the panel foot: `◆ 1 NOTE | → ● Review loop ▾ | CLEAR | SEND TO AGENT ▸`.
- **The Project modal still open** after the final Escape. That is Review Focus 5: Esc cancelled the second editor, not the modal.
- Line numbers that match `README.md` in the EDITOR tab.

Hover can't be captured headless (no mouse). Check the `.dnote-row:hover .dnote-plus` rule by reading `index.css` instead. **Don't press SEND here.** Then undo the scratch change: `git checkout -- README.md`.

- [ ] **Step 8: Tear down**

```bash
kill "$(ss -ltnp | awk '/127.0.0.1:8899/ {match($0, /pid=[0-9]+/); print substr($0, RSTART+4, RLENGTH-4)}')"
rm -f /tmp/plan-rl.db* /tmp/plan-rl-server.log
git status --short   # expect nothing
```

Show the user the three screenshots: attach them with `mcp__verify__Attach` if the session has it. Looking at them yourself isn't enough. Don't restart the live bridge, and don't copy `dist/` into the main checkout. Shipping happens after merge, with **bridge-ship**. The Python route needs a bridge restart. The web half needs a rebuild of the main checkout's dist, which first needs `npm install` there for `remark-breaks`.
