# TEAM: shares you've handled move aside, and land in the right place

2026-10-22 · /design-first, approved from mockups (`.mystical/design-drafts/team-shared/`, and
`drafts/team-shared/` in Claude Design) · extends [TEAM](team-share.md) and
[CONTINUE HERE](team-share-continue.md)

## Why

Erfan sent an osanwe session. The user opened it and pressed CONTINUE HERE twice. Both times it
landed under **rivendell**, the open project, because osanwe wasn't cloned and the fallback said
"Continue in rivendell without their code?". The share then sat in SENT TO YOU as a full card, the
same as a new one. The only way to clear it was DISMISS, and DISMISS deletes the read-only copy. The
user asked for three things:

- Opening or continuing a share should mark it and move it to a quiet list in the tab. It should
  stay there for later, and nothing should need deleting.
- A teammate's session you open should go under **Shared**, not under a project.
- A session you continue should open under the same project they sent it from.

## What it does

- **SENT TO YOU** holds only shares you haven't opened or continued (`lib/team` `seen()`). The
  rail's "N new" counts the same list. Rivendell's `unread` used to count unopened shares, so a
  share you had continued without opening still counted as new. That count is gone.
- **SEEN** is the last section of the TEAM tab. It holds the other shares you haven't removed,
  newest first.
  - Each is one line, built like YOU SENT's: a kind icon, the title, the sender's avatar, and a
    stamp, OPENED or CONTINUED.
  - Three show; "N more" shows the rest.
  - Clicking a row opens the share again: the session read only, the picture large, or the file
    downloaded.
  - Hovering or focusing a row swaps the stamp for CONTINUE HERE and remove. Remove is today's
    dismiss: your copy goes.
  - Nothing new is stored, since `team.inbox()` already returns `opened` and `continued`. Expiry is
    unchanged: Rivendell drops a share after 14 days, and the bridge drops its copy then too.
- **Shared** is a group in PROJECTS (`team:shared`, built like `rivendell:jobs` in
  `lib/jobs.jobGroup`). It holds every session a teammate sent.
  - The order setting places it like any project.
  - It has no New button and no project menu, because it isn't one of your folders.
  - Its rows, and the same rows in PLUGINS ▸ FROM TEAMMATES, show the sender's avatar, their name,
    and their project. Before, they printed the "/" folder.
  - Device runs still list only in PLUGINS. ATTENTION and RECENT still leave a teammate's sessions
    out.
- **CONTINUE HERE on a session** runs in your checkout of their repository, or in the checkout
  CLONE & INSTALL makes.
  - Answering no to the clone, a failed clone, or a repository with nowhere to go continues
    nothing, and a note says so ("ainurdev/osanwe isn't cloned here, so nothing was continued.").
  - The fallback to the open project is gone.
  - A picture or a file has no project, so it still continues in the open one.

## Not built

- The Mini App has no TEAM at all, as before.
- A SEEN row doesn't link to the session you continued it into. That session lists under its
  project in PROJECTS.
- SEEN doesn't outlive Rivendell's 14-day expiry.
