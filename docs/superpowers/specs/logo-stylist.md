# Logo stylist: Style with AI

`/design-first "we did not add that button to auto manage and set logos in mystical, instead of only rivendell, we want that button also check repos local for logos and favicons, check which one is better for shiwing here, configure the logo by setting background or not and color accent, you can use ai for this and applying these changes, we want it to be cool"`

Draft: `.mystical/design-drafts/logo-stylist/` (also in Claude Design under `drafts/logo-stylist/`). Approved 2026-10-21 as drawn, with one addition: the run's progress is a notification too (below).

This builds on PICK LOGOS (logo-picker, merged to master 9763dbf1). PICK LOGOS isn't live yet: the running
bridge started at 03:35 and the merge landed at 05:31, so the button isn't on your screen. Style with AI
takes its place on the same toolbar (SETTINGS ▸ Projects).

The mockups are the real dashboard: a scratch copy of this bridge on master, with your projects, in your
theme (THE SHIRE by night). The stylist's answers were applied to that copy as real marks, so every "after"
picture is the dashboard drawing them. `shots/run.mp4` is the run in motion.

## What one press does

1. **Gather.** For every project except a mark you set by hand (and Mystical's own tile), it collects:
   - what the project wears now (Rivendell's logo, its own icon, an earlier pick);
   - every picture its repo tracks that is named for an icon, a logo or a brand. That covers favicons,
     app icons (apple-touch, android-chrome, icon-512, Expo's icon.png), logo.* and brand files: the
     FROM THIS REPO list;
   - Rivendell's logos for it (the project's own, then its client's);
   - for a backend, its frontend's mark (unideck-api gets unideck's);
   - its GitHub organization's picture.
2. **Draw.** The browser draws each candidate as a tile on a night ground and a day ground. Repeats are
   dropped, so icon-16/32/48 of one drawing count once. The result is one contact sheet image, plus a
   short list per project: name, folder, remote, the README's first line, and each candidate's source.
3. **Ask once.** One AI call reads the sheet. It answers one line per project, in list order: which
   candidate to wear (or keep what it wears, or a lucide icon when nothing is the project's own), which
   background (auto, none, light or dark), which colour, and why, in about a dozen words.
   It is given these rules:
   - Use the project's own brand only. A client's logo in a hub is not the project's (yggdrasil,
     ainurhq.cloud's assets).
   - Never use a framework's leftover (React, Svelte, Vite, Next, Expo).
   - At 20 px a symbol beats a wordmark, and a square app icon beats a wide logo.
   - Keep what the project wears when that is already the best.
   - One client's repos wear one mark.
   - The colour comes from the mark.
   - Use a background only where the mark would vanish.
4. **Apply as it streams.** Each line is checked: the pick must be one of that project's candidates, the
   colour a hex, the icon one of lucide's. Then it is applied straight away, so the rows settle one by
   one. A line that fails the check leaves that project as it was.

## States (mockups)

1. **The button.** It reads "Style with AI", with sparkles in the accent colour. Its tooltip says what it
   does, then "A mark you set stays yours · one AI call · Undo".
2. **While it styles.** The button turns into "Styling…" with an accent ring running round it. A strip
   under the toolbar counts the pictures read and the projects decided, with a progress bar and Stop.
   A scan line runs down the list first. Rows waiting their turn breathe, dimmed. The row being decided
   gets a beam, with its candidates fanned at its end and a lens on the one being weighed. When a row is
   decided, its tile flips to the new mark with a ring in the new colour, and a chip appears: *new logo*,
   *new icon* or *colour*. A ✓ means it was already right; *yours* means you set it. The right pane shows
   **Now looking at**: the project, its candidates with the pick marked, the reason typing in, and what
   it will wear (background, colour).
3. **Done.** The strip says what changed (2 new logos · 2 new icons · 1 background · 9 colours), then
   "12 already right · 2 you set, left as they are", with **Undo all**. The right pane lists **What the
   stylist changed**. Each row has before → after, the name in its new colour, what changed, why, and an
   Undo for that row. Below that come the projects already right, the ones you set, and what it passed
   over. Pick a project and the pane goes back to that project. Its Mark line then reads "styled by AI: …".
4. **The sidebar.** IB Groups wears its blue app icon instead of a wordmark you can't read. Names and
   branches take their colours: rivendell in gold, osanwe in blue.

Tokens: the theme's own (`--acc`, `--panel`, `--panel2`, `--line`, `--tx*`). The strip reuses `.ps-riv.prj-picked`,
the buttons `.ps-btn`, the tiles `ProjectTile` as it is. Colours go through the same `--pc` clamp tiles use.
Motion: the flip and ring are about 0.5 s and 0.8 s, and nothing loops except the ring on the button and
the dimmed rows breathing. With reduced motion, rows just update in place.

## In the notifications

The run is the bridge's, so it outlives the Settings modal. While it runs, the bell carries a live row at the
top, STYLING · *8 of 21 decided*, with the same progress bar. Tap it and SETTINGS ▸ Projects opens on the run:
the strip, the rows settling, the pane. When it ends, a STYLED row joins the feed ("9 projects · 2 new logos ·
…") and pops like any bridge notice. Tapping it opens the same page, where the list of changes and Undo wait.
A run that fails or is stopped leaves a STYLE FAILED row saying why.

## On this Mac (the answers drawn)

| Project | Before | After | Why |
| --- | --- | --- | --- |
| ibgroups_operations | Rivendell's black wordmark on a LIGHT plate | its app icon (apps/mobile/assets/icon.png), no plate, #3168d0 | the wordmark vanished at this size |
| unideck-api | letters | unideck's icon, #3757f9 | a backend wears its frontend's mark |
| yggdrasil | letters | lucide tree-deciduous, #57ab5a | its 19 pictures are clients' brands |
| aligned | letters | lucide target, #db61a2 | no picture of its own |
| ainurhq.cloud, osanwe, rivendell, unideck, mystical-tech | as they are | same mark, a colour from it (#f59e0b, #0b57d0, #d0b282, #3757f9, #ac8de7) | colour only |
| elvou, EFAS ×2, the 8 NR repos, mystical-assistant | — | unchanged | already right |
| invoicer, website | — | untouched | yours |

It passes over these: React's logo ×4 and Svelte's favicon in elvou, Expo's adaptive icon in apex-app,
and the clients' logos in ainurhq.cloud and yggdrasil.

## Rules after a run

- **A styled mark belongs to the stylist, not to you.** The next press may restyle it. Change it by hand
  and it becomes yours, and the stylist never touches it again.
- **Where it comes from decides how it's kept.** A repo picture is kept by its path, so it follows the
  file. A frontend's logo or an organization's picture is copied.
- **Where it kept Rivendell's logo**, the mark still follows Rivendell, so a new client logo still
  arrives. The 6-hour refresh keeps the stylist's background and colour.
- **Where it chose something over Rivendell's logo** (IB Groups), Rivendell's refresh and IMPORT leave
  that mark alone.
- **Undo all** puts every mark back as it was before the run, including following Rivendell, except the
  ones you changed since. A row's Undo does the same for that one project.

## AI

- **A switch in the AI tab.** It gains LOGO STYLIST, "1 haiku call per press", about 45k tokens with one
  image. It ships ON, since it only runs when you press it.
- **With the switch off**, the button says Pick logos and runs today's rules: letters only, no colours.
- **One call.** It is a haiku vision call for every project at once, streamed. That's about 10–20 s for
  23 projects. Haiku is a builder's call; switch to sonnet if its picks are poor.
- **When it fails** (a timeout, an error, no login), nothing changes. The strip says why and offers Retry.

## Not in it

- A per-project "style this one" button. The mark editor already offers every candidate.
- A new background kind, such as a plate in the brand colour. The four we have cover every project here.
- The Mini App. It has no project marks.

## Open question

- **Logos only?** As drawn, a project with nothing of its own (yggdrasil, aligned) gets an icon and a
  colour picked by AI. Say "logos only" and those projects keep their letters.
