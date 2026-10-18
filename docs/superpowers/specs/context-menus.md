# Context menus for every element

## Intent

Right-click on anything in the dashboard should offer what that thing can do
and what it carries: the actions hidden behind hover buttons, popovers and
cards, plus copy / open / send-to-Claude rows for its data. Today six element
types have a menu (session, project, issue, turn, clock, terminal), three
panels run their own (FILES rows, EDITOR tree, GIT changes), and everything
else falls to the dashboard menu with a "Browser ›" tail. Inside Mystical.app
that reads as browser options on an app that has no browser, and the composer
itself offers Back / Forward / Reload where Cut / Copy / Paste belong.

The audit that produced this spec, with file:line for every element and
every existing handler, is in `.mystical/docs/context-menu-inventory.md`
(git-ignored; regenerate by re-reading the components if it is gone).

## Goals

1. Every element in the tables below has a typed menu with at least one row
   that is not already a visible button on the element itself.
2. The composer and the EDITOR body get edit rows (Cut, Copy, Paste, Select
   all, Undo, Redo) plus their app rows, instead of the dashboard menu.
3. The two registered-but-empty types (`branch` on WORKTREES rows, `task` on
   TASKS rows) get real rows.
4. A right-click never triggers a left-click action (the lightbox zooms or
   closes on right-click today).
5. In the native apps the "Browser ›" tail lists only rows that work there.

## Non-goals

- The Telegram Mini App (touch; long-press is a different design).
- The MAP tab (an iframe with its own document; the listener never sees it).
- Rows that need git operations the bridge does not have (revert,
  cherry-pick, checkout of a commit, close issue). Rows call existing
  handlers and endpoints; the one new endpoint allowed is noted below.
- Settings rows, tool toggles, mode tabs, lane headers, rail tabs, pickers:
  their actions are visible buttons already; a menu would only repeat them.
- Changing the menu chrome: `components/hud/ContextMenu.tsx` keeps its look,
  its 216px width and its single submenu level.
- Inputs and textareas keep the browser menu (spellcheck, Look Up,
  Services). Shift+right-click keeps reaching the browser menu everywhere.

## Anti-goals

- A menu that repeats the row's own visible buttons and nothing else. Noise
  is worse than no menu.
- More than eight top rows on any menu. The once-a-month rows fold under a
  "More" section, the way the session menu already does.
- Element data copied into the DOM. The DOM carries ids; App state or the
  owning component carries the data.
- A second menu system. One window listener, one `ContextMenu`, two
  patterns (App-built by `data-ctx-type`, or component-built for local
  actions), as today.

## Constraints

- Mechanism stays: `App.tsx` listens for `contextmenu`, reads
  `data-ctx-type` / `data-ctx-id` / `data-ctx-label` off the nearest
  ancestor, builds rows in `ctxItems`; `lib/nativeCtx.ts` rows (selection,
  link, image) lead; "Dashboard ›" and "Browser ›" tail. A component whose
  actions are local state (FilesPanel, EditorTab, GitPanel, and the new
  ones marked *local* below) renders its own `<ContextMenu>` instead.
- Backend is Python stdlib; a new endpoint is a plain handler with a test in
  `tests/`.
- Non-React logic goes in `lib/*.ts` with a `*.check.ts` script
  (`node --experimental-strip-types`).
- Ship path: build in a worktree, copy `dist` over the launch checkout's
  (live on reload). A bridge restart is needed only if a backend endpoint
  lands (slice 3 at most).
- Paste from a custom menu uses `navigator.clipboard.readText()` (localhost
  is a secure context). It has to be verified inside Mystical.app before
  slice 1 ships; if WebKit refuses, the Paste row shows a toast saying ⌘V,
  and the row stays so the menu reads the same everywhere.
- Every new menu is verified headlessly (`.mystical/probe-mac/cdp.mjs` on
  the Mac, bridge-eyes on Linux) and one capture per menu is attached in the
  session before the slice is called done.

## Decided: mechanism changes

- **Enclosing turn.** The listener also records the enclosing turn:
  `CtxState.turn` = `data-ctx-id` of the nearest `[data-ctx-type="turn"]`
  ancestor, so a finer type inside a turn (tool, shot, code, fileref,
  prompt) can reach the turn's events through App's `turns` state.
- **Tool rows.** `RunStream`'s `ActionRow` (and the cards that bypass it:
  ReadCard, WriteCard, SearchCard, WebCard, McpCard, AgentBlock, ToolCard)
  carry `data-ctx-type="tool"` and `data-ctx-id={tool_use id}`. App finds
  the event by id inside the turn and builds rows from the event's own
  fields (name, summary/command, path, output, patch, url). The builder
  decides whether the id goes on the row wrapper or on the card.
- **Editors.** `lib/editorctx.ts`: a tiny registry `register(id, view)` /
  `get(id)` for CodeMirror `EditorView`s. `MarkdownInput` registers as
  `composer`, `EditorTab`'s body as `editor`, each wrapped in
  `data-ctx-type="editor" data-ctx-id=<that id>`. App's `editor` rows call
  `@codemirror/commands` (`undo`, `redo`, `selectAll`) and the clipboard API
  on the registered view. A check script covers the registry and the
  cut/paste helpers against a fake view.
- **Lightbox.** `onUp` returns early unless `e.button === 0`. The lightbox
  wrapper carries `data-ctx-type="shot"` with the current picture's path,
  so its menu is the screenshot menu, not `surface`.
- **Native tail.** `nativeCtxItems` takes `isNativeApp()` into account:
  Back and Forward are dropped; "Open link in new tab" / "Open image in new
  tab" read "Open link in browser" / "Open image in browser" (that is what
  `URLPolicy` makes them do). Print and Select all stay.
- **Type labels.** `TYPE_LABEL` in `ContextMenu.tsx` gets every new type
  (TOOL, SCREENSHOT, CODE, FILE, PROMPT, PR, CHECKPOINT, EDITOR, COMMIT,
  REF, BRANCH, TASK, TAB, NOTICE, QUEUE, SKILL, LESSON, RIVENDELL, TERMINAL
  TAB). Unknown types must never show as "DASHBOARD" again: the fallback is
  the type name upper-cased.
- **Feed-to-Claude rows** use the existing `feed(lines, project)` /
  `quote(text)` / `send(text, images)` helpers; a row that sends a prompt
  says so in its hint ("runs a turn in this session").

## Decided: the menus

Rows are listed top to bottom. *(exists)* marks a row that mirrors an
action already reachable somewhere else; it is included because it is
hidden behind hover, a popover or a card. Native rows (selection / link /
image) and the Dashboard › / Browser › tail are implied on App-built menus.

### Chat column

| Element | Type | Rows | Data / handler |
|---|---|---|---|
| Composer body | `editor` id `composer` | Cut · Copy · Paste · Select all · Undo · Redo ─ Attach file… *(exists)* · Insert file mention (`@`) · Clear draft (confirm if >1 line) | registered EditorView; attach = the composer's own file input; Clear = empty the draft |
| EDITOR body | `editor` id `editor` | Cut · Copy · Paste · Select all · Undo · Redo ─ Format document *(exists)* · Go to symbol… *(exists)* · Find in files *(exists)* ─ Send selection to chat (hint: path:line + the selected lines, quoted into the composer) | EditorTab CMDS; selection → `quote("```path:line\n…```")` |
| Bash row | `tool` | Copy command · Copy output · Run again in a terminal *(exists)* ─ Open the WORK zone row (toggle drawer) | event.summary (capped at ~120 chars; use `event.input.command` when the event carries it), event.output; `runCommand` |
| Read / Edit / Write row | `tool` | Open in editor · Open changes (Edit/Write only) · Copy path · Reveal in FILES | event path; `openFileFromPanel` / `openAnalyze(rel, {path})`; reveal = pick FILES tab + expand to path |
| Grep / Glob row | `tool` | Copy pattern · Copy path (when the event has one) | event input |
| WebFetch / WebSearch row | `tool` | Open in browser · Copy URL (fetch) / Copy query (search) | event url/query |
| MCP row | `tool` | Copy call (`server.tool` + input JSON) · Copy result | event |
| Agent row | `tool` | Copy brief · Copy agent id | event |
| Screenshot thumbnail, and the lightbox picture | `shot` | Attach to composer (re-send to Claude) · Copy saved path · Open in lightbox (thumb only) · native image rows lead | path, `api.attachmentUrl(path)`; attach = push onto the composer's images like a paste |
| Code block | `code` | Copy code *(exists)* · Quote in composer · Send to chat ("…what about this code?" draft) | the block's text + lang |
| `path:line` ref | `fileref` | Open in editor *(exists on click)* · Open changes · Copy path · Copy path:line · Reveal in FILES | the ref's path + line; `openFileRef` |
| Prompt bubble (and steer bubble) | `prompt` | Copy prompt *(exists)* · Edit in composer (puts the text in the draft) · Send again *(exists)* · Jump to this turn's checkpoint | turn.prompt / steer text; `jumpToMark` |
| ANSWER box, prose bubble | `turn` (unchanged) | existing rows + Quote in composer for the selection when one exists | — |
| PR chip | `pr` | Open on GitHub · Copy PR URL · Copy branch ─ Resolve in a new session (conflicts only) · Send failure to agent (failed checks only) ─ More › Archive session · Remove worktree | PrChip's own data and handlers (move the popover's handlers up or let PrChip build a *local* menu) |
| Checkpoint row (TURNS list) | `mark` | Jump *(exists on click)* · Copy sha · Copy prompt | mark id, sha, label |
| Composer attachment chip | `attachment` | Open *(exists)* · Remove *(exists)* · Copy image (native) | data: URL |
| History row | `session` | the existing session menu, unchanged | HistoryView rows carry session ids already |

### Left rail and strip

| Element | Type | Rows | Data / handler |
|---|---|---|---|
| Project group header | `project` (existing) | existing rows + Copy path · Open terminal here · Hide project (hint: Settings › Projects shows it again) · Collapse / Expand | rel; `openAnalyze(rel,-,"terminal")`; `onSetHidden` |
| Session row | `session` (existing) | unchanged | — |
| Notification row (feed) | `notice` (*local* in Notifications.tsx) | Open *(exists)* · Mark read / Mark unread · Dismiss · Open PR (when `pr_url`) · Copy text | notice id, meta; `api.noticesRead` |
| NEEDS YOU row | `notice` | Open session · Allow / Deny or the answers *(exist)* · Dismiss | job_id, request_id; `api.respond` |
| Bell button | `bell` | Mark all read *(exists)* · Notify settings… *(exists)* | — |
| Git popover rows / branch line | `gitbranch` | Copy branch · Copy upstream · Push / Pull *(exist)* · Open on GitHub (when the remote is known) | repo, branch, upstream; `remotes[rel]` |
| UPDATE button | `update` | Check now · Pull & restart *(exists)* · Copy pending commits | UpdateButton state |
| Rivendell queue row | `rvqueue` | Accept · Reject *(exist on hover)* · Open link · Copy key | instance_id, key, request_id, link |

### Right rail and modals

| Element | Type | Rows | Data / handler |
|---|---|---|---|
| Commit row (CommitGraph) | `commit` | Copy sha · Copy subject · Open on GitHub (when the remote is known) · Ask Claude about this commit (feeds `git show <sha>` + "explain / review") · Show files *(exists on click)* | sha, subject; `remotes[rel]`; `feed` |
| Ref chip | `ref` | Checkout branch (local refs only; `api.checkout`) · Copy name · Open on GitHub (remote refs) | ref name |
| Branch pill (GIT head) | `gitbranch` | Copy branch · Push / Pull *(exist)* · Refresh *(exists)* · Open on GitHub | GitPanel status |
| Open-file tab (EDITOR) | `tab` (*local*) | Close · Close others · Close all · Close saved ─ Copy path · Reveal in explorer · Pin / Unpin *(exists on double-click)* | EditorTab tab state |
| Search hit (EDITOR find) | `fileref` | Open · Copy path:line | path, line |
| WORKTREES branch row | `branch` (existing registration) | Checkout · Open worktree · Attach session · Merge into… (submenu of targets) · Copy branch name ─ Delete branch (danger, confirm) *(all exist inside the expanded row)* | WorktreesTab handlers; needs `onCtx` props or a *local* menu |
| TASKS row | `task` (existing registration) | Feed to Claude · Ship it (worktree session) · Open in tracker · Copy key · Post update… *(all exist in the detail view)* | AnalyzeModal task data; `url` |
| ISSUES row | `issue` (existing) | existing rows + Open on GitHub · Ship it · Copy title | `Issue.url`, `branchForIssue` |
| Skill row (installed) | `skill` (*local*) | Update · Remove *(exist)* · Copy `/name` | skill id |
| Lesson row | `lesson` (*local*) | Open *(exists)* · Feed to Claude · Copy title | lessonKey |
| Rivendell task card | `rvtask` (*local*) | Implement · Work on it · Open in Rivendell · Copy key · Open session (when one exists) *(all exist in the card / peek)* | task id, url, session_id |
| Queue item row (QUEUE tab and composer chips) | `queue` (*local* / composer) | Run next · Edit in composer · Remove · Copy text · Open session | item id, session_id; `api.queueOp` |
| Terminal tab (AnalyzeModal) | `termtab` (*local*) | Close *(exists)* · Close others · Copy cwd | id, cwd_rel |
| Project row in Settings › Projects | — | none (buttons are visible) | — |

The only endpoint this spec allows adding: **mark one notice unread**
(`api.noticesRead` today only marks read). If the builder finds the feed
has no unread flag worth keeping, drop the row instead of adding the
endpoint.

## Slices

1. **Broken first.** Composer and EDITOR body menus, `branch` and `task`
   rows, the lightbox button check, the native tail, TYPE_LABEL fallback.
   Ships by dist copy; nothing backend.
2. **Chat column.** The enclosing-turn mechanism, tool rows, screenshots and
   lightbox, code blocks, file refs, prompt bubble, PR chip, checkpoints,
   history rows, composer attachments.
3. **Rails and modals.** Project group extras, notifications, bell, git
   popover and branch pill, UPDATE, Rivendell queue, commits and refs,
   editor tabs and search hits, issues extras, skills, lessons, Rivendell
   cards, queue rows, terminal tabs.

Each slice: worktree, checks + `tsc` + the full pytest suite green, headless
captures attached, merge to master, dist copy.

## Calls made after the builder check

These were the builder's open questions; each is settled here so the plan
can start. Veto any of them before slice 1.

1. **Tool rows copy the real thing, not the summary.** A stored `tool`
   event carries only a summary (the first of command / path / pattern /
   url / query, cut at 120 characters) and `tool_done` carries output only
   for Bash. "Copy command" on a long script would copy a stub. So the
   bridge widens the stored events: `tool` gains `input` (the call's input
   JSON, capped at 4 KB) and `tool_done` gains `result` (the tool's text
   result, capped at 2000 characters like Bash output). `bridge/runner.py`
   and `bridge/transcript_jsonl.py` write them, tests cover both, and the
   store needs no schema change (events are JSON). Old turns keep their
   summaries; on those the copy rows carry the hint "first 120 chars". This
   makes slice 2 a backend change with a bridge restart.
2. **Ref chip "Checkout" only in the main checkout's graph.** `api.checkout`
   switches the project's main checkout whatever worktree the graph shows,
   which could flip a branch under a running session. The row is absent
   when the graph is mounted for a worktree branch; the rail's GitPanel and
   the modal both know which. No worktree-aware endpoint.
3. **History rows get a trimmed session menu, built from the row's own
   data.** Open (via `openFromHistory`), Rename…, Reopen / Abandon (from
   the row's own `lifecycle`), Copy name. Not the full session menu: those
   rows are not in App's `sessions` list, so the limit, compact and tools
   rows would act on a session the list does not know.
4. **Paste matches ⌘V.** The row reads with `navigator.clipboard.read()`:
   image items go to the composer's `addFiles` (the same path ⌘V takes),
   text goes into the view. If the browser refuses (WebKit may), the row
   shows the ⌘V toast. The Mystical.app verification gate covers both
   kinds.

## Left to the builder

- Exact placement of `data-ctx-*` on each row (wrapper vs card) and the
  id scheme for tool rows.
- Whether a component-built menu gets the native rows and the Dashboard /
  Browser tail (today the three local menus skip them; keeping that is
  fine).
- The shape of the editor registry and the clipboard helpers, and how the
  Paste fallback toast is worded.
- Row icons (pick from the glyph set the existing menus use) and hints.
- The order of work inside a slice.
