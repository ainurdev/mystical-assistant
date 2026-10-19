# TEAM: see which teammates are on, and send them sessions, pictures and files (design)

2026-10-19 · approved in chat with scope **sessions, pictures and files** · mockups in
`.mystical/design-drafts/team-share/` (git-ignored) and in Claude Design at
`drafts/team-share/` · two repositories: this bridge, and Rivendell (`ainurhq/rivendell`)

## Problem

Rivendell knows whose Mystical is connected right now (`AgentGateway.isOnline`), but nobody can
see it. The only way to show a teammate a session is **Share read-only link**, which opens only on
this machine, because the dashboard binds 127.0.0.1. Pictures and files have no way out at all.

## What it does

- **TEAM tab.** A new right-rail tab with a lucide `Users` icon, shown while a Rivendell instance is
  linked. It covers the whole bridge rather than one project. The rail badge counts unopened items
  sent to you. It has four parts:
  - **SENT TO YOU:** one card per item: who sent it and when, the kind label (SESSION, PICTURE or
    FILE), the title, the note as a quote, and its facts. For a session the facts are project,
    branch, turns, pictures and code. For a picture there is a thumbnail. For a file, name and
    size. The buttons are OPEN, CONTINUE HERE and ✕.
  - **ON NOW:** teammates whose Mystical is connected, with "since HH:MM", a `MAC` chip when they
    share a device with you, and SEND on hover, which sends the open session.
  - **AWAY:** "last on …", or "no Mystical linked yet". Sending still works; the item waits.
  - **YOU SENT:** your last three sends and how far each got: WAITING, DELIVERED, OPENED <age>,
    CONTINUED.
- **Sending.** You can send from three places, and all of them end in one send sheet:
  - A session's right-click menu ▸ Send to teammate ▸ a person (on now first).
  - The lightbox's send button, which sends that picture.
  - A file's right-click menu in the Files tab ▸ Send to teammate ▸ a person.

  The sheet has TO (a person; you can change it), WHAT (the session, the picture's thumbnail, or
  the file's name and size), a NOTE, and SEND. For a session there is also a SENDS group: the
  transcript always goes, pictures are on by default, and code is off by default. Code is this
  checkout with its uncommitted changes, packed the way device runs pack it (9 MB cap). A shield
  line counts the token-shaped strings that were blanked out, and says .env files never go.
  Footer: "Nothing runs on their side until they choose to continue it."
- **Receiving.**
  - A bell row, plus Telegram where Settings ▸ NOTIFY routes "From teammates" (on by default).
  - OPEN on a session shows it read-only. A bar replaces the composer, styled with JobBar's classes:
    FROM <NAME>, how long ago, "read-only · it ran on <name>'s machine", the note, DISMISS and
    CONTINUE HERE. Each prompt's tag starts with the sender's name.
  - OPEN on a picture opens the lightbox. OPEN on a file downloads it through the browser.
- **CONTINUE HERE** never sends anything. It opens a new session in your checkout of the same
  repository. When code came along, that session sits on a new worktree branch
  `from-<first name>/<slug>`. The transcript (as Markdown) and the pictures arrive as attachments,
  and the opening prompt is an unsent draft. For a picture or a file, CONTINUE HERE opens a new
  session in the active project with the item attached and a draft that quotes the note.

## Rules

- Nothing that comes from a teammate runs without your tap. This is the 2026-10-15 offered-jobs
  rule: no session from someone else runs on your accounts unless you agreed to it.
- A received session is read-only on every path, the same as a device-run view:
  - the runner refuses a turn in it;
  - orphan claiming leaves it alone;
  - `latest_session` never picks it.

  Its events are rebuilt by a feed that keeps no Claude session id and opens no file a line names.
  Pictures are written under names the bridge makes up.
- Token-shaped text is blanked out before upload (`device_side.redact`), and again when a share
  arrives. .env files never go. Code is opt-in.
- A received file is stored in the bridge's state folder (0700), never in a project, and the
  dashboard serves it only as a download.
- People are named by name. The interface never guesses a pronoun.
- Items expire after 14 days. Caps:

  | What | Cap |
  |---|---|
  | Transcript | 8 MB gzipped |
  | Pictures | 20, at 5 MB each |
  | File | 25 MB |
  | Code | 9 MB |

## Not built

- Watching a teammate's running session live.
- Sending to a group.
- The Mini App surface.
- Rivendell's own web bell.
- Presence pushed by websocket frames. The tab polls while it is open.
