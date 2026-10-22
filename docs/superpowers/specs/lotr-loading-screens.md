# Loading screen: Middle-earth scenes

`/design-first "add variant to loading screen, i want two of them related to
lords of the rings, one be when gandalf you shall not pass"`

Draft: `.mystical/design-drafts/lotr-boot/` (also in Claude Design under
`drafts/lotr-boot/`). It had three scenes. The user approved KHAZAD-DÛM and
DURIN'S DOOR and dropped THE BEACONS, with one note on the door: "follow the
theme".

The loading screen is `BootIntro`. It is the boot screen and also the restart's
overlay (`lib/restart.tsx`). Before this change it had one look: the emblem,
MYSTICAL//ASSISTANT, and the boot log.

## What changes

**The setting.** A new block at the end of SETTINGS ▸ Appearance, **Loading
screen**, has one row, **Scene**. It is a `Segmented` control with
`MYSTICAL` · `KHAZAD-DÛM` · `DURIN'S DOOR` · `SHUFFLE`. SHUFFLE is the default,
and it draws one of the three once per page load; the user asked for that
after the first ship, which kept MYSTICAL. The pick is stored in `hud-settings`
as `intro` and validated by `toIntro` (`lib/intro.ts`). Nothing stored, or a
scene that no longer exists, reads as SHUFFLE.

**The shell stays.** A scene swaps the art, the words and its wipe. The log,
the bar, the footer and every timing are shared: the 2.6 s floor (1.6 s until
the user asked for a second more), the 8 s ceiling, the 400 ms warm-up and the
650 ms wipe. A scene's exit plays inside that warm-up and wipe, so a scene adds
no time to the boot. Each scene leaves its own way (`/design-first "out
transition unique for each intro animation"`, draft
`.mystical/design-drafts/intro-exits/`): MYSTICAL keeps the CRT power-off
(`crtoff`), which was its own, and the other two get the wipes below
(BootIntro's `EXIT`).

**KHAZAD-DÛM** ("YOU SHALL NOT PASS"; sub `THE BRIDGE OF KHAZAD-DÛM ·
MYSTICAL//ASSISTANT`). Redrawn as v2 after `/design-first "make the gandalf
loading screen cooler"` (draft: `.mystical/design-drafts/khazad-dum-v2/`).
Gandalf stands on a slender arch over the chasm, cloak and hair streaming
back, his staff raised with a star at its head. The chasm drops away under the
deck: cliffs lit red from below, rock walls stepping into the deep, and the
deep's glow behind the wordmark and the log. The Balrog is an angular shadow
with fire in it. It has bull's horns, a burning mane, ragged wings with fire
on their leading edges, magma cracks over a glowing chest, a flame sword raised
at the light, and a whip of three thongs. Behind it are smoke and breathing fire.
- **Progress:** six runes circle the staff's light, and each answered step
  kindles one (the restart's three steps kindle two each). The step also
  sends a pulse out of the light and makes the fire behind the Balrog flinch.
  With each step the light, its pool on the deck and the white edge it casts
  on the Balrog all grow, and the Balrog's backlight dims.
- **Ready:** the footer reads `FLY, YOU FOOLS` and `CLICK TO PASS`.
- **Exit:** he lifts the staff over his head while the runes gather into its
  light, holds it, then swings it down from the shoulder and plants its foot on
  the deck at 300 ms, with a small rebound. White flame stands up where it lands
  and the frame shakes, a crack runs to the Balrog's feet, and the span under it
  breaks in three and falls. Then the wipe (`kdplunge`): the whole frame gives on the
  Balrog's side, hangs a beat from its top-left corner, and drops into the deep,
  darkening, with the Balrog on it. The Balrog used to fall on its own as well.
  That moved a group full of glow filters, which WebKit re-ran every frame: the
  wipe ran at 9 fps in a WKWebView, and at 30 without it.
- **Ground:** this scene is light against fire, so on a light theme it plays on
  that theme's dark twin (`nightOf` in `lib/theme.ts`). The twin's tokens are
  scoped to the intro.
- **Size:** the SVG is 2800×760, but its flow height stays the old 400px. It
  has 120px of headroom for the wings and 240px of chasm behind the wordmark.
  On a window shorter than about 880px, the wing tips bleed off the top.

**DURIN'S DOOR** ("SPEAK, FRIEND, AND ENTER"; sub `THE DOORS OF DURIN ·
MYSTICAL//ASSISTANT`). This is the West-gate of Moria as line art: the arch
with the Sindarin inscription, the two trees with their crescent moons, the
crown, anvil and hammer, the seven stars, and the Star of Fëanor. There is a
moon in the sky, and the door's reflection lies under the threshold.
- **It follows the theme**, as the user asked: it is drawn in the theme's
  accent, on the theme's own ground. On a light theme it is ink on paper.
- **Progress:** the whole door shows faintly in stone from the start. There
  are six groups of lines, and each answered step traces one of them in. The
  restart's three steps trace two groups each.
- **Ready:** `MELLON` and `CLICK TO ENTER`.
- **Exit:** the two leaves fold in to their hinges, onto the theme's light.
  Then the wipe (`ddenter`): the view walks in, zooming 9× into the doorway
  while its light fills the screen and fades into the dashboard. BootIntro
  zooms on the rect marked `data-exit-origin`, measured as the wipe starts,
  because the doorway's place on screen depends on the window and the type
  size.

## Constraints found on the way

- **WebKit (Mystical.app) ignores CSS `filter` on SVG children.** Every glow is
  therefore an SVG filter referenced with `filter="url(#…)"`. The door's swing
  is 2D (`scaleX` + `skewY`), because WebKit does not draw a 3D rotation on an
  SVG group.
- **WebKit re-runs a filter or a mask every frame when anything under it
  moves.** Still shapes keep their filters, because their results are cached.
  The first KHAZAD-DÛM v2 ran at about 10 fps in Mystical.app, because it had
  breathing wings, twinkling veins, blurred flames, masks and a Balrog that
  rose and recoiled. So the moving glows (veins, whip) are now a wide faint
  stroke under a thin one, the chasm fades by gradient fills, and the
  Balrog's group only fades in. Measured in a WKWebView during a real boot,
  the median frame is now 33 ms, against 85–108 ms for v1.
- **The median hid the hitches.** WebKit caches a still filter only until
  something invalidates it, then runs it again: an inherited style change
  (each step's `--p` on the SVG, the skip cursor on the intro), an ancestor's
  opacity reaching 1 (the Balrog's fade-in ending), a transform on the SVG
  root (the strike's shake), and a first paint, which runs it twice. The
  Balrog's fire rims and the light on its front cost about 80 ms a run, so the
  boot froze for 4–6 frames at the start, at every step and twice in the
  strike. They are drawn now (`FireRim`: a three-band glow and a rim stroked
  under the shape, the hot back edge cut out by a clip; the light's edge by
  five clips), and all of those moments hold 60 fps in a WKWebView. Gandalf's
  rims and the small glows stay filters: they cost too little to show.
- **The dashboard mounts in the hold.** Mounting it is about 350 ms of main
  thread, and a scene's SVG only moves on the main thread, so mounting it at
  the exit froze the strike. It now mounts once every step has answered and
  the scene is 1.9 s in, and the exit waits until the mount has had 500 ms
  (`bootReveal` and `BOOT_SETTLE_MS` in `lib/bootsteps.ts`). The flames pause
  for that beat in the hold instead. A bridge that answers after 2.1 s leaves
  up to 0.5 s later than it did.
- **Restart handover.** `.bootcontinue *` pulls every animation-delay back to
  -3s, so that a boot continued from a restart skips its entrance. That would
  also skip an exit. The rule now spares `.bx`, which marks anything that
  answers the boot rather than opens it: an exit flourish, or a step's pulse.
  These sit on wrappers that carry no entrance of their own. The runes and the
  staff's light do carry one, so their exits keep their delays through a
  `.bootcontinue.bootleaving` rule. Until then a restarted boot's strike began
  with the light and the runes already gone and the span under the Balrog
  already fallen (the fragments lacked `.bx`).
- **The strike read as a fall** (`work on movement of gandalf hand, its like his
  hand falling currently`; draft `.mystical/design-drafts/kd-strike/`, also in
  Claude Design under `drafts/kd-strike/`). It moved the whole staff arm 80 px
  straight down in 130 ms, speeding up all the way, so the sleeve slid off his
  shoulder to his hip. Now the arm turns about the shoulder and the staff turns
  back about the fist (`kdarm`, `kdheld`, and `kdlevel` for the streak, all on
  one timing), after a lift and a hold. Everything the blow sets off moved
  from 120 ms to 300 ms, and the wipe still starts at 400 ms. The approved
  draft also leaned his whole body 3°. That was cut, because it moved Gandalf's
  rim filter and WebKit re-ran the filter every frame: 1–3 late frames in the
  lift. Without the lean, the lift and the swing hold 60 fps in a WKWebView,
  and the landing costs one late frame, as the old one did.
- **SHUFFLE across a restart.** The restart's overlay and the boot that
  continues it after the reload are one intro, so they draw one scene. The draw
  is kept in sessionStorage (`BOOT_SCENE`) and read back when the boot
  continues.
- **Reduced motion:** the scenes draw in their settled state, with no loops and
  no transitions, and every scene's wipe is a plain fade.
- **Not included:** the Mini App, which has no boot screen.
