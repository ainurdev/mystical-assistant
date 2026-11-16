# Release hub: one rail button for changelog, go live and update

The right rail's foot had four buttons: ⟳ go live, the changelog, UPDATE and ⌘K.
They are now one: the changelog's button (a rune), whose popover keeps the
changelog exactly as it was and pins up to three rows over its changes:

- **Go live** (`LiveReader`): commits on disk that aren't running; rebuild/restart, AFTER N TURNS, the queued wait, a failed build and FIX WITH CLAUDE.
- **Update** (`UpdateReader` side `pull`): commits upstream, with the whatsnew preview; PULL & RESTART.
- **Ship** (`UpdateReader` side `ship`): uncommitted files and unpushed commits; COMMIT & PUSH.

A row shows while it has work (or while it's being read). Picking one reads it like a
change: its steps drawn on the stage (`Flow`), title, details, buttons. Opened plainly,
the popover reads the most urgent row. A job mid-flight holds the popover open and
the selection still.

The icon carries one badge, most urgent first: a failed build (!), a queued go-live
(clock), not-live commits, incoming commits (green), local work (amber dot), unread
changes (dot). Pips under it show which kinds wait once two or more do. The three
pop-outs (a change landed, an update waits, a commit isn't live) all come out of it.

⌘K is gone from the rail; the shortcut and the palette stay. SETTINGS keeps its
UPDATE chip with its own popover; both looks share `useUpdateActions`.

Picked 2026-11-16 from three directions (A tabs, B pipeline, C one inbox): C.
