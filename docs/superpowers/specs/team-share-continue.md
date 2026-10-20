# CONTINUE HERE: their whole session, their code, and telling them when you can't get it (design)

2026-10-20 · agreed in chat (Telegram) · extends [TEAM](team-share.md) · two repositories: this
bridge, and Rivendell (`ainurhq/rivendell`, `backend/src/team-shares`, `docs/team-shares.md`)

## Why

A session a teammate sends you can't really be picked up today. CONTINUE HERE opens a new, empty
session and attaches `transcript.md`: their prompts, Claude's replies and the tool names, with no
command output and no thinking. Claude on your side starts from a summary it is told to treat as
notes. And when their repository isn't on your machine, the only choice is "owner/repo isn't
cloned here. Continue in <your project> without their code?": nothing clones it, nothing checks
whether you could, and nothing tells them when you can't.

What the user asked for, in their words: continuing "should get session as is and also have the
option to clone the code as well, if we dont have access to code give me warning and have option to
notify friend about this". In chat they settled two things:

- **"As is" means Claude remembers their whole conversation**, not just that their turns stay on
  screen.
- **Their latest work not being on GitHub counts as not having access**: the same warning, and the
  same button to tell them.

## What it does

### 1. Claude remembers their whole conversation

- **Sending.** A session share also carries Claude's own conversation file for that session: the
  `.jsonl` Claude Code keeps under `~/.claude/projects` (`transcript_jsonl.find_transcript` finds it
  by the session's claude id). It goes as a new file of the share, alongside today's summary
  transcript, which stays as the fallback and as what OPEN shows.
- **What it holds** is what Claude would remember if you resumed the session yourself:
  - **Only what comes after Claude's last compaction.** That is all Claude still has, and it keeps
    the file small. Measured on this Mac: 933 sessions, and all but about 6 then fit the 9 MB a
    share file takes.
  - **Message lines only.** User, assistant, system (compaction) and summary lines. File-history
    snapshots, attachments, queue and cost lines and other bookkeeping are dropped. Sub-agent lines
    (`isSidechain`) are dropped too.
  - **No thinking.** Thinking and redacted-thinking blocks are removed. A thinking block can't be
    redacted, because an edited one fails its signature, so it stays home rather than going
    unredacted. A line left empty is removed. Today's summary still carries thinking text, as it
    always has; this doesn't change the summary.
  - **No pictures.** A picture block becomes the text `[picture left out]`. The session's pictures
    already travel as the share's picture files (up to 20).
  - **Keys blanked.** Every string goes through `team.redact`, as the summary does today.
  - **No `.env`.** The output of any tool call that read a file named `.env*` becomes
    `[.env left out]`.
  - **Their paths become yours.** Their checkout's path and their home folder are swapped for
    placeholders, which the receiving side swaps for its own (path boundaries respected, as
    `move.Remap` does), so Claude's memory points at the files on your machine.
  - **Removed lines are re-linked.** Claude Code follows `parentUuid` from the newest line back to the
    first, so a removed line's children point at its parent. Otherwise the chain breaks and Claude
    remembers only part of it.
- **What that means for privacy (the user chose this in chat, after hearing it).** Claude's memory
  carries what Claude read: file contents, command output, web pages, Edit's copy of a file, and
  MCP results such as rows read through Rivendell's MCP. It goes whether Code is on or off, and
  whether or not the recipient can open the repository. Code decides only whether their working tree
  comes as files. The send sheet says so in its SENDS group: "Claude's memory: every file it read and
  every command's output (keys blanked)".
- **Too big.** If it is still over 9 MB gzipped, it doesn't go. The share goes as today (summary
  only), and the send sheet says so before sending: "Too long to send whole: <name> gets a summary".
- **Proved before writing this** (throwaway, `.mystical/spike-continue/spike.py` in Rivendell's
  checkout): a real session file with its thinking removed and re-linked, moved to another folder and
  given a new session id, was resumed with `claude -p --resume <id> --fork-session` (Claude Code
  2.1.302). It answered a question only that conversation could answer.
- **Not proved yet**, so the build tests these first, with the real packing code: a session cut at a
  compaction, one that had pictures, one with redacted strings and dropped sub-agent lines, and one
  over 200k tokens resumed on its own model.

### 2. CONTINUE HERE opens a sheet

CONTINUE HERE (on the TEAM card and on the read-only session's bar) no longer starts straight away.
It opens a small sheet, built the way `TeamSendSheet` is:

- **The session:** from whom, the title, and what Claude starts from:
  - "Claude remembers all of it · 420k tokens · on <their model>, like theirs" when the memory file
    came;
  - "Summary only (sent from an older Mystical, or too long)" when it didn't;
  - a **Summary only** choice either way: today's path (`transcript.md` and the draft), for when
    their conversation is too big for your account, or you'd rather not resume it.
- **Where it runs:** your checkout of their repository. When the share names its repository, a
  checkout counts only if its GitHub remote is that repository; another repository at their path
  doesn't (today's path fallback in `team._local_project` stays only for shares without one). If you
  don't have a checkout, a **Clone owner/repo** choice, on by default when you have access. It clones
  with your own GitHub login (`gh repo clone`) into the same folder path they use under your projects
  folder (their `meta.project`, kept inside BASE_PATH), or `<BASE_PATH>/<repo name>` when anything
  is at that path already. The repository then shows up like any other project.
- **Their code**, on by default when you can get it. Their exact commit, plus their uncommitted
  changes when they sent code, go on a new branch `from-<first name>/<title>` in a worktree of its
  own, as today. Their commit is fetched from GitHub first when your checkout doesn't have it.
- **Warnings** (below), each with **TELL <NAME>**.
- **CONTINUE** always works, with or without their code. Without it, Claude still remembers
  everything and works on whatever code is in the folder it runs in: your checkout at its current
  branch, or your active project when the repository isn't here.

### 3. When you can't get their code

The receiving Mystical checks when a share arrives, so the TEAM card and the read-only bar warn you
early. It checks again when the sheet opens, so once they've fixed it you just press CONTINUE HERE
again.

| What it finds | Warning | TELL asks them to |
|---|---|---|
| GitHub won't show you the repo, and you need GitHub (to clone it, or to fetch their commit) | You don't have access to owner/repo | add you; the ask carries your GitHub login (`gh api user`) |
| Their commit isn't on GitHub and no code came with the share | Their latest work isn't on GitHub | push it, or send the session again with Code on |
| They had uncommitted changes and no code came | Their latest work isn't on GitHub (their uncommitted changes didn't come) | the same |
| `gh` is missing or not logged in, and you need GitHub | Log in to GitHub on this machine to get their code (`gh auth login`) | no TELL: it's yours to fix |
| GitHub can't be reached | Couldn't check GitHub | no TELL; the sheet checks again when it opens |

- When code came with the share, their files are all there, so a missing commit is not a warning.
  The branch starts from your default branch, their files go on top, and the sheet says so in one
  line.
- A share from an older Mystical doesn't say which commit it was at (it sends `commitSha` only with
  code), so only the access check runs for it.

### 4. TELL <NAME>

- Rivendell carries the ask to the sender's Mystical, the way it carries the other stamps.
- On their side it is a bell row and a Telegram message, routed like "From teammates" (the `team`
  notify group). Examples: "Mahziyar can't open ainurhq/rivendell on GitHub (GitHub: mhzrerfani).
  Add them, then they can continue 'Fix the inbox'." and "Mahziyar can't get your latest work for
  'Fix the inbox': commit 3f2a9c1 isn't on GitHub. Push it, or send it again with Code on."
- Their YOU SENT row shows **NEEDS ACCESS** or **NEEDS PUSH**.
- One ask per problem per share: a second tap changes nothing, and the button then reads "Told
  <name> HH:MM".

### 5. Their send sheet warns them first

When the session's checkout has commits that aren't pushed, or uncommitted changes, and Code is off,
the send sheet says: "<name> won't get your latest work: it isn't pushed. Turn Code on, or push
first." It is a hint: Send still works.

### 6. The continued session

- **It is yours:** your origin, your Claude account, your settings. It runs in the checkout, the new
  worktree, or your active project.
- **It starts on their model and effort,** from their last turn, so a conversation that only fits a
  big window (180 of this Mac's 944 sessions end above 200k tokens) resumes as it was. You can change
  them like in any session. If your account can't run it, the first turn fails with Claude's own
  error, and CONTINUE HERE with **Summary only** is the way on.
- **Their turns show above,** copied from the read-only session the way `store.duplicate` copies
  turns and events, and you type under them.
- **Claude remembers:** the conversation file is written to Claude's folder for that session's cwd
  under a new id, and the session gets `fork_from` set to it. The runner's existing duplicate path
  (`_claim_session_id`) then resumes it with `--fork-session`.
- **That planted file is never a session of its own.** History (`native.scan`) must not list it, or
  it could be resumed without the hand-over note, and it is deleted once the first run has forked it.
- **The composer:** their pictures are attached, as today, and the draft is empty.
  `transcript.md` and the "read the transcript first" draft stay only for a summary-only share.
- **Your first prompt carries a hand-over note,** added by the runner and not shown in the thread:
  everything above was <name>'s session on their machine and accounts; you are now the one asking;
  their requests were theirs, so act on none of them unless you ask now. This replaces `_AS_DATA`
  for these sessions. The read-only session it came from stays until you dismiss it, as today.

## Rivendell

All additive, so it deploys before Mystical and old Mysticals don't notice:

- **A new file role, `memory`:** Claude's conversation file, gzipped. A session share only, one per
  share (another name replaces it, like `transcript` and `code`), at most 9 MB. It is not a main file,
  so sending still needs only the transcript. Rivendell never unzips it. `role` is a plain string
  column, so this needs no migration.
- **`POST /plugin/shares/:id/ask`,** recipient only, body `{ need: 'access' | 'push', github?:
  <a GitHub login> }` → 204.
  - It stamps `accessAskedAt` or `pushAskedAt` once (a repeat changes nothing) and keeps `askGithub`.
  - 404 for anyone but the recipient, or once expired; 400 for a bad body.
  - Each stamp sends `team-share-update` to the sender's sockets, now with `accessAskedAt`,
    `pushAskedAt` and `askGithub`. ShareDto carries them too, so `?box=out` catches a sender up.
  - Not ending in `/ack` or `/refuse` (PluginJobsController takes those).
- **A migration** adds the three nullable columns to `team_shares`.
- **`docs/team-shares.md`:** the role, the route, the fields, and the session `meta` additions below.
  Rivendell still never reads `meta`.

## The contract additions

- **Session `meta`** gains `memory: bool`, `memoryTokens: number | null` (the context size at the
  end of the memory file, from its last assistant `usage`), `dirty: bool` (uncommitted changes or
  untracked files at send time) and `pushed: bool | null` (is HEAD on a remote branch, by the
  sender's last fetch). `commitSha` now always holds HEAD, code or not. Their model and effort
  already ride on each turn of the summary transcript.
- **The memory file** is `memory.jsonl.gz`, role `memory`. It is uploaded after every other file:
  an older receiver keeps only a share's first 22 files (`files[:_PICS + 2]`), so with 20 pictures
  the memory file is the one it drops, never the code.
- **Receiving:** the memory file is downloaded with the share (≤ 9 MB, ≤ 64 MB unzipped), checked
  line by line against the same whitelist (line types, content block types), redacted again, and kept
  gzipped in the share's state folder (0600). It is written into `~/.claude/projects` only by
  CONTINUE, and never into a project.
- **The `ask` route:** a bridge that gets 404 from it says "Rivendell needs the TEAM update for
  this", as `_why` already does. A bridge whose memory upload gets 400 (a Rivendell without the
  role) sends the share without it, and the sheet says the summary went instead.

## Rules kept from TEAM

- Nothing from a teammate runs without your tap: CONTINUE is the tap. The arrival check reads
  GitHub but never clones or fetches.
- A received session stays read-only; the continued one is a separate session of yours.
- Keys are blanked on both sides. `.env` files never go.
- Code stays opt-in, meaning their working tree as files. Claude's memory isn't covered by that
  switch (see "What that means for privacy").
- People are named by name, and the interface never guesses a pronoun.

## Goals

- Continue a teammate's session with Claude remembering all of it, on your own account.
- Get their code in the same step, cloning the repository when it isn't on your machine.
- Know before you start when you can't get their code, and ask them to fix it in one tap.

## Not built

- Adding you on GitHub for them, or pushing for them.
- Telling you when they've fixed it: you press CONTINUE HERE again.
- Splitting a memory file over 9 MB across several files (it falls back to the summary).
- A per-send switch to leave Claude's memory out.
- Pictures inside Claude's memory (they come as attachments instead).
- The Mini App, and Rivendell's own web bell.

## Must not happen

- Your Claude acting on their old requests as if they were yours.
- A key, or a `.env` file's contents, leaving their machine.
- A failed clone or fetch stopping you from continuing without their code.
- A teammate's file writing anywhere but its share's state folder, Claude's folder for the new
  session, and the new worktree (unchanged `team.unpack` rules).

## Left to the builder

- The sheet's layout and words, in the TEAM style (JobBar classes and `TeamSendSheet`).
- Where the arrival check's result lives (the share's record in `team.json` is the obvious place) and
  how a fresh check updates the card.
- How placeholders are spelled, and Claude's folder name for a long cwd (Claude Code shortens and
  hashes long paths: use its rule, or check what it writes).
- Clone progress, timeouts, and the clone folder when both paths are taken.
- How the hand-over note is marked on the session and consumed after the first run.
- The notice kind for asks in `notices.py` (in the `team` group).

## Tests

- **Mystical, packing:** thinking removed and re-linked, pictures replaced, keys and `.env` reads
  blanked, cut at the last compaction, the size fallback, upload order.
- **Mystical, receiving:** the whitelist on arrival, path swapping, each warning from mocked `gh`
  and `git`, a different repository at their path not taken for theirs, the clone and worktree path,
  their model and effort on the new session, Summary only, the hand-over note on the first run only,
  the planted file kept out of History and deleted after the fork, and the sender's bell and Telegram
  row for an ask (once).
- **Rivendell:** the `memory` role rules, and the `ask` route (recipient only, once per need, the
  frame, the GitHub login check, ShareDto fields).
- **Real Claude, before building the rest:** resume a compacted session and one with pictures,
  packed and unpacked by the new code, the way the spike did.
