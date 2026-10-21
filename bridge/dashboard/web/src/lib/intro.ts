/** The loading screen's scene (BootIntro). MYSTICAL is the emblem it always
 *  had; KHAZAD-DÛM (Gandalf on the bridge) and DURIN'S DOOR are Middle-earth's,
 *  drawn in components/hud/BootScenes. SHUFFLE, the default, draws one of the
 *  three per document. Spec: docs/superpowers/specs/lotr-loading-screens.md. */
export const INTROS = ["mystical", "bridge", "door", "shuffle"] as const;
export type Intro = (typeof INTROS)[number];
export type IntroScene = Exclude<Intro, "shuffle">;

const SCENES: IntroScene[] = ["mystical", "bridge", "door"];

export function toIntro(v: unknown): Intro {
  return INTROS.find((i) => i === v) ?? "shuffle";
}

/** SHUFFLE's draw. `kept` is the scene a restart's overlay drew before the
 *  reload: the boot it hands over to continues that intro, so it keeps it. */
export function shuffleScene(kept: string | null, rnd = Math.random()): IntroScene {
  return SCENES.find((s) => s === kept) ?? SCENES[Math.floor(rnd * SCENES.length)];
}

/** sessionStorage key for SHUFFLE's draw, read back by a continued boot. */
export const BOOT_SCENE = "boot-scene";
