/* The loading screen's Middle-earth scenes (lib/intro): KHAZAD-DÛM and DURIN'S
   DOOR. BootIntro keeps the shell (the log, the bar, the CRT wipe, every
   timing) and mounts one of these where the emblem goes: an absolute field
   behind, one SVG in the flow. `progress` is the log's answered share; it
   drives the drawing (the staff's light and its runes, the door's lines).
   `.bootleaving` on the intro plays the exit inside the existing warm-up and
   wipe, so a scene costs no time.

   Glows are SVG filters (filter="url(#…)"), never CSS `filter` on an SVG
   child: WebKit, Mystical.app's engine, ignores the latter. WebKit also
   re-runs a filter or a mask every frame when anything under it moves, so
   KHAZAD-DÛM keeps its filters on still shapes, gets the moving glows from a
   wide faint stroke under a thin one, and fades by gradient fills, not masks
   (measured: 30 fps that way, 10 fps the other). A still filter re-runs too
   whenever its shape is invalidated: an inherited style change (a step's --p,
   the skip cursor), an ancestor's opacity reaching 1, a transform on the root,
   its first paint (twice over). The Balrog's rims cost ~80 ms a run there, a
   visible hitch at every step and at the strike, so they are drawn (FireRim,
   the lit clips) rather than filtered; the filters left are small. `.bx` marks an
   animation that answers the boot rather than opens it (an exit flourish, a
   step's pulse), which `.bootcontinue` must not fast-forward (index.css). The
   ids are fixed because only one intro is ever mounted: the boot, or after it
   the restart's overlay. Drafts: .mystical/design-drafts/lotr-boot/ and
   khazad-dum-v2/. */
import type { CSSProperties, ReactNode } from "react";

type Flame = [x: number, y: number, rot: number, scale: number, delay: number, dur?: number];

/** One tongue of #kd-flame. The placement sits on a wrapper: the flicker's
 *  transform would replace a transform attribute on the <use> itself. */
function F({ f: [x, y, rot, scale, delay, dur] }: { f: Flame }) {
  return (
    <g transform={`translate(${x} ${y}) rotate(${rot}) scale(${scale})`}>
      <use href="#kd-flame" className="kd-flame" style={{ animationDelay: `${delay}s`, animationDuration: dur ? `${dur}s` : undefined }} />
    </g>
  );
}

// The Balrog's fire, in its own frame (feet at 0,0, facing the wizard).
const MANE: Flame[] = [
  [-108, -316, 20, 1.3, 0], [-96, -314, 28, 1.9, -0.3], [-82, -314, 34, 2.4, -0.7, 0.9], [-66, -318, 40, 2.8, -0.15],
  [-50, -326, 44, 2.6, -0.5, 1.3], [-36, -334, 48, 3, -0.9], [-20, -324, 52, 2.7, -0.4, 0.95], [-4, -330, 56, 2.9, -0.65],
  [10, -336, 60, 2.6, -0.25, 0.85], [26, -322, 64, 2.4, -0.2, 0.8], [42, -328, 70, 2.1, -0.75, 0.85], [56, -306, 78, 1.8, -0.35, 1.05], [66, -284, 86, 1.4, -0.55, 0.9],
  [-102, -318, 22, 1, -0.1, 0.8], [-72, -316, 36, 1.2, -0.45, 0.9], [-44, -330, 46, 1.3, -0.6, 0.85], [-12, -328, 54, 1.2, -0.3, 0.95], [18, -330, 62, 1.1, -0.5, 0.9],
  // the wings' leading edges
  [62, -372, 50, 1.1, -0.2, 0.9], [128, -424, 58, 1.2, -0.6, 1], [180, -436, 64, 1, -0.35, 0.85], [236, -444, 70, 0.9, -0.8, 0.95],
  [-30, -370, 24, 1, -0.4, 0.9], [-60, -412, 30, 1.1, -0.1, 1], [-104, -428, 34, 0.9, -0.7, 0.85], [-150, -437, 38, 0.8, -0.25, 0.9],
  // the sword
  [-246, -225, 30, 0.9, -0.2, 0.8], [-278, -235, 34, 1, -0.5, 0.9], [-309, -244, 38, 0.9, -0.8, 0.85], [-340, -254, 42, 0.7, -0.15, 0.9],
  // the bridge burns where it treads
  [-128, 0, -6, 1.1, -0.3, 0.9], [-104, 0, 8, 0.8, -0.6, 0.8], [-80, 0, -4, 0.7, -0.2, 0.9], [84, 0, 6, 1, -0.1, 1], [106, 0, -8, 0.8, -0.45, 0.85], [126, 0, 4, 0.7, -0.7, 0.9],
];
const SPARKS: [cx: number, cy: number, r: number, delay: number, dur: number][] = [
  [-90, -330, 1.4, 0, 3.4], [-60, -338, 1.1, -1.1, 2.8], [-20, -334, 1.6, -2.2, 4], [-110, -326, 1, -0.6, 3.1],
  [20, -330, 1.2, -1.8, 3.7], [-140, -316, 1.2, -2.6, 3.3], [50, -306, 1, -0.3, 2.9], [-40, -350, 1.3, -1.5, 3.6], [90, -420, 1.1, -2, 3.2],
];
// Smoke over the fire behind it, in the scene's frame: cx, cy, rx, ry, delay, duration.
const SMOKE: [number, number, number, number, number, number][] = [
  [120, -20, 150, 80, 0, 7], [260, -50, 170, 90, -2, 8], [380, 60, 150, 100, -4, 6.5], [40, 130, 110, 70, -1, 7.5],
  [240, 170, 140, 80, -3, 8.5], [420, 190, 120, 70, -5, 7], [60, -80, 130, 60, -2.5, 9], [460, -60, 150, 70, -1.5, 8], [-40, 20, 90, 60, -3.5, 7.8],
];
// Embers rising out of the deep, across the whole screen: left %, bottom %, delay, duration.
const EMBERS: [number, number, number, number][] = [
  [58, 6, -0.4, 6], [64, 2, -2.1, 7], [47, 4, -3.6, 8], [71, 9, -1.2, 5.4], [39, 1, -4.8, 6], [55, 12, -5.5, 6.6], [78, 5, -2.9, 7.4],
  [30, 8, -1.6, 7.2], [86, 3, -3.3, 6.2], [22, 2, -4.1, 8.4], [67, 14, -0.8, 5.8], [50, 18, -2.6, 6.9],
];
// ...and a few motes nearer than everything: cx, cy, r, delay, duration.
const MOTES: [number, number, number, number, number][] = [[-420, 560, 5, -1, 7], [380, 600, 7, -3.5, 8], [620, 520, 4, -5, 6.5], [-660, 600, 6, -2.2, 9]];
// The Dwarrowdelf's pillars on both shores, the far ones fainter: x, width, far.
const PILLARS: [number, number, boolean?][] = [
  [-840, 40, true], [-1110, 46, true], [900, 40, true], [1180, 46, true], [-700, 64], [-980, 76], [-1260, 84], [760, 64], [1040, 76], [1320, 84],
];
// The light at the staff's head (index.css kd- transform-origins repeat it), and
// its six runes, one per answered step: Cirth-like strokes, for the look.
const LX = -206, LY = 53;
const RUNES = [
  "M0 -7 V7 M0 -7 L5 -3 M0 -2 L5 2", "M0 -7 V7 M-4.5 -2.5 L0 -7 L4.5 -2.5", "M0 -7 V7 M0 -4.5 L3.5 -1 L0 2.5 L-3.5 -1 Z",
  "M-3 -7 V7 M3 -7 V7 M-3 -3 L3 3", "M0 -7 V7 M0 -1 L-4.5 3.5 M0 -5 L4.5 -0.5", "M0 -7 V7 M0 -7 L4.5 -3.5 L0 0 M0 2 L-4.5 5.5",
];

// The deck: one slender arch between the shores, thin at the crown. Drawn here
// once, then as the part that stays and the three pieces that fall.
const DECK = (
  <>
    <path className="kd-spandrel" d="M -545 338 Q 40 306 625 338 L 625 362 Q 40 288 -545 362 Z" />
    <path className="kd-face" d="M -545 331 Q 40 299 625 331 L 625 338 Q 40 306 -545 338 Z" />
    <path className="kd-joints" d="M -500 328.6 V 335.6 M -440 325.8 V 332.8 M -380 323.2 V 330.2 M -320 321.1 V 328.1 M -260 319.2 V 326.2 M -200 317.7 V 324.7 M -140 316.5 V 323.5 M -80 315.7 V 322.7 M -20 315.2 V 322.2 M 40 315 V 322 M 100 315.2 V 322.2 M 160 315.7 V 322.7 M 220 316.5 V 323.5 M 280 317.7 V 324.7 M 340 319.2 V 326.2 M 400 321.1 V 328.1 M 460 323.2 V 330.2 M 520 325.8 V 332.8 M 580 328.6 V 335.6" />
    <path className="kd-joints" d="M -470 328 L -480.2 353.1 M -400 325.6 L -408.8 345.9 M -330 323.5 L -337.4 339.8 M -260 321.8 L -266 334.7 M -190 320.4 L -194.6 330.7 M 270 320.4 L 274.6 330.7 M 340 321.8 L 346 334.7 M 410 323.5 L 417.4 339.8 M 480 325.6 L 488.8 345.9 M 550 328 L 560.2 353.1" />
    <path className="kd-intrados" d="M -545 362 Q 40 288 625 362" />
    <path className="kd-walk" d="M -545 331 Q 40 299 625 331" />
  </>
);

// An outline of absolute "x y" pairs moved by dx,dy; and an M/L outline wound the other way round.
const shift = (d: string, dx: number, dy: number) => d.replace(/(-?[\d.]+) (-?[\d.]+)/g, (_, x, y) => `${+x + dx} ${+y + dy}`);
const rev = (d: string) => `M ${d.match(/-?[\d.]+ -?[\d.]+/g)!.reverse().join(" L ")} Z`;

// The Balrog's trunk: legs, hips, chest and spined back in one outline.
const TRUNK = "M -132 0 L -124 -8 L -104 -14 L -94 -26 L -100 -60 L -110 -96 L -100 -112 L -76 -140 L -62 -170 L -84 -196 L -112 -226 L -118 -246 L -110 -262 L -104 -276 L -96 -298 L -78 -310 L -56 -318 L -40 -332 L -30 -318 L -8 -326 L 6 -340 L 14 -320 L 34 -318 L 44 -330 L 52 -310 L 62 -296 L 68 -280 L 66 -240 L 56 -208 L 48 -186 L 64 -166 L 82 -140 L 98 -108 L 116 -82 L 132 -58 L 128 -30 L 124 0 L 78 0 L 86 -16 L 94 -40 L 90 -52 L 66 -74 L 48 -100 L 16 -138 L -20 -140 L -56 -122 L -80 -92 L -80 -60 L -72 -26 L -72 0 Z";
// Its body, once: drawn rimmed in its own fire, and again under the wizard's
// light. The trunk goes in reversed, wound like its limbs, so a clip of all five
// outlines is their union.
const BODY = [
  rev(TRUNK),
  // head, low and forward, the jaw dropped on the fire inside
  "M -94 -310 L -112 -316 L -140 -308 L -148 -300 L -144 -296 L -154 -288 L -156 -278 L -150 -272 L -146 -276 L -132 -272 L -150 -258 L -148 -252 L -140 -246 L -116 -250 L -102 -262 L -90 -280 Z",
  // horns: the far one swept back, the near one forward like a bull's
  "M -104 -314 L -90 -312 L -80 -334 L -66 -356 L -48 -376 L -52 -382 L -72 -366 L -90 -344 Z",
  "M -112 -310 L -112 -330 L -120 -348 L -136 -362 L -158 -372 L -176 -374 L -160 -364 L -146 -352 L -138 -336 L -136 -306 Z",
  // the sword arm, out and low, the fist up
  "M -101 -286 L -133 -222 L -160 -233 L -196 -228 L -200 -235 L -214 -237 L -225 -225 L -225 -208 L -214 -198 L -198 -200 L -160 -197 L -122 -202 L -106 -194 L -108 -210 L -75 -274 Z",
];

/** Shadow rimmed in its own fire: a soft glow and a thin rim stroked under the
 *  shape, and inside it the top and back edges hot, where the shape covers its
 *  own copy moved down and forward least. Drawn, not filtered (the module
 *  comment says why). `ds` must all wind one way: the clip unions them. */
function FireRim({ id, ds }: { id: string; ds: string[] }) {
  return (
    <>
      <clipPath id={id}><path d={ds.join(" ")} /></clipPath>
      {["kd-rimglow1", "kd-rimglow2", "kd-rimglow3", "kd-rim"].map((c) => ds.map((d, i) => <path key={c + i} className={c} d={d} />))}
      <g clipPath={`url(#${id})`}>
        {ds.map((d, i) => <path key={i} className="kd-hot" d={d} />)}
        <g transform="translate(-1.6 1.6)">{ds.map((d, i) => <path key={i} className="kd-bk" d={d} />)}</g>
      </g>
    </>
  );
}

function Pillar({ x, w, far }: { x: number; w: number; far?: boolean }) {
  const l = x - w / 2, r = x + w / 2, cap = w * 0.9, edge = x < 0 ? r : l;
  return (
    <>
      <path className={far ? "kd-pillar kd-far" : "kd-pillar"} d={`M ${l} 331 L ${l} 20 C ${l} -20 ${l - cap} -60 ${l - cap} -120 L ${r + cap} -120 C ${r + cap} -60 ${r} -20 ${r} 20 L ${r} 331 Z`} />
      {/* the edge that faces the chasm catches a little light */}
      {!far && <path className="kd-pillar-edge" d={`M ${edge} 331 V 20`} />}
    </>
  );
}

/** KHAZAD-DÛM: "You shall not pass." Gandalf holds a slender bridge over the
 *  chasm while the dashboard loads. Each answered step kindles one rune of the
 *  six round his staff's light, pulses it and makes the shadow's fire flinch;
 *  leaving, he lifts the staff over his head and plants it on the deck, white
 *  flame stands up where it lands, a crack runs to the Balrog's feet, the span
 *  under it breaks in three and falls, and the wipe (kdplunge) drops the whole
 *  frame, Balrog and all, into the deep. Always drawn at night: the intro
 *  hands this scene a dark ground (lib/theme nightOf). */
export function KhazadDum({ progress }: { progress: number }) {
  const lit = Math.floor(progress * 6 + 1e-9);
  // the step's pulse and flinch restart by swapping between twin keyframes, so nothing remounts
  const beat = lit ? (lit % 2 ? "a" : "b") : "";
  return (
    <>
      <div className="kd-field" aria-hidden>
        <div className="kd-deep" />
        {EMBERS.map(([l, b, d, t], i) => (
          <i key={i} className={i % 4 === 3 ? "kd-ember kd-big" : "kd-ember"} style={{ left: `${l}%`, bottom: `${b}%`, animationDelay: `${d}s`, animationDuration: `${t}s` }} />
        ))}
      </div>
      <div className="kd-flash bx" aria-hidden />

      <svg className="kd-scene bx" viewBox="-1400 -120 2800 760" style={{ "--p": progress } as CSSProperties} aria-hidden>
        <defs>
          <radialGradient id="kd-back">
            <stop offset="0" style={{ stopColor: "var(--err)", stopOpacity: 0.5 }} />
            <stop offset=".42" style={{ stopColor: "var(--warn)", stopOpacity: 0.12 }} />
            <stop offset="1" style={{ stopColor: "var(--warn)", stopOpacity: 0 }} />
          </radialGradient>
          <radialGradient id="kd-hot">
            <stop offset="0" style={{ stopColor: "var(--warn)", stopOpacity: 0.4 }} />
            <stop offset=".5" style={{ stopColor: "var(--err)", stopOpacity: 0.14 }} />
            <stop offset="1" style={{ stopColor: "var(--err)", stopOpacity: 0 }} />
          </radialGradient>
          <radialGradient id="kd-smk">
            <stop offset="0" style={{ stopColor: "var(--void)", stopOpacity: 0.9 }} />
            <stop offset=".55" style={{ stopColor: "var(--void)", stopOpacity: 0.5 }} />
            <stop offset="1" style={{ stopColor: "var(--void)", stopOpacity: 0 }} />
          </radialGradient>
          <radialGradient id="kd-white">
            <stop offset="0" style={{ stopColor: "var(--txb)", stopOpacity: 0.95 }} />
            <stop offset=".22" style={{ stopColor: "var(--txb)", stopOpacity: 0.34 }} />
            <stop offset=".55" style={{ stopColor: "var(--info)", stopOpacity: 0.07 }} />
            <stop offset="1" style={{ stopColor: "var(--info)", stopOpacity: 0 }} />
          </radialGradient>
          <radialGradient id="kd-pool-g">
            <stop offset="0" style={{ stopColor: "var(--txb)", stopOpacity: 0.42 }} />
            <stop offset=".5" style={{ stopColor: "var(--txb)", stopOpacity: 0.1 }} />
            <stop offset="1" style={{ stopColor: "var(--txb)", stopOpacity: 0 }} />
          </radialGradient>
          <radialGradient id="kd-core-g">
            <stop offset="0" style={{ stopColor: "var(--warn)", stopOpacity: 0.8 }} />
            <stop offset=".45" style={{ stopColor: "var(--err)", stopOpacity: 0.32 }} />
            <stop offset="1" style={{ stopColor: "var(--err)", stopOpacity: 0 }} />
          </radialGradient>
          <radialGradient id="kd-mote-g">
            <stop offset="0" style={{ stopColor: "var(--warn)", stopOpacity: 0.9 }} />
            <stop offset=".4" style={{ stopColor: "var(--err)", stopOpacity: 0.35 }} />
            <stop offset="1" style={{ stopColor: "var(--err)", stopOpacity: 0 }} />
          </radialGradient>
          <linearGradient id="kd-streak-g" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0" style={{ stopColor: "var(--info)", stopOpacity: 0 }} />
            <stop offset=".5" style={{ stopColor: "var(--txb)", stopOpacity: 0.9 }} />
            <stop offset="1" style={{ stopColor: "var(--info)", stopOpacity: 0 }} />
          </linearGradient>
          <linearGradient id="kd-fire" x1="0" y1="1" x2="0" y2="0">
            <stop offset="0" style={{ stopColor: "var(--warn)" }} />
            <stop offset=".5" style={{ stopColor: "var(--err)", stopOpacity: 0.9 }} />
            <stop offset="1" style={{ stopColor: "var(--err)", stopOpacity: 0 }} />
          </linearGradient>
          <linearGradient id="kd-blade" gradientUnits="userSpaceOnUse" x1="-214" y1="-216" x2="-372" y2="-263">
            <stop offset="0" style={{ stopColor: "var(--warn)" }} />
            <stop offset=".65" style={{ stopColor: "var(--err)", stopOpacity: 0.9 }} />
            <stop offset="1" style={{ stopColor: "var(--err)", stopOpacity: 0.15 }} />
          </linearGradient>
          <linearGradient id="kd-sheet-g" x1="0" y1="1" x2="0" y2="0">
            <stop offset="0" style={{ stopColor: "var(--txb)" }} />
            <stop offset=".55" style={{ stopColor: "var(--txb)", stopOpacity: 0.55 }} />
            <stop offset="1" style={{ stopColor: "var(--info)", stopOpacity: 0 }} />
          </linearGradient>
          {/* the deck's walking line: fire where the shadow stands... */}
          <linearGradient id="kd-walk" gradientUnits="userSpaceOnUse" x1="-545" y1="0" x2="625" y2="0">
            <stop offset="0" style={{ stopColor: "var(--acc)", stopOpacity: 0.7 }} />
            <stop offset=".5" style={{ stopColor: "var(--acc)", stopOpacity: 0.8 }} />
            <stop offset=".7" style={{ stopColor: "var(--warn)", stopOpacity: 0.9 }} />
            <stop offset="1" style={{ stopColor: "var(--acc)", stopOpacity: 0.6 }} />
          </linearGradient>
          {/* ...and white where the wizard's light falls */}
          <linearGradient id="kd-walklit" gradientUnits="userSpaceOnUse" x1="-545" y1="0" x2="80" y2="0">
            <stop offset="0" style={{ stopColor: "var(--txb)", stopOpacity: 0 }} />
            <stop offset=".48" style={{ stopColor: "var(--txb)", stopOpacity: 0.95 }} />
            <stop offset="1" style={{ stopColor: "var(--txb)", stopOpacity: 0 }} />
          </linearGradient>
          {/* the chasm: everything under the deck fades into the deep by its own fill */}
          <linearGradient id="kd-pit" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" style={{ stopColor: "var(--err)", stopOpacity: 0 }} />
            <stop offset=".4" style={{ stopColor: "var(--err)", stopOpacity: 0.1 }} />
            <stop offset=".72" style={{ stopColor: "var(--warn)", stopOpacity: 0.2 }} />
            <stop offset="1" style={{ stopColor: "var(--warn)", stopOpacity: 0 }} />
          </linearGradient>
          <linearGradient id="kd-cliffedge" gradientUnits="userSpaceOnUse" x1="0" y1="331" x2="0" y2="640">
            <stop offset="0" style={{ stopColor: "var(--acc)", stopOpacity: 0.45 }} />
            <stop offset=".35" style={{ stopColor: "var(--err)", stopOpacity: 0.4 }} />
            <stop offset=".6" style={{ stopColor: "var(--warn)", stopOpacity: 0.5 }} />
            <stop offset="1" style={{ stopColor: "var(--warn)", stopOpacity: 0 }} />
          </linearGradient>
          <linearGradient id="kd-voiddn" gradientUnits="userSpaceOnUse" x1="0" y1="331" x2="0" y2="640">
            <stop offset=".5" style={{ stopColor: "var(--void)" }} />
            <stop offset="1" style={{ stopColor: "var(--void)", stopOpacity: 0 }} />
          </linearGradient>
          <linearGradient id="kd-deepdn" gradientUnits="userSpaceOnUse" x1="0" y1="331" x2="0" y2="640">
            <stop offset=".5" style={{ stopColor: "color-mix(in srgb, var(--err) 5%, var(--void))" }} />
            <stop offset="1" style={{ stopColor: "color-mix(in srgb, var(--err) 5%, var(--void))", stopOpacity: 0 }} />
          </linearGradient>
          <linearGradient id="kd-redge" gradientUnits="userSpaceOnUse" x1="0" y1="331" x2="0" y2="640">
            <stop offset="0" style={{ stopColor: "var(--err)", stopOpacity: 0.22 }} />
            <stop offset=".6" style={{ stopColor: "var(--err)", stopOpacity: 0.18 }} />
            <stop offset="1" style={{ stopColor: "var(--err)", stopOpacity: 0 }} />
          </linearGradient>
          {/* the hall's pillars rise out of sight */}
          <linearGradient id="kd-pillar-g" gradientUnits="userSpaceOnUse" x1="0" y1="-120" x2="0" y2="331">
            <stop offset="0" style={{ stopColor: "color-mix(in srgb, var(--txb) 3.5%, var(--canvas))", stopOpacity: 0 }} />
            <stop offset=".45" style={{ stopColor: "color-mix(in srgb, var(--txb) 3.5%, var(--canvas))" }} />
          </linearGradient>
          <linearGradient id="kd-pedge" gradientUnits="userSpaceOnUse" x1="0" y1="-120" x2="0" y2="331">
            <stop offset=".1" style={{ stopColor: "var(--acc)", stopOpacity: 0 }} />
            <stop offset=".6" style={{ stopColor: "var(--acc)", stopOpacity: 0.18 }} />
          </linearGradient>
          {/* the wizard's light on the shadow's front: what is not under its body
              moved away from the light, one clip per outline, as they overlap */}
          {BODY.map((d, i) => <clipPath key={i} id={`kd-unlit${i}`}><path clipRule="evenodd" d={`M -240 -400 H 150 V 20 H -240 Z ${shift(d, 3, 2)}`} /></clipPath>)}
          {/* Gandalf: a faint white rim, his own light on top, the fire on his front */}
          <filter id="kd-rim-gf" x="-40%" y="-30%" width="180%" height="160%">
            <feMorphology in="SourceAlpha" operator="dilate" radius=".9" result="d" />
            <feComposite in="d" in2="SourceAlpha" operator="out" result="ring" />
            <feFlood className="kd-ff-txb" floodOpacity=".55" result="c" />
            <feComposite in="c" in2="ring" operator="in" result="rim" />
            <feGaussianBlur in="rim" stdDeviation="2.4" result="glow" />
            <feOffset in="SourceAlpha" dx="0" dy="2.2" result="o1" />
            <feComposite in="SourceAlpha" in2="o1" operator="out" result="top" />
            <feFlood className="kd-ff-txb" result="w" />
            <feComposite in="w" in2="top" operator="in" result="lit" />
            <feOffset in="SourceAlpha" dx="-2" dy="0" result="o2" />
            <feComposite in="SourceAlpha" in2="o2" operator="out" result="front" />
            <feFlood className="kd-ff-warn" floodOpacity=".85" result="f" />
            <feComposite in="f" in2="front" operator="in" result="fire" />
            <feMerge><feMergeNode in="glow" /><feMergeNode in="SourceGraphic" /><feMergeNode in="rim" /><feMergeNode in="fire" /><feMergeNode in="lit" /></feMerge>
          </filter>
          {/* the bbox-relative region is wide on purpose: thin strokes have thin boxes */}
          <filter id="kd-glow" x="-200%" y="-200%" width="500%" height="500%">
            <feGaussianBlur stdDeviation="3" result="b" />
            <feMerge><feMergeNode in="b" /><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge>
          </filter>
          <path id="kd-flame" d="M0 0 C -5 -3 -6 -10 -3 -17 C -2 -12 0 -11 1 -14 C 1 -20 3 -25 2 -30 C 7 -23 8 -14 6 -7 C 5 -3 3 0 0 0 Z" />
          {/* where the strike breaks the deck: three pieces under the Balrog, and the rest */}
          <clipPath id="kd-cut-a"><path d="M 50 290 L 150 290 L 146 318 L 154 323 L 147 329 L 150 420 L 50 420 L 50 331 L 53 327 L 47 322 L 54 318 Z" /></clipPath>
          <clipPath id="kd-cut-b"><path d="M 150 290 L 262 290 L 258 318 L 266 324 L 259 331 L 262 420 L 150 420 L 147 329 L 154 323 L 146 318 Z" /></clipPath>
          <clipPath id="kd-cut-c"><path d="M 262 290 L 372 290 L 368 322 L 376 328 L 369 334 L 373 420 L 262 420 L 259 331 L 266 324 L 258 318 Z" /></clipPath>
          <clipPath id="kd-cut-rest"><path d="M -1400 -120 H 50 V 312 L 54 318 L 47 322 L 53 327 L 50 331 L 50 640 H -1400 Z M 372 -120 H 1400 V 640 H 373 L 373 340 L 369 334 L 376 328 L 368 322 L 372 315 Z" /></clipPath>
          <clipPath id="kd-trunk"><path d={TRUNK} /></clipPath>
        </defs>

        {/* the hall: the Dwarrowdelf's pillars on both shores */}
        <g className="kd-hall">
          {PILLARS.map(([x, w, far]) => <Pillar key={x} x={x} w={w} far={far} />)}
        </g>
        {/* the chasm and the deep */}
        <g className="kd-abyss">
          <rect x="-560" y="331" width="1200" height="309" fill="url(#kd-pit)" />
          <path className="kd-deepr kd-far" d="M -545 420 L -500 430 L -510 452 L -470 470 L -484 496 L -436 520 L -452 548 L -400 572 L -420 600 L -370 640 L -560 640 Z" />
          <path className="kd-deepr kd-far" d="M 625 424 L 584 440 L 596 466 L 552 488 L 566 516 L 520 544 L 538 574 L 486 604 L 500 640 L 640 640 Z" />
          <g>
            <ellipse cx="-60" cy="476" rx="440" ry="22" fill="url(#kd-smk)" opacity=".55" />
            <ellipse cx="240" cy="548" rx="400" ry="26" fill="url(#kd-smk)" opacity=".5" />
          </g>
          <path className="kd-deepr" d="M -545 372 L -486 384 L -498 410 L -452 428 L -466 452 L -420 470 L -434 498 L -388 520 L -404 552 L -356 580 L -374 610 L -330 640 L -560 640 Z" />
          <path className="kd-deepr" d="M 625 376 L 566 394 L 580 420 L 534 440 L 548 466 L 500 488 L 516 518 L 466 544 L 484 576 L 436 604 L 452 640 L 640 640 Z" />
        </g>
        {/* the shores the bridge springs from */}
        <g className="kd-abyss">
          <path className="kd-floor" d="M -1400 331 L -545 331 L -545 640 L -1400 640 Z" />
          <path className="kd-floor" d="M 1400 331 L 625 331 L 625 640 L 1400 640 Z" />
          <path className="kd-rock" d="M -1400 331 L -545 331 L -552 356 L -543 384 L -560 414 L -549 448 L -566 488 L -552 530 L -570 580 L -558 640 L -1400 640 Z" />
          <path className="kd-rock" d="M 1400 331 L 625 331 L 633 358 L 621 388 L 640 420 L 627 458 L 645 500 L 630 546 L 648 600 L 636 640 L 1400 640 Z" />
          <path className="kd-strata" d="M -600 372 L -760 368 M -580 420 L -700 424 M -610 470 L -820 466 M 680 380 L 820 384 M 660 436 L 760 432 M 690 492 L 900 496" />
        </g>

        {/* fire behind the shadow, and the smoke it stands in */}
        <g className="kd-backlight bx">
          <ellipse cx="200" cy="80" rx="540" ry="410" fill="url(#kd-back)" />
          <ellipse cx="170" cy="30" rx="240" ry="200" fill="url(#kd-hot)" />
        </g>
        <g>
          {SMOKE.map(([cx, cy, rx, ry, d, t]) => (
            <ellipse key={`${cx},${cy}`} className="kd-smoke" cx={cx} cy={cy} rx={rx} ry={ry} fill="url(#kd-smk)" style={{ animationDelay: `${d}s`, animationDuration: `${t}s` }} />
          ))}
        </g>
        {/* the light on the deck round the wizard */}
        <ellipse className="kd-pool" cx="-240" cy="319" rx="300" ry="18" fill="url(#kd-pool-g)" />

        <g>
          <g className="kd-balrog">
            <g transform="translate(190 316.5) scale(.92)">
              {/* the fire behind its back, breathing; it flinches at each step */}
              <g className={beat && `kd-flinch-${beat} bx`}><g className="kd-fireback">
                <ellipse cx="-60" cy="-336" rx="96" ry="74" fill="url(#kd-hot)" />
                <ellipse cx="24" cy="-340" rx="120" ry="86" fill="url(#kd-hot)" style={{ animationDelay: "-1.1s", animationDuration: "2.3s" }} />
                <ellipse cx="84" cy="-286" rx="76" ry="64" fill="url(#kd-hot)" style={{ animationDelay: "-0.6s", animationDuration: "1.9s" }} />
              </g></g>
              {/* wings of shadow, ragged, with their bones */}
              <g opacity=".95">
                <FireRim id="kd-wing-l" ds={["M -10 -312 L -30 -370 L -60 -412 L -140 -436 L -232 -446 L -222 -418 L -244 -396 L -208 -380 L -214 -352 L -176 -356 L -166 -330 L -134 -340 L -116 -316 L -80 -326 L -50 -300 Z"]} />
              </g>
              <path className="kd-bones" d="M -10 -312 L -60 -412 L -232 -446 M -60 -412 L -244 -396 M -60 -412 L -214 -352 M -60 -412 L -166 -330 M -60 -412 L -116 -316" />
              <g opacity=".97">
                <FireRim id="kd-wing-r" ds={["M 24 -306 L 62 -372 L 128 -424 L 230 -444 L 334 -450 L 306 -412 L 318 -372 L 276 -352 L 262 -310 L 222 -304 L 204 -268 L 170 -272 L 146 -246 L 100 -276 L 58 -276 Z"]} />
              </g>
              <path className="kd-bones" d="M 24 -306 L 128 -424 L 334 -450 M 128 -424 L 318 -372 M 128 -424 L 262 -310 M 128 -424 L 204 -268 M 128 -424 L 146 -246" />
              {/* the far arm, hanging back, the whip of many thongs in its fist */}
              <FireRim id="kd-arm" ds={["M 34 -296 L 64 -282 L 96 -246 L 104 -226 L 108 -196 L 106 -166 L 110 -150 L 96 -140 L 82 -146 L 84 -168 L 82 -200 L 74 -226 L 50 -262 L 28 -270 Z"]} />
              <g className="kd-whipg">
                <path className="kd-whip-glow" d="M 98 -146 C 134 -128 150 -88 136 -58 C 124 -34 154 -18 196 -24 C 224 -28 242 -12 266 -18 M 98 -146 C 128 -116 140 -78 128 -52 C 118 -30 140 -14 180 -10 M 98 -146 C 144 -136 172 -100 168 -70 C 164 -44 192 -40 222 -46" />
                <path className="kd-whip" d="M 98 -146 C 134 -128 150 -88 136 -58 C 124 -34 154 -18 196 -24 C 224 -28 242 -12 266 -18" />
                <path className="kd-whip kd-thong" d="M 98 -146 C 128 -116 140 -78 128 -52 C 118 -30 140 -14 180 -10" />
                <path className="kd-whip kd-thong" d="M 98 -146 C 144 -136 172 -100 168 -70 C 164 -44 192 -40 222 -46" />
              </g>
              {/* the shadow itself, rimmed in its own fire, with the fire in its chest */}
              <FireRim id="kd-body" ds={BODY} />
              <ellipse className="kd-core" cx="-44" cy="-244" rx="58" ry="70" fill="url(#kd-core-g)" clipPath="url(#kd-trunk)" />
              <path className="kd-vein-glow" d="M -98 -236 L -86 -218 L -92 -200 L -80 -184 M -62 -296 L -52 -276 L -60 -258 M -22 -306 L -14 -286 L -22 -268 L -12 -246 M 28 -296 L 34 -274 L 28 -254 M 50 -252 L 56 -232 L 50 -212 M -86 -218 L -70 -212 M -60 -258 L -44 -250 L -36 -254 M -14 -286 L 0 -280 M -28 -200 L -20 -184 M -92 -100 L -88 -80 L -92 -60 M 104 -84 L 112 -66 L 108 -48 M -140 -214 L -170 -217 M 92 -230 L 98 -206" />
              <path className="kd-vein" d="M -98 -236 L -86 -218 L -92 -200 L -80 -184 M -62 -296 L -52 -276 L -60 -258 M -22 -306 L -14 -286 L -22 -268 L -12 -246 M 28 -296 L 34 -274 L 28 -254 M 50 -252 L 56 -232 L 50 -212" />
              <path className="kd-vein kd-v2" d="M -86 -218 L -70 -212 M -60 -258 L -44 -250 L -36 -254 M -14 -286 L 0 -280 M -28 -200 L -20 -184 M -92 -100 L -88 -80 L -92 -60 M 104 -84 L 112 -66 L 108 -48 M -140 -214 L -170 -217 M 92 -230 L 98 -206" />
              <ellipse cx="-142" cy="-270" rx="16" ry="10" fill="url(#kd-core-g)" />
              <path className="kd-maw" d="M -150 -272 L -132 -271 L -146 -262 Z" />
              <ellipse className="kd-eye" cx="-140" cy="-292" rx="4.6" ry="1.8" transform="rotate(-12 -140 -292)" />
              {/* the flame sword, raised at the light */}
              <g filter="url(#kd-glow)">
                <path className="kd-sword" d="M -212.7 -220.3 L -372 -262.7 L -215.3 -211.7 Z" />
                <path className="kd-hilt" d="M -210 -227 L -206 -228 L -214 -205 L -218 -204 Z" />
              </g>
              {/* the wizard's light on its front, growing as the steps answer */}
              <g className="kd-litby">
                {BODY.reduce<ReactNode>((lit, _, i) => <g clipPath={`url(#kd-unlit${i})`}>{lit}</g>,
                  ["kd-lit", "kd-litedge"].map((c) => BODY.map((d, i) => <path key={c + i} className={c} d={d} />)))}
              </g>
              {/* the mane streaming back; fire on the wings, the sword, and where it treads */}
              <g className="kd-ignite">{MANE.map((f, i) => <F key={i} f={f} />)}</g>
              <g>
                {SPARKS.map(([cx, cy, r, d, t], i) => (
                  <circle key={i} className="kd-spark" cx={cx} cy={cy} r={r} style={{ animationDelay: `${d}s`, animationDuration: `${t}s` }} />
                ))}
              </g>
            </g>
          </g>
          <g clipPath="url(#kd-cut-a)" className="kd-deck"><g className="kd-frag kd-frag-a bx">{DECK}</g></g>
          <g clipPath="url(#kd-cut-b)" className="kd-deck"><g className="kd-frag kd-frag-b bx">{DECK}</g></g>
          <g clipPath="url(#kd-cut-c)" className="kd-deck"><g className="kd-frag kd-frag-c bx">{DECK}</g></g>
        </g>
        <g clipPath="url(#kd-cut-rest)" className="kd-deck">{DECK}</g>
        <path className="kd-litwalk" d="M -545 331 Q 40 299 625 331" />
        <path className="kd-split bx" filter="url(#kd-glow)" d="M 50 312 L 54 318 L 47 322 L 53 327 L 50 331 M 372 315 L 368 322 L 376 328 L 369 334 L 373 340" />
        <path className="kd-crack bx" pathLength={1} filter="url(#kd-glow)" d="M -238 318.6 L -214 317.4 L -208 320.3 L -170 315.5 L -150 318.2 L -110 314.9 L -84 317.5 L -40 314.1 L -6 316.7 L 30 314 L 52 315.8" />
        <path className="kd-crack kd-twig bx" pathLength={1} filter="url(#kd-glow)" d="M -208 320.3 L -196 325.6 M -150 318.2 L -142 324.5 L -146 328.6 M -84 317.5 L -76 324.6 M -6 316.7 L 4 324.1 L 0 328.1" />

        {/* Gandalf, on the deck, facing the shadow */}
        <g className="kd-wizard">
          <g transform="translate(-250 319)">
            <g filter="url(#kd-rim-gf)">
              {/* the cloak, streaming back in the fire's wind */}
              <path className="kd-gf kd-cloak" d="M -8 -124 C -30 -126 -58 -122 -86 -112 C -98 -108 -110 -104 -122 -104 C -114 -96 -110 -90 -112 -82 C -104 -78 -100 -72 -100 -64 C -94 -58 -90 -50 -92 -42 C -82 -36 -76 -26 -76 -16 C -62 -8 -48 -2 -36 0 C -30 -40 -22 -84 -8 -124 Z" />
              <path className="kd-gf" d="M 30 0 C 24 -24 18 -60 15 -96 C 14 -108 12 -116 7 -122 L 0 -126 C -8 -126 -14 -122 -17 -116 C -22 -90 -28 -46 -36 0 Z" />
              {/* the sword arm, Glamdring low at the shadow */}
              <path className="kd-gf" d="M 2 -121 C 14 -114 26 -106 37 -100 L 35 -93 C 24 -98 13 -102 0 -108 Z" />
              <path className="kd-gf" d="M 6 -110 C 14 -100 22 -92 28 -86 C 18 -88 10 -94 3 -102 Z" />
              {/* head, hair and beard streaming back */}
              <path className="kd-gf" d="M -4 -134 C -5 -142 -1 -147 5 -147 C 10 -147 13 -143 13 -139 L 15.5 -135 L 12.5 -134 C 12 -131 11 -130 9 -129 Z" />
              <path className="kd-gf kd-hair" d="M 4 -148 C -4 -149.5 -12 -147 -19 -142 C -26 -138 -34 -136 -44 -136 C -38 -133 -33 -131 -30 -129 C -36 -127 -42 -126 -48 -126 C -40 -121 -31 -120 -24 -122 C -28 -118 -32 -115 -37 -113 C -26 -112 -16 -117 -10 -124 C -7 -128 -5 -131 -4 -134 Z" />
              <path className="kd-gf kd-hair" d="M 12.5 -131 C 14 -124 13 -114 9 -105 C 6 -98 1 -93 -6 -89 C -3 -98 -1 -110 0 -126 Z" />
            </g>
            {/* Glamdring, cold and white */}
            <line className="kd-blade" filter="url(#kd-glow)" x1="37" y1="-97" x2="100" y2="-118" />
            <line className="kd-guard" x1="34.5" y1="-102" x2="39.5" y2="-91" />
          </g>
        </g>
        {/* the staff arm, raised; the light it holds. Leaving, he lifts it over his
            head and brings it down: the arm swings from the shoulder, and the staff,
            turned back about the fist as far, stays upright and plants its foot */}
        <g className="kd-staffin">
          <g className="kd-staffarm bx">
            <g transform="translate(-250 319)" filter="url(#kd-rim-gf)">
              <path className="kd-gf" d="M 0 -124 L 10 -128 C 18 -140 26 -156 32 -170 L 38 -168 C 34 -152 28 -138 22 -128 C 20 -122 14 -116 6 -114 Z" />
              <path className="kd-gf" d="M 6 -114 C 2 -124 8 -140 20 -150 C 18 -138 16 -128 14 -118 Z" />
              <path className="kd-gf" d="M 30 -172 L 36 -177 L 40 -171 L 35 -166 Z" />
            </g>
            <g className="kd-staffheld bx">
              <path className="kd-staff" transform="translate(-250 319)" d="M 26 -80 L 44 -262 M 44 -262 C 49 -270 41 -277 36 -272 M 44 -262 C 39 -269 48 -276 51 -269" />
              {/* what gathers at its head */}
              <ellipse className="kd-streak bx" cx={LX} cy={LY} rx="300" ry="2.4" fill="url(#kd-streak-g)" />
              <g className="kd-light">
                <circle className="kd-halo" cx={LX} cy={LY} r="140" fill="url(#kd-white)" />
                <path className="kd-spikes" d="M -206 7 L -204.6 51.6 L -162 53 L -204.6 54.4 L -206 99 L -207.4 54.4 L -250 53 L -207.4 51.6 Z M -221 38 L -206 51.8 L -191 38 L -204.8 53 L -191 68 L -206 54.2 L -221 68 L -207.2 53 Z" />
                <circle className="kd-tip" cx={LX} cy={LY} r="4.6" filter="url(#kd-glow)" />
              </g>
              <g className="kd-runes"><g>
                {/* the circle breaks under each rune: 20° gaps every 60° */}
                <circle className="kd-ring" cx={LX} cy={LY} r="47" strokeDasharray="32.8 16.4" strokeDashoffset="16.4" />
                <circle className="kd-ring kd-ticks" cx={LX} cy={LY} r="58" />
                {RUNES.map((d, i) => {
                  const a = 30 + i * 60, rad = (a * Math.PI) / 180;
                  return (
                    <g key={i} className={i < lit ? "kd-rune kd-on" : "kd-rune"} transform={`translate(${(LX + 47 * Math.sin(rad)).toFixed(1)} ${(LY - 47 * Math.cos(rad)).toFixed(1)}) rotate(${a})`}>
                      <path d={d} />
                      <circle className="kd-flare bx" r="7" />
                    </g>
                  );
                })}
              </g></g>
              <circle className={beat ? `kd-pulse kd-go-${beat} bx` : "kd-pulse"} cx={LX} cy={LY} r="24" />
            </g>
          </g>
        </g>

        {/* the strike: a sheet of white flame off the deck, and the shock along it */}
        <path className="kd-sheet bx" filter="url(#kd-glow)" fill="url(#kd-sheet-g)" d="M -246 319 C -262 293 -258 233 -244 163 C -240 213 -236 243 -232 229 C -230 183 -226 133 -218 89 C -212 153 -214 213 -206 243 C -200 223 -196 207 -192 189 C -188 243 -200 293 -214 319 Z" />
        <ellipse className="kd-shock bx" cx="-226" cy="320" rx="520" ry="30" fill="url(#kd-white)" />
        {/* motes of fire drifting past, nearer than everything */}
        <g>
          {MOTES.map(([cx, cy, r, d, t]) => (
            <circle key={cx} className="kd-mote" cx={cx} cy={cy} r={r} fill="url(#kd-mote-g)" style={{ animationDelay: `${d}s`, animationDuration: `${t}s` }} />
          ))}
        </g>
      </svg>
    </>
  );
}

// ---- DURIN'S DOOR -------------------------------------------------------------

/** One group of the door's lines, lit once `lit` reaches `at` (1..6). Every
 *  path is pathLength 1, so the ithildin's trace is a dash of 1. */
function G({ at, lit, children }: { at: number; lit: number; children: ReactNode }) {
  return <g className={lit >= at ? "dd-g dd-lit" : "dd-g"}>{children}</g>;
}
const P = (d: string) => <path pathLength={1} d={d} />;

function Tree() {
  return (
    <>
      {P("M 84 390 C 82 340 88 300 86 250 C 85 232 86 216 88 206")}
      {P("M 84 390 C 78 386 72 388 66 390 M 84 390 C 90 386 96 388 102 390")}
      {P("M 86 304 C 76 294 70 280 68 266 M 86 304 C 96 296 102 284 104 270")}
      {P("M 86 266 C 76 256 72 244 72 232 M 86 266 C 96 258 100 248 100 236")}
      {P("M 87 232 C 80 224 78 216 78 208 M 87 232 C 94 224 96 218 96 210")}
      {/* the crescent moons the trees bear */}
      {P("M 82 192 A 7 7 0 1 0 95 198 A 5.6 5.6 0 1 1 82 192")}
      {P("M 66 268 A 4 4 0 1 0 73 271 A 3.2 3.2 0 1 1 66 268 M 98 272 A 4 4 0 1 0 106 270 A 3.2 3.2 0 1 1 98 272")}
    </>
  );
}

const STAR = (x: number, y: number, s = 1) =>
  `M ${x} ${y} l ${1.2 * s} ${3.8 * s} l ${3.8 * s} ${1.2 * s} l ${-3.8 * s} ${1.2 * s} l ${-1.2 * s} ${3.8 * s} l ${-1.2 * s} ${-3.8 * s} l ${-3.8 * s} ${-1.2 * s} l ${3.8 * s} ${-1.2 * s} Z`;
// Durin's seven stars, in an arc over the crown.
const SEVEN: [number, number, number][] = [[111, 140, 1], [122, 123, 1], [140, 110, 1], [160, 105, 1.16], [180, 110, 1], [198, 123, 1], [209, 140, 1]];

/** What sits on the door's two leaves, which swing apart on the way out. */
function LeafArt({ lit }: { lit: number }) {
  return (
    <>
      <G at={3} lit={lit}>
        <Tree />
        <g transform="translate(320 0) scale(-1 1)"><Tree /></g>
      </G>
      <G at={4} lit={lit}>
        {/* crown, anvil and hammer */}
        {P("M 143 148 L 143 133 L 147.5 140 L 151.5 129 L 156 138 L 160 125 L 164 138 L 168.5 129 L 172.5 140 L 177 133 L 177 148 Z")}
        {P("M 134 176 C 140 175 144 172 148 170 H 176 V 176 C 172 178 170 180 168 184 L 170 190 H 176 V 194 H 146 V 190 H 152 L 154 184 C 150 180 142 178 134 176 Z")}
        {P("M 147 168 L 171 155 M 168 149 L 175 162 M 172 147 L 179 160")}
      </G>
      <G at={5} lit={lit}>
        {SEVEN.map(([x, y, s], i) => <path key={i} className="dd-star" pathLength={1} d={STAR(x, y, s)} style={{ animationDelay: `${-i * 0.4}s` }} />)}
      </G>
      <G at={6} lit={lit}>
        <g className="dd-gstar">
          {P("M 155 252 A 5 5 0 1 0 165 252 A 5 5 0 1 0 155 252")}
          {P("M 160 244 V 214 M 160 260 V 290 M 152 252 H 122 M 168 252 H 198 M 154.3 246.3 L 133.2 225.2 M 165.7 257.7 L 186.8 278.8 M 165.7 246.3 L 186.8 225.2 M 154.3 257.7 L 133.2 278.8")}
          {P("M 156.9 244.6 L 152.4 233.5 M 163.1 259.4 L 167.6 270.5 M 167.4 248.9 L 178.5 244.4 M 152.6 255.1 L 141.5 259.6 M 163.1 244.6 L 167.6 233.5 M 156.9 259.4 L 152.4 270.5 M 167.4 255.1 L 178.5 259.6 M 152.6 248.9 L 141.5 244.4")}
        </g>
      </G>
    </>
  );
}

/** The whole door once, in one layer's ink: the frame and the inscription stay
 *  in the wall, the rest is split onto the two leaves. */
function Door({ lit }: { lit: number }) {
  return (
    <>
      <G at={1} lit={lit}>
        {P("M 40 390 V 200 M 58 390 V 200 M 262 390 V 200 M 280 390 V 200")}
        {P("M 34 200 H 64 M 256 200 H 286 M 36 194 H 62 M 258 194 H 284")}
        {P("M 40 200 A 120 120 0 0 1 280 200")}
        {P("M 49 200 A 111 111 0 0 1 271 200")}
        {P("M 58 200 A 102 102 0 0 1 262 200")}
        {P("M 22 390 H 298 M 30 396 H 290")}
      </G>
      <G at={2} lit={lit}>
        <text fontSize="7.4"><textPath href="#dd-a1" startOffset="50%" textAnchor="middle">ENNYN DURIN ARAN MORIA · PEDO MELLON A MINNO</textPath></text>
        <text fontSize="5.6"><textPath href="#dd-a2" startOffset="50%" textAnchor="middle">IM NARVI HAIN ECHANT · CELEBRIMBOR O EREGION TEITHANT I THIW HIN</textPath></text>
      </G>
      <g className="dd-leaf dd-l bx"><g clipPath="url(#dd-left)"><LeafArt lit={lit} /></g></g>
      <g className="dd-leaf dd-r bx"><g clipPath="url(#dd-right)"><LeafArt lit={lit} /></g></g>
    </>
  );
}

// A few stars over Hollin: left %, top %, twinkle delay.
const SKY: [number, number, number][] = [[9, 22, 0], [27, 7, -1.2], [71, 12, -2.1], [86, 28, -0.6], [62, 4, -2.8], [93, 9, -1.7]];

/** DURIN'S DOOR: "Speak, friend, and enter." The West-gate of Moria in its
 *  theme's ink: the whole door shows faintly in stone, and each answered step
 *  wakes one of six groups of lines (the restart's three steps, two each).
 *  Leaving, the leaves swing open onto light. */
export function DurinsDoor({ progress }: { progress: number }) {
  const lit = Math.floor(progress * 6 + 1e-9);
  return (
    <>
      <div className="dd-field" aria-hidden>
        <div className="dd-moon" />
        {SKY.map(([l, t, d], i) => <i key={i} className="dd-skystar" style={{ left: `${l}%`, top: `${t}%`, animationDelay: `${d}s` }} />)}
      </div>
      <svg className="dd-scene" viewBox="0 0 320 470" style={{ "--p": progress } as CSSProperties} aria-hidden>
        <defs>
          <path id="dd-a1" d="M 44.5 200 A 115.5 115.5 0 0 1 275.5 200" />
          <path id="dd-a2" d="M 53.5 200 A 106.5 106.5 0 0 1 266.5 200" />
          <linearGradient id="dd-in" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" style={{ stopColor: "var(--acc)", stopOpacity: 0.6 }} />
            <stop offset="1" style={{ stopColor: "var(--acc)", stopOpacity: 0.08 }} />
          </linearGradient>
          <linearGradient id="dd-rf" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#fff" />
            <stop offset="1" stopColor="#fff" stopOpacity="0" />
          </linearGradient>
          <mask id="dd-rfm" maskUnits="userSpaceOnUse" x="0" y="392" width="320" height="78">
            <rect x="0" y="392" width="320" height="78" fill="url(#dd-rf)" />
          </mask>
          <clipPath id="dd-left"><rect x="0" y="0" width="160" height="392" /></clipPath>
          <clipPath id="dd-right"><rect x="160" y="0" width="160" height="392" /></clipPath>
          <clipPath id="dd-way"><path d="M 58 390 V 200 A 102 102 0 0 1 262 200 V 390 Z" /></clipPath>
          <filter id="dd-glow" x="-10%" y="-10%" width="120%" height="120%">
            <feGaussianBlur stdDeviation="2.4" result="b" />
            <feMerge><feMergeNode in="b" /><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge>
          </filter>
        </defs>
        {/* what is behind the door: the dashboard's light */}
        <rect className="dd-within bx" data-exit-origin x="58" y="98" width="204" height="292" fill="url(#dd-in)" clipPath="url(#dd-way)" />
        <g className="dd-stone"><Door lit={6} /></g>
        <g className="dd-ith" filter="url(#dd-glow)"><Door lit={lit} /></g>
        {/* the door in the water under the threshold */}
        <g mask="url(#dd-rfm)" opacity=".16">
          <g className="dd-ith" transform="translate(0 786) scale(1 -1)"><Door lit={lit} /></g>
        </g>
      </svg>
    </>
  );
}
