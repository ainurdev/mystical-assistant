# Notifications: the UPDATES tab — what changed in Mystical, and notes for every install

Design, 2026-10-18. Extends `docs/superpowers/specs/notifications.md` (the feed, the bell, NOTIFY
routing). Mockups: `.mystical/design-drafts/notif-updates/01-updates.html`, states A–G, 2x crops
in `crops/`. Theme in the mockups: FLINT VIOLET. States B (pending-upstream bar), C and D are the
first draft's; B is dropped below.

## Why

- An update of Mystical is a count on the rail's ↓ button, a list of raw commit subjects in the
  PULL & RESTART popover, and then nothing. The bridge comes back and you find out what changed
  by bumping into it.
- A maintainer has no way to tell the people running Mystical anything — "re-enter the Rivendell
  token after this one", "settings moved". Commits are not read, and Telegram reaches only this
  bridge's own chats.
- Asked for (2026-10-18): a changelog tab that is a "bullet-like summary of features and
  changes", never a copy of the commits; and a tab to write notes that inform others. "Others"
  are other Mystical installs — teammates or anyone — reached through the code they already pull
  (chosen over a Rivendell broadcast and over Telegram).

## What it is

1. **Two kinds of feed row**, both `source: bridge`, `tier: news`, one group `updates`:
   - `updated` — one row per update that landed here: a headline, up to five bullets of features
     and changes, "and n smaller fixes". Each install writes its own at boot, from the commits it
     just pulled.
   - `note` — one row per note a maintainer wrote in `docs/notes.md`. Written at boot when the
     pulled range added a heading to that file.
2. **One tab in the bell, Updates**, after PRs, showing the rows of group `updates`. In All they
   sit in time order among the sessions.

   *My call, not the user's:* one tab for both kinds rather than Updates + Notes. Six chips with
   counts already force the popover from 440 to 464px; a seventh does not fit on one line. Both
   kinds are Mystical talking about itself, and the verb (UPDATED / NOTE) tells them apart. If two
   tabs are wanted: a seventh filter `notes` → `kind === "note"`, chip "Notes", popover ~540px.
3. **Write a note.** The Updates tab's bar slot (where the Rivendell tab shows its link health)
   reads `✎ Write a note for every install ›`. It opens a form in the popover; SEND NOTE appends
   the entry to `docs/notes.md`, commits that one file in the platform checkout and pushes — one
   tap, the way SHIP is one tap. A refused push (no rights, or the checkout is behind) is rolled
   back so nothing is left behind: a local commit on master would make every later PULL &
   RESTART fail on an install that cannot push (the spec reviewer's catch; approved 2026-10-18).
   The author's own row lands at once, already read.
4. **Routing.** Settings ▸ NOTIFY, under THE BRIDGE: "Mystical updated · a note for every
   install" — pop ✓, sound none, Telegram off. `away`/`always` sends the headline and bullets (or
   the note) to this bridge's chats, the way the weekly report does.

## The rows

Same anatomy as every feed row (`ntf-row`).

**`updated`** (state A):
- Source tile: the brand emblem (`assets/emblem.svg` in the design skill, 13px) with the green ✓.
  Verb `UPDATED` in `--ok`, like DONE.
- Title: the headline, ≤ 40 characters ("Device runs, project marks, quieter bell").
- Body: ≤ 5 bullets, one clause each — a bold lead, then what it does, split at the first " — ".
  Not clamped like other bodies. A trailing dim line: "and 4 smaller fixes" (`meta.rest`).
- Meta: `9 commits · 62cc813 → 48451e2 · ⎇ master`. Action: ghost `Commits ↗` to the GitHub
  compare for the range, only when `meta.url` is set.
- Stored: `kind: updated`, `subject: update:<new sha>`, title = headline, body = bullets joined
  by `\n`, `meta = {from, to, commits, branch, rest, url}`.

**`note`** (state F):
- Source tile: the emblem with the accent ▸. Verb `NOTE` in `--acc`.
- Title: the note's title. Body: its text, plain, line breaks kept, not clamped. Meta: `by <author>`.
- Stored: `kind: note`, `subject: note:<heading>` (the heading line without `## `), title, body,
  `meta = {author, date}`.

**Both:** a read row shrinks to its headline like any read row. A click toggles the body open or
closed instead of opening anything — there is no session behind it. The bell stays open.

Toasts and OS banners are the same row component and need no change: a toast shows the bullets.

## Where the words come from — `bridge/whatsnew.py`

`boot()` runs in `main()` after `dream.boot()` (not in discovery mode: no Claude there):

1. `head = git.head_sha(REPO)`, `old = store.get_setting("last_head")`; record `head` as
   `last_head` at once. No `old`, or `old == head`: stop. `old` not an ancestor of `head`
   (`git merge-base --is-ancestor`, a branch switch in a dev checkout): stop, say nothing.
2. Everything else in one daemon thread, best-effort; boot never waits on it. Notes first,
   because the changelog's one-shot takes ~30 s.
3. **Notes.** `git show old:docs/notes.md` (missing → "") and `git show head:docs/notes.md` —
   a new `git.file_at(cwd, sha, path)`; the existing `git.show_file` is a per-commit diff.
   For each entry in the new text whose heading is neither in the old text nor in the setting
   `notes_seen` (a JSON list of headings, the last 200): `emit("note", …)` and add it to
   `notes_seen`. The committed version is read, never the working tree.
4. **Changelog.** `subjects = git log --format=%s old..head` (the newest 80),
   `n = git rev-list --count old..head`. `n == 0`: nothing. `branch = git.current_branch`.
   - `aifeatures.enabled("changelog")`: one haiku one-shot, `runner.run_blocking(
     config.DASH_CHAT_ID, PROMPT + subjects, cwd=REPO, timeout=180, model="haiku",
     skip_pack=True)` — the same call SHIP uses for its commit message. The prompt (tagged
     `native.INTERNAL_ONESHOT_TAG` so the throwaway session stays out of the sessions list) says
     who the reader is — the person who just received the update, not a developer — and asks for
     ONLY compact JSON `{"headline": str, "bullets": [str], "rest": int}`: headline ≤ 40
     characters naming the two or three biggest things, up to five bullets `Lead — what it does
     for them` (lead ≤ 3 words, bullet ≤ 100 characters), biggest first, fixes and chores folded
     into `rest`; plain words, no shas, no file names, no commit jargon. The reply is validated:
     headline cut at 40, bullets cut at five and 100 characters, `rest` a non-negative int or
     `max(0, n - len(bullets))`.
   - Off, or the one-shot fails or returns nothing parseable: headline `"<n> commits pulled"`,
     bullets = the part before the first " — " of up to five subjects (cut at 100),
     `rest = n - len(bullets)`. Nothing is lost, only shorter — and it is the one path that does
     echo commits.
   - `url`: `https://github.com/<owner>/<repo>/compare/<old7>...<head7>` when `git remote
     get-url origin` is a github.com URL, else none.
   - `emit("updated", f"update:{head}", title=headline, body="\n".join(bullets), meta=…)`.
5. **Telegram.** For each kind emitted, if `notices.telegram_ok(kind)`:
   `telegram.send(chat, text)` to every `config.ALLOWED_CHAT_IDS`, text = `UPDATED · headline`
   plus one `• bullet` per line, or `NOTE · title` plus the body. At boot nobody has clicked a
   dashboard yet, so `away` is true and the `away` route sends like `always` — the weekly report
   behaves the same; the default here is `off`.

**What "the update" is.** The range is `last_head..HEAD` at boot: on an install that only pulls,
exactly the commits the last PULL & RESTART or `mystical update` brought in. On a dev checkout
(both of the user's bridges) it is everything committed or pulled since the last restart — mostly
your own commits, and most restarts move some. That is accepted, not worked around: a marker
written before `selfupdate.update()` pulls would lose the hand `git pull` + restart path, and
skipping commits by the local git identity would empty the Mac bridge's row, which pulls the
user's own work. The row is "what changed since the last restart"; on a dev checkout that is a
digest of your own session, which the switch below can turn off.

The AI switch: a new `aifeatures.FEATURES` entry `changelog` (label UPDATE NOTES, env
`CHANGELOG_ENABLE`, default on). It ships on, within the module's rule: a one-shot fires only at
a restart you asked for that found new commits, never on a timer; a restart that moved nothing
spends nothing. Its `about` says so plainly: "fires at a restart that found new commits — pulled,
or on a dev checkout committed here — one haiku call each; off, the row lists the commit
subjects instead". Cost line: 1 haiku call per restart with new commits; tokens: measure after
the first run (the commit-message one-shot, ~32k, is the reference).

`store` keeps `last_head` and `notes_seen` in the bridge's own DB. A test or worktree bridge must
run on its own `BRIDGE_DB` (the bridge-worktree skill's rule already): on the live DB it would
record its own HEAD as `last_head`, and the next live boot would see a non-ancestor and say
nothing.

Fresh install, or the first boot after this ships: `last_head` is recorded and nothing is said
about the past. The first update after that writes the first row.

## The file `docs/notes.md`

Markdown, committed, human-readable on GitHub. A header, then one entry per note:

```
# Notes for every install

A heading per note. Each lands in the bell of every Mystical that pulls it
(bridge/whatsnew.py). Write one from the bell's Updates tab, or by hand in this shape.

## 2026-10-18 · Re-enter the Rivendell token — Mahziyar Erfani

Integrations are plugins now: SETTINGS › PLUGINS › Rivendell. The old token field is gone;
paste the token once there.
```

Parsing (`notes_in(text)`): an entry starts at a line beginning `## `; its body is the lines up
to the next entry, trimmed. The heading is `<date> · <title> — <author>`; a hand-written heading
that doesn't match is the title whole, author "". The heading line is the note's identity: edit a
note's body and nobody is told again; change its heading and it is a new note. Two notes with the
same heading on one day are one note (`shortcut:` comment in the parser).

## Writing a note — `add_note(title, body)`

- Validate: title 1–80 characters, one line; body 0–600 characters, line breaks kept (`emit()`
  caps a body at 600 anyway). Anything else: `400`.
- `author = git config user.name` in REPO ("" when unset), `date` = today.
- Remember the file as it was (its text, or that it was missing). The file missing: write the
  header above. Append `\n## <date> · <title> — <author>\n\n<body>\n`.
- `git.commit_paths(REPO, f"note: {title}", ["docs/notes.md"])` — only that file, so a dev
  checkout's other dirty files stay out — then `git.push(REPO)`.
- The commit or the push fails (no git identity, no rights, the checkout is behind): roll back
  and return git's words. Rollback = `git reset --soft HEAD~1` if the commit was made, `git
  restore --staged -- docs/notes.md`, then put the remembered text back (or delete the file if
  it was missing). Other staged or dirty files are never touched; a hand edit that was already
  in the file comes back with it.
- On success: `emit("note", …, meta={author, date, quiet: True})` and `notices.mark_read([id])`
  — your own note is not news to you: `meta.quiet` keeps it from toasting (`popFor` ignores
  `read`), and no Telegram is sent. Add the heading to `notes_seen`.
- A dev checkout with commits already waiting pushes them too, as SHIP does. The form says so
  before the tap: it reads the rail's update poll (`api.update()`, `ahead`) when it opens. `last_head` is not touched: the next boot's changelog still
  covers everything since the last boot, and `notes_seen` keeps the note from coming back.

**API:** `POST /local/update/note {title, body}` → `{ok, output}` (`output` = git's words on
failure). Token-gated like every `/local` POST. Pushing is what the button says it does; the
standing rule that nothing pushes without the user's say-so is met by the tap.

## The compose form (states F, G)

- Updates tab, bar slot: `✎ Write a note for every install ›` as a quiet link (`.ntf-write`,
  the `.ntf-links` bar's shape).
- Pressing it replaces the list with the form (`.ntf-compose`): a small letter-spaced label
  A NOTE FOR EVERY INSTALL; a title input (maxLength 80, placeholder "Re-enter the Rivendell
  token after this update"); a textarea (maxLength 600, four rows, placeholder "What changed and
  what to do about it. Plain text; it lands in the bell of every Mystical that pulls it."); a
  footer with `SEND NOTE` (primary, disabled until the title has text, "SENDING…" while the
  request runs) and `Cancel`, and the mono hint "commits docs/notes.md · pushes ⎇ master", with
  " · with N commits already waiting" when the update poll says `ahead > 0`.
- Success: the form closes, the list comes back with the new row (read), and the bar reads
  `Sent · every install sees it after its next update` until the tab changes.
- Failure: the bar shows git's words in `--err` (nothing was left behind); the form and its text
  stay.
- Escape closes the form. Click-outside still closes the whole popover (the draft is lost; the
  form is four lines, not an editor).

## Dashboard changes

- `lib/notices.ts`: `Filter` gains `"updates"`; `matches("updates", r)` is `r.group ===
  "updates"` (the other filters stay by source). `needMatches` unchanged — nothing here waits on
  you. Chip "Updates" after PRs, counted like the others. `.ntf-pop` 440 → 464px
  (`max-width: calc(100vw - 24px)` still holds).
- `Notifications.tsx`: `TONE` `updated: "ok"`, `note: "acc"`; `Source` draws the emblem for
  these two kinds (the Truck stays MOVE's); `NoticeRow` renders the bullet list (`.ntf-ul`,
  `.ntf-rest`) for `updated` and an unclamped `.ntf-body.note` for `note`; `metaLine` and
  `RowActions` as above; the click toggles an `opened` set instead of `openRow`; the bar and the
  form.
- `SettingsModal.tsx` NOTIFY_ROWS, THE BRIDGE: `["updates", "Mystical updated · a note for every
  install", "what changed after a pull, and notes the maintainers wrote"]`.
- `api.ts`: `noteUpdate(title, body)`.
- `lib/notices.check.ts`: `matches("updates")` by group; a note row is not Sessions; the chip
  counts it.

## Not in this

- The Mini App (no bell) and the Mac menu bar (news, not NEEDS YOU). Windows: nothing.
- The pending-upstream bar (first draft's state B): the rail's ↓ button already shows the count.
- A version number — the repo has none; the sha range stands in.
- The per-commit list inside the row; `Commits ↗` covers who wants it.
- Editing or deleting a note from the UI — edit the file; a changed heading is a new note.
- Markdown in notes; dismissing or deleting a row (the week's retention applies).

## Build order

1. `bridge/whatsnew.py` (`notes_in`, `boot`, `add_note`, the prompt and the fallback),
   `notices.CATALOG`/`VERBS`/`DEFAULTS`, the `changelog` AI switch + `config.CHANGELOG_ENABLE`.
   Tests on a throwaway clone (`tests/test_selfupdate.py`'s pattern) with the one-shot
   monkeypatched: first boot records only; a pull with a new heading emits one `note` and one
   `updated` with fallback bullets; same head emits nothing; a non-ancestor head emits nothing;
   `add_note` appends, commits only that file, emits read, and a later boot doesn't repeat it.
2. `POST /local/update/note` in `bridge/dashboard/server.py`; endpoint tests for validation and
   the happy path.
3. Dashboard: filter + chip + width, the two row renderings, the toggle, the bar and form, the
   NOTIFY row, `notices.check.ts`.
4. The `boot()` call in `claude_telegram_bridge.py`.
5. `docs/notes.md` with its header only; the first note is the user's to write.

## Left to the builder

- Exact CSS values for `.ntf-ul`, `.ntf-rest`, `.ntf-compose` — follow the mockup and the
  existing `ntf-` rules.
- The one-shot's tokens line in the AI tab, measured after the first real run.
- Whether `notes_in` tolerates `#`-prefixed lines inside a body (treat only `## ` as a heading).
