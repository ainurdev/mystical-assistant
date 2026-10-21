/* The loading screen's Middle-earth scenes (lib/intro): KHAZAD-DÛM and DURIN'S
   DOOR. BootIntro keeps the shell (the log, the bar, the CRT wipe, every
   timing) and mounts one of these where the emblem goes: an absolute field
   behind, one SVG in the flow. `progress` is the log's answered share; it
   drives the drawing (the staff's light, the door's lines). `.bootleaving` on
   the intro plays the exit inside the existing warm-up and wipe, so a scene
   costs no time.

   Glows are SVG filters (filter="url(#…)"), never CSS `filter` on an SVG
   child: WebKit, Mystical.app's engine, ignores the latter. `.bx` marks an exit
   flourish, which `.bootcontinue` must not fast-forward (index.css). The ids
   are fixed because only one intro is ever mounted: the boot, or after it the
   restart's overlay. Drafts: .mystical/design-drafts/lotr-boot/. */
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
const SOFT: Flame[] = [[-54, -256, 34, 2.2, 0], [-24, -238, 44, 2.8, -0.4], [12, -232, 52, 2.6, -0.8], [40, -214, 64, 2, -0.2], [-90, -196, -22, 1.4, -0.6]];
const MANE: Flame[] = [
  [-60, -256, 28, 0.9, 0], [-48, -258, 34, 1.4, -0.3], [-40, -250, 40, 1.2, -0.7, 0.9], [-30, -238, 44, 1.8, -0.15],
  [-14, -234, 46, 1.5, -0.5, 1.3], [2, -234, 50, 1.9, -0.9], [20, -230, 56, 1.4, -0.4, 0.95], [34, -220, 62, 1.3, -0.65],
  [42, -202, 74, 1.1, -0.25, 0.85], [-22, -240, 30, 0.8, -0.2, 0.8], [10, -240, 40, 0.9, -0.75, 0.85],
  // down the sword arm
  [-62, -188, -12, 1, -0.35, 1.05], [-84, -188, -20, 0.85, -0.1, 0.9], [-104, -194, -26, 0.8, -0.6, 1],
  // the bridge burns where it treads
  [-58, 0, -6, 0.9, -0.3, 0.9], [-44, 0, 8, 0.6, -0.6, 0.8], [38, 0, 6, 0.8, -0.1, 1], [54, 0, -8, 0.55, -0.45, 0.85],
];
const SPARKS: [cx: number, cy: number, r: number, delay: number, dur: number][] = [
  [-40, -262, 1.4, 0, 3.4], [-10, -266, 1.1, -1.1, 2.8], [20, -256, 1.6, -2.2, 4], [-64, -262, 1, -0.6, 3.1],
  [40, -236, 1.2, -1.8, 3.7], [-90, -250, 1.2, -2.6, 3.3], [60, -210, 1, -0.3, 2.9],
];
// Embers rising out of the deep, across the whole screen: left %, bottom %, delay, duration.
const EMBERS: [number, number, number, number][] = [
  [58, 6, -0.4, 6], [64, 2, -2.1, 7], [47, 4, -3.6, 8], [71, 9, -1.2, 5.4], [39, 1, -4.8, 6], [55, 12, -5.5, 6.6], [78, 5, -2.9, 7.4],
];
// The Dwarrowdelf's pillars, nearest at the edges: opacity, x positions (% of the screen).
const PILLARS: [number, number[]][] = [[0.16, [3, 7.5, 92.5, 97]], [0.1, [16, 18.6, 81.4, 84]], [0.06, [25.5, 27, 73, 74.5]]];

// The deck: one arch between the cliffs. The strike breaks out x 40..262.
const DECK = (
  <>
    <path className="kd-deckfill" d="M -560 331 Q 20 325 600 331 L 600 380 Q 20 300 -560 380 Z" />
    <path className="kd-deckline" d="M -560 331 Q 20 325 600 331" />
    <path className="kd-deckunder" d="M 600 380 Q 20 300 -560 380" />
  </>
);

/** KHAZAD-DÛM: "You shall not pass." Gandalf holds the bridge while the
 *  dashboard loads, his light growing with each answered step; leaving, he
 *  strikes and the span under the Balrog falls. Always drawn at night: the
 *  intro hands this scene a dark ground (lib/theme nightOf). */
export function KhazadDum({ progress }: { progress: number }) {
  return (
    <>
      <div className="kd-field" aria-hidden>
        <svg className="kd-pillars" viewBox="0 0 100 100" preserveAspectRatio="none">
          {PILLARS.map(([o, xs]) => (
            <g key={o} style={{ opacity: o }}>{xs.map((x) => <line key={x} x1={x} y1={0} x2={x} y2={100} />)}</g>
          ))}
        </svg>
        <div className="kd-deep" />
        {EMBERS.map(([l, b, d, t], i) => (
          <i key={i} className="kd-ember" style={{ left: `${l}%`, bottom: `${b}%`, animationDelay: `${d}s`, animationDuration: `${t}s` }} />
        ))}
      </div>
      <div className="kd-flash bx" aria-hidden />

      <svg className="kd-scene" viewBox="-1400 0 2800 440" style={{ "--p": progress } as CSSProperties} aria-hidden>
        <defs>
          <radialGradient id="kd-back">
            <stop offset="0" style={{ stopColor: "var(--err)", stopOpacity: 0.46 }} />
            <stop offset=".45" style={{ stopColor: "var(--warn)", stopOpacity: 0.1 }} />
            <stop offset="1" style={{ stopColor: "var(--warn)", stopOpacity: 0 }} />
          </radialGradient>
          <radialGradient id="kd-white">
            <stop offset="0" style={{ stopColor: "var(--txb)", stopOpacity: 0.95 }} />
            <stop offset=".35" style={{ stopColor: "var(--txb)", stopOpacity: 0.22 }} />
            <stop offset="1" style={{ stopColor: "var(--txb)", stopOpacity: 0 }} />
          </radialGradient>
          <linearGradient id="kd-fire" x1="0" y1="1" x2="0" y2="0">
            <stop offset="0" style={{ stopColor: "var(--warn)" }} />
            <stop offset=".5" style={{ stopColor: "var(--err)", stopOpacity: 0.9 }} />
            <stop offset="1" style={{ stopColor: "var(--err)", stopOpacity: 0 }} />
          </linearGradient>
          <linearGradient id="kd-blade" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0" style={{ stopColor: "var(--warn)", stopOpacity: 0.95 }} />
            <stop offset=".7" style={{ stopColor: "var(--err)", stopOpacity: 0.8 }} />
            <stop offset="1" style={{ stopColor: "var(--err)", stopOpacity: 0 }} />
          </linearGradient>
          <linearGradient id="kd-fade" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0" stopColor="#fff" stopOpacity="0" />
            <stop offset=".3" stopColor="#fff" />
            <stop offset=".7" stopColor="#fff" />
            <stop offset="1" stopColor="#fff" stopOpacity="0" />
          </linearGradient>
          <linearGradient id="kd-dn" x1="0" y1="0" x2="0" y2="1">
            <stop offset=".72" stopColor="#fff" />
            <stop offset="1" stopColor="#fff" stopOpacity="0" />
          </linearGradient>
          <mask id="kd-ends" maskUnits="userSpaceOnUse" x="-1400" y="0" width="2800" height="440">
            <rect x="-1400" y="0" width="2800" height="440" fill="url(#kd-fade)" />
          </mask>
          <mask id="kd-down" maskUnits="userSpaceOnUse" x="-1400" y="0" width="2800" height="440">
            <rect x="-1400" y="0" width="2800" height="440" fill="url(#kd-dn)" />
          </mask>
          {/* a 1.3px rim round the union of the group, then its glow */}
          <filter id="kd-rim-fire" x="-30%" y="-30%" width="160%" height="160%">
            <feMorphology in="SourceAlpha" operator="dilate" radius="1.3" result="d" />
            <feComposite in="d" in2="SourceAlpha" operator="out" result="ring" />
            <feFlood className="kd-ff-err" result="c" />
            <feComposite in="c" in2="ring" operator="in" result="rim" />
            <feGaussianBlur in="rim" stdDeviation="3.5" result="glow" />
            <feMerge><feMergeNode in="glow" /><feMergeNode in="glow" /><feMergeNode in="SourceGraphic" /><feMergeNode in="rim" /></feMerge>
          </filter>
          <filter id="kd-rim-white" x="-30%" y="-30%" width="160%" height="160%">
            <feMorphology in="SourceAlpha" operator="dilate" radius="1.1" result="d" />
            <feComposite in="d" in2="SourceAlpha" operator="out" result="ring" />
            <feFlood className="kd-ff-txb" result="c" />
            <feComposite in="c" in2="ring" operator="in" result="rim" />
            <feGaussianBlur in="rim" stdDeviation="2.5" result="glow" />
            <feMerge><feMergeNode in="glow" /><feMergeNode in="SourceGraphic" /><feMergeNode in="rim" /></feMerge>
          </filter>
          {/* the bbox-relative region is wide on purpose: thin strokes have thin boxes */}
          <filter id="kd-glow" x="-200%" y="-200%" width="500%" height="500%">
            <feGaussianBlur stdDeviation="3" result="b" />
            <feMerge><feMergeNode in="b" /><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge>
          </filter>
          <filter id="kd-soft" x="-100%" y="-100%" width="300%" height="300%"><feGaussianBlur stdDeviation="5" /></filter>
          <filter id="kd-smoke" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="7" /></filter>
          <path id="kd-flame" d="M0 0 C -5 -3 -6 -10 -3 -17 C -2 -12 0 -11 1 -14 C 1 -20 3 -25 2 -30 C 7 -23 8 -14 6 -7 C 5 -3 3 0 0 0 Z" />
          <clipPath id="kd-mid"><path d="M 40 0 H 262 V 329 L 268 334 L 259 339 L 266 345 L 262 440 H 40 L 41 352 L 37 343 L 43 338 L 34 334 L 40 329 Z" /></clipPath>
          <clipPath id="kd-sides"><path d="M -1400 0 H 40 V 329 L 34 334 L 43 338 L 37 343 L 41 352 L 40 440 H -1400 Z M 262 0 H 1400 V 440 H 262 L 266 345 L 259 339 L 268 334 L 262 329 Z" /></clipPath>
        </defs>

        {/* fire behind the shadow */}
        <ellipse className="kd-backlight bx" cx="130" cy="150" rx="330" ry="250" fill="url(#kd-back)" />

        <g className="kd-falls bx">
          <g className="kd-balrog">
            <g transform="translate(120 330)">
              <g filter="url(#kd-smoke)" opacity=".9">
                <ellipse className="kd-bk" cx="0" cy="-226" rx="140" ry="64" />
                <ellipse className="kd-bk" cx="-6" cy="-140" rx="74" ry="100" />
              </g>
              {/* wings of shadow, ragged, with their bones */}
              <g filter="url(#kd-rim-fire)" opacity=".8">
                <path className="kd-wing kd-far" d="M -6 -226 C -50 -270 -140 -298 -252 -304 C -234 -292 -230 -276 -236 -260 C -216 -268 -196 -262 -190 -248 C -174 -258 -154 -254 -148 -240 C -130 -250 -110 -246 -100 -234 C -80 -240 -56 -236 -30 -218 Z" />
                <path className="kd-wing" d="M 8 -222 C 56 -268 136 -302 262 -308 C 238 -290 234 -270 248 -250 C 222 -254 206 -240 210 -220 C 186 -228 166 -216 166 -196 C 144 -204 124 -194 120 -174 C 100 -184 78 -180 64 -162 C 52 -170 34 -172 22 -168 Z" />
              </g>
              <path className="kd-bones" d="M 8 -214 L 262 -308 M 120 -262 L 248 -250 M 104 -252 L 210 -220 M 88 -240 L 166 -196 M 72 -228 L 120 -174 M -6 -226 L -252 -304 M -120 -268 L -236 -260 M -104 -262 L -190 -248 M -86 -254 L -148 -240" />
              {/* the far arm, low, with the whip */}
              <g filter="url(#kd-rim-fire)">
                <line className="kd-limb" x1="16" y1="-208" x2="40" y2="-166" strokeWidth="26" />
                <line className="kd-limb" x1="40" y1="-166" x2="50" y2="-128" strokeWidth="20" />
                <circle className="kd-bk" cx="51" cy="-122" r="11" />
              </g>
              <g className="kd-whipg">
                <path className="kd-whip" filter="url(#kd-glow)" d="M 54 -116 C 92 -104 112 -64 96 -38 C 84 -18 114 -4 152 -10 C 180 -14 200 0 222 -6" />
              </g>
              {/* the body: one silhouette, rimmed in fire */}
              <g filter="url(#kd-rim-fire)">
                <line className="kd-limb" x1="14" y1="-118" x2="30" y2="-66" strokeWidth="38" />
                <line className="kd-limb" x1="30" y1="-66" x2="46" y2="-14" strokeWidth="26" />
                <path className="kd-bk" d="M 34 -20 L 60 -10 L 64 0 L 30 0 Z" />
                <line className="kd-limb" x1="-14" y1="-118" x2="-40" y2="-66" strokeWidth="40" />
                <line className="kd-limb" x1="-40" y1="-66" x2="-50" y2="-14" strokeWidth="27" />
                <path className="kd-bk" d="M -38 -20 L -66 -8 L -74 0 L -36 0 Z" />
                <ellipse className="kd-bk" cx="0" cy="-122" rx="28" ry="18" />
                <path className="kd-bk" d="M -46 -204 C -48 -222 -20 -234 12 -232 C 34 -230 44 -216 42 -198 C 40 -170 26 -146 18 -126 C 6 -114 -14 -114 -24 -126 C -34 -148 -44 -178 -46 -204 Z" />
                <ellipse className="kd-bk" cx="-36" cy="-212" rx="20" ry="16" />
                {/* neck and head: heavy brow, jaw open on the fire inside */}
                <path className="kd-bk" d="M -30 -226 L -58 -236 L -64 -212 L -36 -202 Z" />
                <path className="kd-bk" d="M -42 -238 C -44 -252 -56 -258 -66 -254 C -72 -252 -78 -246 -80 -240 L -88 -230 L -84 -226 L -66 -224 L -62 -220 L -84 -214 L -82 -208 C -70 -204 -52 -206 -44 -214 C -38 -220 -38 -230 -42 -238 Z" />
                {/* horns, out and forward like a bull's */}
                <path className="kd-bk" d="M -48 -250 C -50 -270 -60 -286 -82 -294 C -70 -282 -64 -268 -60 -250 Z" />
                <path className="kd-bk" d="M -60 -250 C -68 -268 -84 -280 -108 -280 C -92 -272 -82 -262 -74 -246 Z" />
                {/* the sword arm, raised at the light */}
                <line className="kd-limb" x1="-44" y1="-206" x2="-70" y2="-172" strokeWidth="28" />
                <line className="kd-limb" x1="-70" y1="-172" x2="-112" y2="-184" strokeWidth="22" />
                <circle className="kd-bk" cx="-118" cy="-186" r="12" />
              </g>
              <g filter="url(#kd-glow)">
                <path className="kd-maw" d="M -84 -224 L -64 -222 L -80 -216 Z" />
                <path className="kd-crack" d="M -30 -196 L -20 -178 L -24 -160 M 6 -210 L 14 -192 M 20 -170 L 26 -152 M -12 -150 L -6 -134 M -44 -70 L -42 -52 M 30 -78 L 34 -62 M -76 -180 L -96 -182" />
                <ellipse className="kd-eye" cx="-68" cy="-243" rx="3.4" ry="1.7" transform="rotate(-12 -68 -243)" />
                {/* the flame sword, at the light */}
                <path className="kd-sword" d="M -124 -194 L -270 -252 L -260 -237 L -120 -180 Z" />
              </g>
              {/* the mane: soft fire behind, tongues in front, streaming back */}
              <g filter="url(#kd-soft)" opacity=".55">{SOFT.map((f, i) => <F key={i} f={f} />)}</g>
              <g>{MANE.map((f, i) => <F key={i} f={f} />)}</g>
              <g>
                {SPARKS.map(([cx, cy, r, d, t], i) => (
                  <circle key={i} className="kd-spark" cx={cx} cy={cy} r={r} style={{ animationDelay: `${d}s`, animationDuration: `${t}s` }} />
                ))}
              </g>
            </g>
          </g>
          <g clipPath="url(#kd-mid)" mask="url(#kd-ends)" className="kd-deck">{DECK}</g>
        </g>
        <g clipPath="url(#kd-sides)" mask="url(#kd-ends)" className="kd-deck">{DECK}</g>
        {/* the chasm's two cliffs, and the hall's floor beyond them */}
        <g className="kd-cliffs" mask="url(#kd-down)">
          <path className="kd-cliff" d="M -1400 331 L -560 331 L -566 352 L -556 378 L -572 404 L -561 440 L -1400 440 Z" />
          <path className="kd-cliff" d="M 1400 331 L 600 331 L 607 356 L 596 382 L 611 410 L 601 440 L 1400 440 Z" />
        </g>
        <path className="kd-split bx" filter="url(#kd-glow)" d="M 40 329 L 34 334 L 43 338 L 37 343 L 41 352 M 262 329 L 268 334 L 259 339 L 266 345 L 262 357" />

        {/* Gandalf, facing the shadow */}
        <g className="kd-wizard">
          <g transform="translate(-240 330) scale(1.1)">
            <g filter="url(#kd-rim-white)">
              <path className="kd-gf" d="M 4 -96 C 10 -84 12 -60 14 -40 C 16 -20 20 -8 26 0 L -18 0 C -28 0 -40 -2 -54 -8 C -46 -22 -40 -30 -42 -40 C -32 -58 -24 -76 -14 -90 C -8 -96 -2 -98 4 -96 Z" />
              <path className="kd-gf" d="M -3 -118 C -14 -119 -24 -113 -29 -102 C -33 -94 -36 -86 -41 -77 C -33 -84 -27 -92 -20 -98 C -15 -101 -10 -103 -6 -103 Z" />
              <path className="kd-gf" d="M -6 -110 C -15 -108 -20 -100 -23 -91 C -25 -84 -27 -78 -30 -71 C -23 -79 -17 -88 -9 -96 Z" />
              <path className="kd-gf" d="M -6 -108 C -7 -115 -3 -119 2 -119 C 6 -118 8 -115 7 -110 L 9.5 -104 L 6.5 -103 C 6 -101 6 -100 5 -99 C 0 -98 -5 -101 -6 -108 Z" />
              <path className="kd-gf" d="M 5 -100 C 9 -96 9 -90 6 -84 C 3 -78 -2 -74 -8 -70 C -6 -78 -4 -86 -2 -96 Z" />
              <path className="kd-gf" d="M 6 -90 C 14 -86 24 -80 32 -74 L 30 -68 C 22 -73 12 -78 2 -82 Z" />
            </g>
            {/* Glamdring, cold and white */}
            <line className="kd-blade" filter="url(#kd-glow)" x1="34" y1="-72" x2="84" y2="-92" />
            <line className="kd-guard" x1="31.5" y1="-77.5" x2="36.5" y2="-66.5" />
          </g>
        </g>
        {/* the staff arm, raised; leaving, it comes down */}
        <g className="kd-staffin">
          <g className="kd-staffarm bx">
            <g transform="translate(-240 330) scale(1.1)">
              <g filter="url(#kd-rim-white)">
                <path className="kd-gf" d="M -1 -96 L 10 -112 L 18 -128 L 22 -125 L 15 -110 L 7 -93 Z" />
                <path className="kd-gf" d="M 16 -122 C 10 -116 4 -106 -1 -94 C 3 -94 6 -96 8 -100 C 10 -106 13 -112 18 -117 Z" />
              </g>
              <line className="kd-staff" x1="6" y1="-40" x2="30" y2="-188" />
              <path className="kd-staff" strokeWidth="1.6" d="M 30 -188 C 32 -194 26 -198 23 -193" />
            </g>
            <g className="kd-light">
              <circle className="kd-halo" cx="-207" cy="123" r="96" fill="url(#kd-white)" />
              <g className="kd-rays">
                <line x1="-207" y1="91" x2="-207" y2="155" /><line x1="-239" y1="123" x2="-175" y2="123" />
                <line x1="-220" y1="110" x2="-194" y2="136" /><line x1="-220" y1="136" x2="-194" y2="110" />
              </g>
              <circle className="kd-ring" cx="-207" cy="123" r="34" />
              <circle className="kd-ring kd-r2" cx="-207" cy="123" r="34" />
              <circle className="kd-tip" cx="-207" cy="123" r="3.4" filter="url(#kd-glow)" />
            </g>
          </g>
        </g>
        <ellipse className="kd-shock bx" cx="-233" cy="331" rx="460" ry="28" fill="url(#kd-white)" />
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
        <rect className="dd-within bx" x="58" y="98" width="204" height="292" fill="url(#dd-in)" clipPath="url(#dd-way)" />
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
