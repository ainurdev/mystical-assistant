# Logo picker: Pick logos, and an AUTO background

`/design-first "also add button that will go through project select a good logo
available, and for those project with no logo use their frontend logo or their
brand logo and based on logo and theme decide how logo appear mystical with
background or not"`

Draft: `.mystical/design-drafts/logo-picker/` (also in Claude Design under
`drafts/logo-picker/`). It builds on `feat/repo-logos`, which isn't merged yet. There, a project with no
mark already wears its repo's own icon by itself, and the LOGO tab lists the
repo's pictures (FROM THIS REPO).

The mockups are the real dashboard: the scratch copy of this bridge on that
branch, in your theme (Rivendell by night, and by day for comparison), with your
projects and logos. The new parts were injected into the page.

## 1 · Pick logos (SETTINGS ▸ Projects, on the toolbar)

The button sits after All / Shown / Hidden. It goes through every project that
still wears letters and gives each one the best logo it can find, in this order:

1. **Its frontend's.** A backend repo's name with its suffix dropped
   (`-api`, `-server`, `-backend`, `-worker` or `-service`) names its frontend:
   the bare name, or that name plus `-app`, `-web`, `-frontend`, `-ui`, `-portal`
   or `-client`. If that project wears a logo, the backend gets it too, so
   unideck-api gets unideck's.
2. **Its brand's.** A logo or brand file in the repo that belongs to the project:
   a `logo.*`, or a file under `brand/` whose name holds the repo's name. A wide
   wordmark still counts, and AUTO fits it.
3. **Its GitHub organization's picture.** This is skipped for a personal
   account, and when the picture is GitHub's generated default (ainurhq's is).

When nothing is found, the project keeps its letters and the result says so.
Pick logos never touches a mark you set, a mark following Rivendell, or a
project that already wears its own icon.

What a tap does: **A · one tap** (approved 2026-10-21; B was the alternative).

- **A · one tap** (recommended). It applies at once. A strip under the toolbar
  says what was picked and what found nothing, and offers Undo. It's the same
  strip as Rivendell's import.
- **B · review first.** A sheet lists each proposal: the tile before and after,
  and where the logo came from. Untick any you don't want, then press Use N logos.

A brand file is kept by its path, as a FROM THIS REPO pick is, so it follows
the file. A frontend's logo and an organization's picture are copied into the
logo store, because they live in another repo or on GitHub (a builder's call;
the draft said the frontend's would follow its file too). A pick ranks like the repo's own icon: a logo from
Rivendell still wins later, and anything you set by hand beats it. Undo puts the
letters back.

**On this Mac today:**

| Project | Result |
| --- | --- |
| unideck-api | gets unideck's icon |
| yggdrasil | keeps letters: its brand files belong to clients, and ainurhq's GitHub picture is the default |
| aligned | keeps letters: it has no picture and no remote |

## 2 · AUTO background (every logo, on every theme)

BACKGROUND gains AUTO, and AUTO becomes the default. NONE, LIGHT and DARK still
pin it. On each theme the dashboard reads the logo against the ground under it,
the same way it already reads colours (`lib/logoinfo.ts`):

- If less than half of the logo's ink stands out from the ground (contrast 2:1
  or more), it gets a plate of the opposite lightness.
- An app icon that fills its square never gets one. Rounded corners still count
  as filling it.

The editor says what AUTO chose on the current theme ("light here").

**Measured on your logos:**

- IB Groups' black wordmark gets a plate: light at night, none by day.
- Elvou's white wordmark gets a dark plate by day.
- The NR lions, unideck, Ainur, Rivendell, EFAS and the rest stay as they are.

**Exceptions:**

- AURORA still draws logos as phosphor silhouettes, so AUTO means none there.
- Mystical's own tile in MIDDLE-EARTH is the theme's emblem, so it never gets a plate.
- The LIGHT you pinned on IB Groups on 10-18 stays pinned. AUTO would pick the
  same at night and drop it by day; switch it to AUTO in its editor whenever you
  like.

## Not in it

- A better-fitting logo for a project that follows Rivendell. IB Groups' repo has
  a square blue app icon, while Rivendell lends a wide wordmark. Rivendell still
  wins, as agreed; say if Pick logos should offer the repo's icon there.
- The Mini App. It has no project marks.

## Builder's calls

- A pick counts like the repo's own icon. Rivendell's import and refresh replace
  it, its offer counts it, and an icon the repo gains later wins over it.
- Pick logos only looks at projects wearing letters, so it never re-picks its
  own earlier picks. Undo takes back the last run's picks that are still as picked.
- AUTO reads each logo once, against a dark ground (luminance 0.03) and a light
  one (0.9). Tiles carry the two readings (`data-auto-n`, `data-auto-d`), and
  `html[data-light]` picks the one that applies, so a theme switch re-renders nothing.
