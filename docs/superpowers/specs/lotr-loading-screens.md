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

**The shell stays.** A scene swaps only the art and the words. The log, the
bar, the footer and every timing are unchanged: the 1.6 s floor, the 8 s
ceiling, the 400 ms warm-up and the 650 ms CRT wipe. A scene's exit plays
inside that warm-up and wipe, so a scene adds no time to the boot.

**KHAZAD-DÛM** ("YOU SHALL NOT PASS"; sub `THE BRIDGE OF KHAZAD-DÛM ·
MYSTICAL//ASSISTANT`). Gandalf stands on the bridge over the chasm with his
staff raised. The Balrog faces him: a shadow with fire in it, with horns, wings,
a flame sword aimed at the light, and a whip.
- **Progress:** the staff's light grows with every answered step, and the
  Balrog's fire-glow dims as it does.
- **Ready:** the footer reads `FLY, YOU FOOLS` and `CLICK TO PASS`.
- **Exit:** the staff comes down and a flash runs along the deck. The span
  under the Balrog cracks at both ends and falls with it.
- **Ground:** this scene is light against fire, so on a light theme it plays on
  that theme's dark twin (`nightOf` in `lib/theme.ts`). The twin's tokens are
  scoped to the intro.

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

## Constraints found on the way

- **WebKit (Mystical.app) ignores CSS `filter` on SVG children.** Every glow is
  therefore an SVG filter referenced with `filter="url(#…)"`. The door's swing
  is 2D (`scaleX` + `skewY`), because WebKit does not draw a 3D rotation on an
  SVG group.
- **Restart handover.** `.bootcontinue *` pulls every animation-delay back to
  -3s, so that a boot continued from a restart skips its entrance. That would
  also skip an exit. The rule now spares `.bx`, which marks an exit flourish.
  The flourishes sit on wrappers that carry no entrance of their own.
- **SHUFFLE across a restart.** The restart's overlay and the boot that
  continues it after the reload are one intro, so they draw one scene. The draw
  is kept in sessionStorage (`BOOT_SCENE`) and read back when the boot
  continues.
- **Reduced motion:** the scenes draw in their settled state, with no loops and
  no transitions.
- **Not included:** the Mini App, which has no boot screen.
