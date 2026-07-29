// Nyan Cat working-indicator — an opt-in replacement for the HUD's equalizer
// bar. Assets stream straight from www.nyan.cat (nothing is vendored), so a
// mode key doubles as the path segment for BOTH the cat GIF (/cats/<key>.gif)
// and its music (/music/<key>.mp3). Thumbnails don't follow that convention,
// hence the third column.

const BASE = "https://www.nyan.cat";

export const NYAN_MODES = [
  { key: "original", label: "NYAN CAT", thumb: "nyan.gif" },
  { key: "nyandoge", label: "NYAN DOGE", thumb: "nyandoge.gif" },
  { key: "nyancoin", label: "NYAN COIN", thumb: "nyancoin.gif" },
  { key: "gb", label: "GAMEBOY", thumb: "GB.gif" },
  { key: "technyancolor", label: "TECHNYANCOLOR", thumb: "technyancolor.gif" },
  { key: "jazz", label: "JAZZ", thumb: "jazz.gif" },
  { key: "mexinyan", label: "MEXINYAN", thumb: "mexinyan.gif" },
  { key: "j5", label: "JACKSON 5", thumb: "jacksnyan.gif" },
  { key: "nyaninja", label: "NYANINJA", thumb: "nyaninja.gif" },
  { key: "pirate", label: "PIRATE", thumb: "pirate.gif" },
  { key: "elevator", label: "ELEVATOR", thumb: "elevator.gif" },
  { key: "pikanyan", label: "PIKANYAN", thumb: "pikanyan.gif" },
  { key: "zombie", label: "ZOMBIE", thumb: "zombie.gif" },
  { key: "mummy", label: "MUMMY", thumb: "mummy.gif" },
  { key: "pumpkin", label: "PUMPKIN", thumb: "pumpkin.gif" },
  { key: "wtf", label: "GLITCH", thumb: "glitch.gif" },
  { key: "jamaicnyan", label: "RASTA", thumb: "rasta.gif" },
  { key: "america", label: "'MURICA", thumb: "uhmurica.gif" },
  { key: "retro", label: "RETRO", thumb: "retro.gif" },
  { key: "vday", label: "VALENTINE", thumb: "vday.gif" },
  { key: "sad", label: "SAD NYAN", thumb: "sadnyan.gif" },
  { key: "tacnayn", label: "TACNAYN", thumb: "tacnayn.gif" },
  { key: "dub", label: "DUBSTEP", thumb: "dub.gif" },
  { key: "slomo", label: "SLO-MO", thumb: "slomo.gif" },
  { key: "xmas", label: "CHRISTMAS", thumb: "xmas.gif" },
  { key: "fiesta", label: "TACO DOG", thumb: "tacodog.gif" },
  { key: "easter", label: "EASTER", thumb: "easter.gif" },
  { key: "bday", label: "BIRTHDAY", thumb: "bday.gif" },
  { key: "daft", label: "DAFT PUNK", thumb: "daft.gif" },
  { key: "paddy", label: "ST PADDY", thumb: "paddy.gif" },
  { key: "breakfast", label: "BREAKFAST", thumb: "breakfast.gif" },
  { key: "melon", label: "MELON BIRD", thumb: "melonbird.gif" },
  { key: "star", label: "STAR SHEEP", thumb: "starsheep.gif" },
  { key: "balloon", label: "BALLOON", thumb: "balloon.gif" },
  { key: "grumpy", label: "GRUMPY", thumb: "grumpy.gif" },
  { key: "newyear", label: "NEW YEAR", thumb: "newyear.gif" },
] as const;

export type NyanMode = (typeof NYAN_MODES)[number]["key"];
/** "match" plays the picked cat's own track — what nyan.cat itself does. */
export type NyanSound = "match" | "off" | NyanMode;

export const NYAN_KEYS: string[] = NYAN_MODES.map((m) => m.key);

// ---- lore ------------------------------------------------------------------
// With EXTRA ANIMATIONS on, the cat needs everything nyan.cat draws around it
// in CSS rather than in the GIF: the stair-stepped rainbow trail, the blooming
// pixel stars, and the right sky. The numbers below are lifted straight from
// nyan.cat's own stylesheets — base2.css for the defaults, /style/<mode>.css
// for the per-cat overrides — so a mode looks the way its page does.

/** base2.css `.rainbow .wave-1…6`. Six stripes; a 7th exists as a spacer and
 *  only RETRO paints it. */
export const RAINBOW = ["#ff0000", "#ff9900", "#ffff00", "#33ff00", "#0099ff", "#6633ff"];

export interface NyanLook {
  sky: string; // per-mode `body { background }`
  star: string | null; // `.star .dot { background }`; null = this cat flies starless
  waves: string[]; // the rainbow stripes, top to bottom
  noTrail: boolean; // `.rainbow { display: none }` — the trail is baked into the GIF
}

const DEFAULT_LOOK: NyanLook = { sky: "#0f4d8f", star: "#ffffff", waves: RAINBOW, noTrail: false };

const LOOKS: Partial<Record<NyanMode, Partial<NyanLook>>> = {
  nyandoge: { waves: ["#FEFDC2", "#FFFF00", "#F9E830", "#F7CB10", "#FAA50C", "#D27500"] },
  gb: { waves: ["#193131", "#214a31", "#527b6b", "#4a523a", "#527b3a", "#adc542"] },
  technyancolor: { sky: "#0c0c0c" },
  jazz: { sky: "#434343", waves: ["#d62942", "#d66b29", "#d6b529", "#73d629", "#29adce", "#5a52de"] },
  mexinyan: { waves: ["#009933", "#009933", "#ffffff", "#ffffff", "#b60000", "#b60000"] },
  nyaninja: { star: null },
  pirate: { noTrail: true },
  elevator: { noTrail: true },
  pikanyan: { waves: ["#f7e652", "#d6d6d6", "#f7e652", "#d6d6d6", "#f7e652", "#d6d6d6"] },
  zombie: { sky: "#691F01" },
  mummy: { sky: "#691F01" },
  pumpkin: { sky: "#691F01" },
  jamaicnyan: { waves: ["#ff0000", "#339900", "#ffff00", "#ff0000", "#339900", "#ffff00"] },
  america: { waves: ["#ff0000", "#ffffff", "#ff0000", "#ffffff", "#ff0000", "#ffffff"] },
  retro: { sky: "#6c502d", waves: ["#a48865", "#967A57", "#a48865", "#967A57", "#a48865", "#967A57", "#a48865"] },
  vday: { sky: "#c61d26", waves: ["#c50000", "#ff0000", "#ff5252", "#ff9999", "#ffbdbd", "#ffffff"] },
  sad: { sky: "#00161e", noTrail: true },
  tacnayn: { sky: "#77000d", star: null, waves: ["#7b7b79", "#98989a", "#babdbc", "#fefefe", "#7c7c7c", "#9f9696"] },
  dub: { sky: "#000000", noTrail: true },
  xmas: { sky: "#72d5ff", star: "#0084ff", waves: ["#33cc00", "#ffffff", "#ff0000", "#ffffff", "#33cc00", "#ffffff"] },
  fiesta: { waves: ["#cedef7", "#9cc5f7", "#6ba5ef", "#2984e6", "#1942ff"] },
  easter: { sky: "#ff0137", waves: ["#ff84bd", "#ffad31", "#ffd684", "#5abd7b", "#7bceff", "#9c42a5"] },
  paddy: { sky: "#106b42", star: "#ffff00", waves: ["#19ad63", "#19ad63", "#ffffff", "#ffffff", "#ff9933", "#ff9933"] },
  breakfast: { waves: ["#72231F", "#ffffff", "#ffffff", "#A83232", "#A83232", "#ffffff"] },
  melon: { waves: ["#efc5ff", "#de94ff", "#ce5aff", "#bd19ff", "#f719ff", "#94007b"] },
  star: { noTrail: true },
  balloon: { noTrail: true },
  newyear: { star: "#FF00FF" },
};

export const nyanLook = (m: NyanMode): NyanLook => ({ ...DEFAULT_LOOK, ...LOOKS[m] });

export const nyanGif = (m: NyanMode): string => `${BASE}/cats/${m}.gif`;
export const nyanThumb = (thumb: string): string => `${BASE}/images/thumbs/${thumb}`;
export const nyanLabel = (m: NyanMode): string =>
  NYAN_MODES.find((d) => d.key === m)?.label ?? m;

/** Track URL for a mode + sound choice, or null when muted. */
export function nyanTrack(mode: NyanMode, sound: NyanSound): string | null {
  if (sound === "off") return null;
  return `${BASE}/music/${sound === "match" ? mode : sound}.mp3`;
}
