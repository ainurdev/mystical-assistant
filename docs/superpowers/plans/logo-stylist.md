# Logo stylist: plan

Spec: `docs/superpowers/specs/logo-stylist.md`. Branch `feat/logo-stylist`.

1. **projectmarks.py: candidates, apply, undo** (tests first in `tests/test_projectmarks.py`)
   - `style_candidates()`: per listed project, except a mark you set and our own checkout, what it wears
     now, its frontend's logo, then its repo pictures (best first), each logo once, at most 8, with ids
     c1..cN; plus a name, remote and the README's first line for the prompt.
   - `apply_style(rel, cand | None, icon, plate, color, why)`: snapshot the stored mark for undo, then
     write the stylist's mark: Rivendell's logo kept → it stays `source: rivendell` with `styled` (its
     colour and background ride over refreshes in `_follow`); anything else → `source: style`, which
     import/refresh skip (`_yours`) and the next run may redo. Returns what changed.
   - `undo_style(rel=None)`: puts back marks still as styled. `_gc` keeps the undo snapshot's logos.
2. **logostyle.py: the run** (tests in `tests/test_logostyle.py`, a fake claude)
   - `start(sheet_b64, table)`: AI switch on, nothing running, a PNG under 4 MB, every candidate id one
     the bridge offers now; then a thread.
   - One sonnet call (effort low), the sheet inline over stream-json, no tools or hooks; text deltas split into lines,
     each line checked and applied as it lands. A 120 s ceiling; `stop()` kills it.
   - `state()` for the page and the bell (the partial line too, for the pane's typing why). A STYLED or
     STYLE FAILED notice at the end.
3. **server.py + aifeatures**: `GET /local/project-mark/style[/candidates]`, `POST /local/project-mark/style`
   (start, stop, undo), `styling` in `/local/running`; LOGO STYLIST in the AI tab (press-only, ON).
4. **Dashboard**: `lib/stylerun.ts` (store, poller, the contact sheet drawn on a canvas, partial-line
   reader + check), `hud/LogoStylist.tsx` (button, strip, row ends, NOW LOOKING AT, the list of changes),
   ProjectsSettings wiring (Pick logos stays when the switch is off), the bell's live STYLING row and the
   STYLED row's click, `markHint` "styled by AI", index.css (motion behind prefers-reduced-motion).
5. **Verify**: suite, `tsc -b`, the checks, a scratch bridge on /tmp state driven headless (THE SHIRE),
   one real run against the real repos on the scratch state.
