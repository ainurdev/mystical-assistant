# Update coming: what a waiting update brings, before it's taken

**Ask (2026-10-23, /design-first):** "we want notify people using mystical before they get
update, see what is coming to their mystical, how can we do that?" Approved: **A · POP ONCE**,
over B · a standing strip over the chat. The mockups are in `.mystical/design-drafts/update-coming/`
and in Claude Design under `drafts/update-coming/`.

## Before

- **A count, and nothing else.** All you saw ahead of an update was a green number on ↓ UPDATE.
  Opening it listed raw `sha subject` lines.
- **Words came only after the pull.** `whatsnew` wrote its headline and bullets at the boot after
  PULL & RESTART.
- **Notes came only after the pull too.** A maintainer's note in `docs/notes.md` reached other
  installs only once they had pulled.
- **No dashboard, no check.** The fetch ran only when an open dashboard polled `/local/update`.

## How it works

1. **Two things look upstream.**
   - `whatsnew.preview(selfupdate.check())` runs on every dashboard UPDATE poll (every 5 min).
   - `whatsnew.watch()` runs it from the bridge as well: 5 min after boot, then hourly, so an
     install with no dashboard open still hears about updates on Telegram.
2. **There is one `coming` row at a time.**
   - It lives in group `updates`, with subject `coming` and verb UPDATE READY. Its meta holds
     `from`/`to` (HEAD and `@{u}`), `commits`, `rest`, `url`, `branch`, `notes` and `written`.
   - It is written from `HEAD..@{u}` with the same prompt and commit-subject fallback as the
     after-update row. The fallback headline reads "n commits waiting".
   - `notes` holds up to 3 notes that `docs/notes.md` gained in that range, minus `notes_seen`.
   - Its first write is news: it pops in the dashboard, and goes to Telegram if routed there.
   - When more commits land, the row is rewritten in place (`notices.revise`, so its id and read
     mark stay), at most hourly (`_COMING_EVERY`). It doesn't pop again.
   - One write runs at a time (`_writing`).
   - The row is dropped once nothing waits, unless HEAD already holds its `to` (pulled, with the
     restart still to come).
3. **The boot reuses the words.**
   - If the pulled range `old..head` equals the row's `from..to`, the UPDATED row takes its words
     and no second haiku call is made.
   - A note the preview showed lands with `meta.quiet`, and isn't sent to Telegram.
   - The row is dropped once HEAD holds it.
4. **The dashboard shows it in three places.**
   - **The pop.** `Notifications` sends a fresh `coming` row to `hud:update-pop`. UpdateButton (the
     rail variant) shows the changelog's `.clg-co` callout pointing at ↓, and lights that button with
     `.clg-lit`. A click opens the popover.
   - **The popover.** UpdateButton reads `info.coming` and leads with "What's coming": the headline,
     the bullets and the notes. Then the `Meta` line, a **Show the commits** fold, and one line on
     what PULL & RESTART does. CANCEL reads LATER. Opening it marks the row read.
   - **The changelog.** ChangelogButton puts a `.clg-card.next` COMING card on top. Its **Update
     now** fires `hud:update`, and so does clicking an OS banner for the row.
   - A bridge older than this bundle sends no `coming` field, and the popover falls back to the
     commit list.

## The AI switch

The user's ruling (2026-10-23) is that the preview stays under **UPDATE NOTES**, which ships ON.
This is the one self-running exception to `aifeatures`' rule. It costs one haiku call per waiting
update, then at most one an hour while more commits land. The restart reuses those words. A
restart whose commits the preview didn't cover (a dev checkout's own work) still pays its one call.

## Fixed in passing

The `[data-fam]` popover rule gave every button inside a popover a transparent bottom border. That
suits menu rows, but UPDATE's boxed footer buttons looked cut off. The border part of the rule now
skips `.upd-btn`.

## Not in this

- **A "writing what's coming…" state.** For the ~30 s before the row lands, the popover shows the
  commit list as it did before.
- **The Mini App** (it has no UPDATE; Telegram covers phones), **the Mac menu bar**, and **a version
  number**.
- **B · the standing strip.** It was drawn and declined.
