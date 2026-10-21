# Loading screen: Middle-earth scenes, Implementation Plan

**Goal:** two Middle-earth scenes for the loading screen, KHAZAD-DÛM and
DURIN'S DOOR, picked in SETTINGS ▸ Appearance next to the existing emblem and
SHUFFLE.

**Architecture:** `BootIntro` keeps the shell and log and mounts the picked
scene in the emblem's slot. The scenes are `components/hud/BootScenes.tsx`, and
their CSS sits in index.css next to the intro keyframes. The setting is
`lib/intro.ts`. The scenes are frontend only: no Python and no new data.

**Spec:** `docs/superpowers/specs/lotr-loading-screens.md`

## Tasks

- [x] `lib/intro.ts` holds `INTROS`, `toIntro`, `shuffleScene` and `BOOT_SCENE`,
  with `lib/intro.check.ts` as its check. `HudSettings.intro` defaults to
  `mystical`. `nightOf` goes in `lib/theme.ts`.
- [x] `BootScenes.tsx` gets `KhazadDum` and `DurinsDoor`, ported from the
  approved drafts. Every glow is an SVG filter.
- [x] `BootIntro`: the old field and emblem move unchanged into `Mystical()`. The
  intro picks the scene, its words and its ground, and sets `.bootleaving` when
  it leaves.
- [x] index.css gets the scene block, and `.bootcontinue *:not(.bx)`.
- [x] App and `RestartIntro` pass `settings.intro`.
- [x] SettingsModal gets the LOADING SCREEN block, plus its search entry, icon
  and caption.

## Verification

- `tsc -p tsconfig.app.json` and `vite build` are clean. All 59
  `lib/*.check.ts` pass. The theme tests (`test_miniapp_theme_sync`,
  `test_light_theme_contrast`, `test_md_typography`) pass.
- The real build ran through a read-only proxy of the live bridge, with the
  user's settings. In Chrome, the full boot was recorded for both scenes, from
  entrance to exit to wipe. In WebKit (`wkfold`), both scenes were rendered
  mid-boot and every glow draws. Both scenes were also checked on the light
  SHIRE theme: the door draws as ink on paper, and the bridge plays at night.
- In Settings ▸ Appearance ▸ Loading screen, picking DURIN'S DOOR stored
  `intro: "door"`.
