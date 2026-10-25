# Changelog v4: one change at a time, with a picture when it only shows in a state

The ask (2026-10-25): "changelog open is not good, maybe add screenshot or gif for cases that in a
specific state will happen; this grouping is not cool; go through changes by topic, not per commit,
no batching; better navigating between them; also suggest." Three directions were drawn in the
user's OSGILIATH from the live rows (`.mystical/design-drafts/changelog-v4/`, git-ignored). The user
picked **C · INDEX** and all three add-ons: a picture in the popup, same area, and play the new ones.

## What was wrong

- **The unit was the update, a batch.** The list showed updates under days, and the reader showed
  one update's five bullets. A change had no page of its own.
- **There was nothing to look at.** "Usage limits — a card while parked" only exists while a login is
  parked, and its Open › went to the USAGE tab, where that card never appears.
- **Places were guessed.** haiku tagged "New session" with the GIT tab.

## Change notes (`docs/changes/`, `bridge/whatsnew.py`)

- **The note.** A change that only shows in a state may bring `docs/changes/<slug>.md`: frontmatter
  `area`, `when`, `place` and `for`, then one sentence. Beside it go `<slug>.webp|png|jpg` (a still,
  and a clip's poster) and/or `<slug>.mp4` (a clip). `docs/changes/README.md` holds the rules: 16:10
  at 2x, a still under 120 KB, a clip under 400 KB, and **staged data only, because the repo is
  public**.
- **At boot, notes come first.** The notes added in `last_head..HEAD` (`changes_in`) come before
  anything else, in their own words. `meta.media` and `meta.when` are columns aligned with the
  bullets, like `go`. haiku is told `ALREADY TOLD, leave out: …`, and a bullet with the same area
  is dropped. The body keeps what fits in 600 characters.
- **`for:` decorates an older row.** A note `for:` a commit of a change that an older row already
  told goes onto that row (`_decorate`). The bullet with its area takes the note's words, place,
  state and picture; if no bullet has its area, the note joins the row. The row is revised in
  place, so the change isn't news twice. A note's place replaces haiku's guess, and no place clears
  it. A commit that no kept row holds is told as new.
- **`retry` keeps the notes.** It rewrites a fallback row with the notes' bullets first (`_notes_of`).
- **The preview tells waiting notes.** The waiting notes carry their words and states but no
  pictures (`shortcut:` in `_write_coming`), and `for:` notes wait for the boot.
- **Seed, and only the seed.** The overnight changes of 2026-10-25 that only show in a state got
  notes and staged pictures: the Answers clip (124 KB), the Asks dock and the Usage limits card
  (emails replaced). Nothing asks later changes for one, on the user's word ("no need to add
  pictures for all, just for last night changes is enough"): each picture is weight in a public repo.

## The media route (`bridge/dashboard/server.py`)

- `/local/changelog/media/<name>` serves one file name from `docs/changes/` of this checkout.
  `MEDIA_NAME` takes no paths, a realpath check stops symlinks leaving the folder, and anything
  else is a 404.
- It answers `Range` (206, or 416), which WebKit's player asks before it plays. Checked in an
  offscreen WKWebView: the clip plays.
- GETs are guarded as every `/local/` read is: Host plus `Sec-Fetch-Site`.

## The popover (`ChangelogButton.tsx`, `lib/notices.ts`, `index.css`)

The popover is 560 × 488, at the same anchor.

- **The list.** One row per change (`changesOf`): each bullet of an update or of COMING. It's flat and newest first, with no day heads and no update batches.
  - A row shows its icon, its area (🖼 for a picture, 🎬 for a clip), one line of words, and its
    time (today's hour, or the date).
  - New changes get a dot.
  - Every row is two lines and 44 px.
- **The reader.** A stage of one size for every change (199 px in this column).
  - What the stage shows:
    - **Picture**: ⤢ opens it in ImageLightbox. The popover hides under it, because they share a
      z-index.
    - **Clip**: muted and looped, with play/pause, CLIP, its progress and its time. Reduced motion
      keeps it still.
    - **No picture, but a place**: a sketch of the app with that rail tab or Settings tab lit.
    - **Neither**: its icon.
  - A chip says **SHOWS WHEN** (the state) or **LIVES IN** (the place).
  - A picture that won't load falls back to what the stage would show without it. An old bridge
    404s.
  - Under the stage come the area, NEW or COMING, the time, and the words. Then the actions:
    Open <place> (the full name is in the tooltip), Ask Claude (`askChange`), and Copy
    (`changeMarkdown`). For COMING the action is Update now. At the foot: "from the 02:16 update ·" commits ↗ and ⎇ branch.
- **Find** filters changes by area and words (`findChanges`) and marks matches in both panes.
- **Keys.** ↑ ↓ step, and the footer has ‹ i of n ›. Escape shuts the lightbox first, then Find,
  then the popover.
- **Add-ons:**
  - **▶ NEW** in the head walks the new changes. A change holds 5 s, and a clip holds until it ends
    (15 s at most). A key, a click, or the pointer entering the panes stops it.
  - **Same area**: "Usage 1 of 2 ‹ ›" at the end of the actions steps through `sameArea` (the
    area's first word). When the row can't hold it, it wraps into the reader's slack, so nothing
    above moves.
  - **The popup** out of the icon leads with the update's first picture, and says "N PICTURES"
    when there are more.
- **Removed (v3):** the week bars, the spine, the day heads, `byDay`, `weekBars`, `nodeSize`,
  `findIn`, `placesOf`, `notesMarkdown` and `askPrompt`.
- **Removed, on the user's word (2026-10-25):** notes for every install, never used: `docs/notes.md`
  was its header alone and no install held a note row. Gone with it: the form, `NoteComposer`,
  `POST /local/update/note`, `whatsnew.add_note`/`notes_in`/`notes_seen`, the `note` kind, NOTE on
  Telegram, and the notes in the waiting update and in UPDATE's popover.
- **Unchanged:** mark-read on close, OS banners, and UPDATE's preview (`Bullets` / `Meta`).

The Mini App has no changelog. Telegram keeps the text.

## Open

- **Repo weight.** The seed is about 230 KB. A picture added later is about 100 KB in git for good;
  if they ever become routine, move the media to the landing site and keep URLs in the notes.
- **Read state is per update**, not per change.
- Changes without a note keep haiku's guessed places.
