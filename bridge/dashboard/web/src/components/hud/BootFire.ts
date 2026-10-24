/* KHAZAD-DÛM's fire (BootScenes KhazadDum): one WebGL canvas under the scene's
   SVG draws what SVG can't make real. Flame moves like flame, smoke rolls, the
   staff's light scatters in it, embers rise. It also draws the shapes that live
   in that light:
   - the Balrog: a shadow with a lava hide and a burning mane. It falls when the
     span breaks.
   - Gandalf: his cloak and hair ripple in the fire's wind.
   - the whip: it cracks up out of the deep and drags him off the bridge.
   The SVG keeps the hall, the bridge, the staff with its light and runes, and
   the strike. It hides the parts drawn here (.kd-scene[data-gl], index.css).

   The shapes come from the rendered SVG itself (the FireRim outlines, the mane's
   flame placements, the blade, the whip, the wizard's paths). They are painted
   once into mask textures, so the path data lives in one place. Anything that
   moves is a uniform, which costs WebKit nothing; a filtered SVG group that
   moves re-runs its filters every frame (BootScenes). Gandalf's fall is the CSS
   animation on .kd-gandalf, read here each frame, so the SVG parts he carries
   move with the body drawn here.

   Measured in a WKWebView at 60 Hz, the hold, the strike and the wipe keep a
   median 17 ms frame, as the all-SVG scene did. The masks and the shader cost
   one ~60 ms frame at mount. Spec: docs/superpowers/specs/lotr-loading-screens.md. */

const VERT = `attribute vec2 a; void main() { gl_Position = vec4(a, 0.0, 1.0); }`;

const FRAG = `
precision highp float;
uniform vec2 uRes, uOrg;
uniform float uT, uP, uBeat, uLeave, uIn, uWiz, uLO, uLash;
uniform vec2 uL, uLashH, uLashC, uLashA;
uniform vec3 cErr, cWarn, cTxb, cInfo, cVoid, cCanvas;
uniform sampler2D tS, tB, tC, tH, tW, tV;
uniform vec4 uMR, uWR, uLashBox;
uniform vec3 uFall;
uniform mat3 uGI;

vec3 permute(vec3 x) { return mod(((x * 34.0) + 1.0) * x, 289.0); }
// 2D simplex noise (Ashima Arts, Ian McEwan; MIT)
float snoise(vec2 v) {
  const vec4 C = vec4(0.211324865405187, 0.366025403784439, -0.577350269189626, 0.024390243902439);
  vec2 i = floor(v + dot(v, C.yy));
  vec2 x0 = v - i + dot(i, C.xx);
  vec2 i1 = (x0.x > x0.y) ? vec2(1.0, 0.0) : vec2(0.0, 1.0);
  vec4 x12 = x0.xyxy + C.xxzz;
  x12.xy -= i1;
  i = mod(i, 289.0);
  vec3 p = permute(permute(i.y + vec3(0.0, i1.y, 1.0)) + i.x + vec3(0.0, i1.x, 1.0));
  vec3 m = max(0.5 - vec3(dot(x0, x0), dot(x12.xy, x12.xy), dot(x12.zw, x12.zw)), 0.0);
  m = m * m; m = m * m;
  vec3 x = 2.0 * fract(p * C.www) - 1.0;
  vec3 h = abs(x) - 0.5;
  vec3 ox = floor(x + 0.5);
  vec3 a0 = x - ox;
  m *= 1.79284291400159 - 0.85373472095314 * (a0 * a0 + h * h);
  vec3 g;
  g.x = a0.x * x0.x + h.x * x0.y;
  g.yz = a0.yz * x12.xz + h.yz * x12.yw;
  return 130.0 * dot(m, g);
}
float fbm(vec2 p) { float s = 0.0, a = 0.5; for (int i = 0; i < 5; i++) { s += a * snoise(p); p = p * 2.02 + vec2(11.3, 7.1); a *= 0.5; } return s; }
float fbm3(vec2 p) { float s = 0.0, a = 0.5; for (int i = 0; i < 3; i++) { s += a * snoise(p); p = p * 2.02 + vec2(11.3, 7.1); a *= 0.5; } return s; }
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
vec2 hash2(vec2 p) { return fract(sin(vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)))) * 43758.5453); }
// cell borders (F2 - F1): ~0 along the cracks between cooled plates
float plates(vec2 x) {
  vec2 n = floor(x), f = fract(x);
  float d1 = 8.0, d2 = 8.0;
  for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
    vec2 g = vec2(float(i), float(j));
    vec2 r = g + hash2(n + g) - f;
    float d = dot(r, r);
    if (d < d1) { d2 = d1; d1 = d; } else if (d < d2) { d2 = d; }
  }
  return sqrt(d2) - sqrt(d1);
}

// fire's colours: a blackbody ramp (ember, flame, orange, yellow, white heat), tinted toward the
// theme's --err and --warn (the tokens alone made a salmon-pink fire); HDR, tone-mapped at the end
vec3 ramp(float x) {
  x = clamp(x, 0.0, 1.6);
  vec3 c = mix(vec3(0.0), vec3(0.32, 0.03, 0.01), smoothstep(0.0, 0.22, x));
  c = mix(c, vec3(0.9, 0.2, 0.04), smoothstep(0.15, 0.45, x));
  c = mix(c, vec3(1.0, 0.52, 0.1), smoothstep(0.4, 0.7, x));
  c = mix(c, vec3(1.05, 0.82, 0.38), smoothstep(0.65, 0.95, x));
  c = mix(c, vec3(1.0, 0.96, 0.86) * 1.6, smoothstep(0.92, 1.4, x));
  vec3 th = mix(cErr * smoothstep(0.0, 0.5, x), cWarn * 1.2, smoothstep(0.45, 0.95, x));
  return mix(c, th, 0.3);
}
// flame: how far above its fuel a point is, against noise rising through it
float tongue(float fuel, vec2 q, float t) {
  float n = fbm3(vec2(q.x * 0.016, q.y * 0.011 + t * 2.6) + vec2(snoise(q * 0.006 + vec2(0.0, t * 0.5)) * 0.4, 0.0)) * 0.5 + 0.5;
  return clamp(fuel * 1.35 - (1.0 - n) * 1.05, 0.0, 1.0);
}
vec3 mask(sampler2D t, vec2 q) { return texture2D(t, (q - uMR.xy) / uMR.zw).rgb; }
vec3 wmask(vec2 q) { return texture2D(tW, (q - uWR.xy) / uWR.zw).rgb; }
float wcov(vec2 q) { vec3 w = wmask(q); return max(max(w.r, w.g), w.b); }

// smoke: billows drifting west and up off the fire, thickest round the shadow and under the roof
vec2 drift(float t) { return vec2(34.0, 22.0) * t; }
float smokeField(vec2 q, float t) {
  vec2 s = (q + drift(t)) * 0.0017;
  float w = fbm3(s * 1.3 + vec2(0.0, t * 0.03));
  return fbm(s + vec2(w * 0.35, w * 0.2)) * 0.5 + 0.5;
}
float smokeCheap(vec2 q, float t) { return fbm3((q + drift(t)) * 0.0017) * 0.5 + 0.5; }
float smokeEnv(vec2 q) {
  return (0.2 + 0.8 * smoothstep(-900.0, 250.0, q.x)) * (0.25 + 0.75 * (1.0 - smoothstep(-120.0, 320.0, q.y)));
}

void main() {
  vec2 p = vec2(gl_FragCoord.x, uRes.y - gl_FragCoord.y) - uOrg;   // scene units (a CSS px each), y down
  float t = uT, ready = uP;
  float blow = uLeave < 300.0 ? 0.0 : exp(-(uLeave - 300.0) / 170.0);   // the staff's blow, landing at 300 ms
  float flinch = exp(-uBeat * 5.0);                                       // a step just answered
  float fallK = smoothstep(0.0, 1.0, uFall.y / 200.0);
  float lightK = (0.35 + 0.85 * ready + 0.6 * flinch + 0.9 * blow) * uLO;
  float fireK = (1.0 - 0.3 * ready) * (1.0 - 0.6 * blow);
  vec3 cool = mix(cTxb, cInfo, 0.3);
  float dl = length(p - uL);

  // heat shimmer over the fire
  float heat = smoothstep(-250.0, 330.0, p.y) * exp(-pow((p.x - 215.0) / 420.0, 2.0));
  vec2 hp = p + vec2(snoise(p * 0.028 + vec2(0.0, t * 1.7)), snoise(p * 0.028 + vec2(5.2, t * 1.7))) * 2.6 * heat;

  vec3 col = mix(cCanvas, cVoid, 0.6);

  // the deep: the chasm's own fire, far below
  float deepY = smoothstep(360.0, 820.0, p.y);
  float dn = fbm3(vec2(p.x * 0.005, p.y * 0.0022 + t * 0.22)) * 0.5 + 0.5;
  col += ramp(0.2 + 0.38 * dn) * deepY * 0.3 * exp(-pow((p.x - 80.0) / 900.0, 2.0));

  // smoke rolling off the fire under the roof, lit from below by the fire and near the wizard by his light
  float sf = smokeField(hp, t);
  float smokeA = smoothstep(0.38, 0.76, sf) * smokeEnv(p);
  vec2 F = vec2(215.0, 230.0);
  float litF = clamp(0.5 + (smokeCheap(hp, t) - smokeCheap(hp + normalize(F - hp) * 30.0, t)) * 3.0, 0.0, 1.0);
  float fireOn = exp(-pow(length((hp - F) * vec2(1.0, 0.75)) / 380.0, 2.0)) * (1.0 - 0.3 * ready) * (1.0 - 0.5 * blow);
  float sl = lightK / (1.0 + pow(dl / (150.0 + 130.0 * ready), 2.0));
  vec3 smokeCol = cVoid * 0.55 + ramp(0.4) * fireOn * (0.25 + 0.75 * litF) * 0.5 + cool * sl * 0.16;
  col = mix(col, smokeCol, smokeA * 0.9);
  // the fire it stands in: tongues rising behind it off a bed of fire beyond the deck
  float fx = exp(-pow((hp.x - 215.0) / 280.0, 2.0));
  float bed = smoothstep(-120.0, 330.0, hp.y) * fx * (1.0 - 0.7 * smoothstep(330.0, 470.0, hp.y));
  float fire = tongue(bed, hp, t) * (1.0 - 0.7 * smoothstep(330.0, 390.0, hp.y)) * (1.0 - smoothstep(340.0, 480.0, hp.y)) * (1.0 - 0.6 * fallK) * (1.0 - 0.45 * flinch) * fireK;
  col += ramp(fire * 1.25 + bed * 0.08);

  // the shadow, in its own frame: it falls when the span breaks
  vec2 piv = vec2(205.0, 316.0);
  float ca = cos(uFall.z), sa = sin(uFall.z);
  vec2 bp = piv + mat2(ca, -sa, sa, ca) * (p - uFall.xy - piv);
  vec2 bh = bp + (hp - p) * 0.7;
  vec3 S = mask(tS, bh);   // its front (trunk, head, horns, sword arm), its back (wings, far arm), white-hot cores
  vec3 B = mask(tB, bh);   // all of it softened a little, softened a lot; its fire's sources softened
  vec3 Cc = mask(tC, bh);  // cores softened, its trunk (where the cracks run), its front softened a little
  vec2 Wh = mask(tH, bh).rg; // the whip hanging from its fist, and its fire
  float hang = 1.0 - smoothstep(0.0, 0.12, uLash);

  // a shadow, its outline boiling like the smoke it is made of; the wings thin into smoke at their tips
  float en = snoise(bp * 0.06 + vec2(0.0, t * 1.3)) * 0.6 + snoise(bp * 0.15 + vec2(0.0, t * 2.8)) * 0.3;
  float wing = clamp(S.g - S.r, 0.0, 1.0) * smoothstep(60.0, 300.0, length(bp - vec2(195.0, 30.0)));
  float back = smoothstep(0.4, 0.6, mix(S.g, B.r, 0.5) + en * (0.12 + 0.3 * wing) - wing * 0.25 * (snoise(bp * 0.02 + vec2(t * 0.3, t * 0.2)) * 0.5 + 0.5));
  float fore = smoothstep(0.4, 0.6, mix(S.r, Cc.b, 0.5) + en * 0.12);
  float body = max(back, fore);
  float inner = snoise(bp * 0.018 + vec2(t * 0.08, -t * 0.12)) * 0.5 + 0.5;
  vec3 bc = cVoid * (0.1 + 0.14 * inner);
  // fire inside it: its chest, and magma cracks over its trunk
  float chest = exp(-pow(length((bp - vec2(150.0, 95.0)) * vec2(1.0, 0.8)) / 72.0, 2.0));
  float pv = plates(bp * vec2(0.034, 0.03) + vec2(snoise(bp * 0.02), snoise(bp * 0.02 + 4.0)) * 0.35);
  float crack = (1.0 - smoothstep(0.0, 0.07, pv)) + (1.0 - smoothstep(0.0, 0.32, pv)) * 0.18;
  crack *= Cc.g * (0.15 + 0.85 * chest) * (0.7 + 0.3 * sin(t * 2.0 + bp.y * 0.04)) * (1.0 - 0.3 * ready);
  vec3 fc = bc + ramp(0.62 + 0.4 * chest) * crack * 1.3 + ramp(0.35) * chest * Cc.g * 0.12;
  // its edges: the fire behind catches the top and the back, the wizard's light the front
  vec2 ex = vec2(4.0 / uMR.z, 0.0), ey = vec2(0.0, 4.0 / uMR.w);
  vec2 muv = (bh - uMR.xy) / uMR.zw;
  vec2 g = vec2(texture2D(tB, muv + ex).r - texture2D(tB, muv - ex).r, texture2D(tB, muv + ey).r - texture2D(tB, muv - ey).r);
  vec2 nrm = length(g) > 1e-4 ? -normalize(g) : vec2(0.0);
  vec2 gf = vec2(texture2D(tC, muv + ex).b - texture2D(tC, muv - ex).b, texture2D(tC, muv + ey).b - texture2D(tC, muv - ey).b);
  vec2 nf = length(gf) > 1e-4 ? -normalize(gf) : vec2(0.0);
  float band = body * (1.0 - smoothstep(0.5, 0.8, B.r));
  float foreBand = fore * (1.0 - smoothstep(0.5, 0.8, Cc.b));
  vec2 up = normalize(vec2(0.45, -1.0));
  float facing = max(0.0, dot(nrm, normalize(uL - bp))) * lightK / (1.0 + pow(length(uL - bp) / (280.0 + 160.0 * ready), 2.0));

  // its back (wings, far arm), then the mane's fire, then its front: the horns and the head stand dark against the flames
  col = mix(col, bc, back);
  col += ramp(0.45) * B.g * (1.0 - body) * 0.35 * fireK;
  // falling, the fire streams up off it; the samples are jittered so a long reach can't break into copies
  float len = 1.0 + 0.4 * flinch + 1.2 * fallK;
  float jit = fallK * hash(bp + fract(t * 7.0));
  float fuel = 0.0;
  for (int k = 0; k < 7; k++) {
    float fk = float(k) + jit;
    vec2 q = bp + vec2(fk * 3.6, fk * 9.0) * len;
    fuel += (mask(tB, q).b + mask(tH, q).g * hang) * (1.0 - fk / 8.0);
  }
  float flame = tongue(clamp(fuel * 1.05, 0.0, 1.0), bp + vec2(0.0, 40.0), t * 1.25) * (1.0 - 0.55 * blow);
  col += ramp(flame * 1.55 + flame * flame * 0.35) * (1.0 - 0.9 * fore);
  col = mix(col, fc, fore);
  col += band * (ramp(0.78) * (max(0.0, dot(nrm, up)) * 1.2 + 0.2) * fireK + cool * facing * 0.9);
  col += foreBand * (1.0 - band) * ramp(0.72) * (max(0.0, dot(nf, up)) * 0.9 + 0.15) * fireK;
  // the blade, its eye and maw, and the whip while it hangs: white-hot
  col += ramp(1.05) * (S.b + Wh.r * hang) * 1.1 + ramp(0.62) * (Cc.r + Wh.g * 0.4 * hang) * 0.9;

  // Gandalf, in his own frame at rest (the whip drags him off the bridge at the end); the fire's
  // wind ripples his cloak and hair, more toward their trailing ends; his light rims him from above
  vec2 wp = (uGI * vec3(p, 1.0)).xy;
  float wiz = 0.0;
  if (uWiz > 0.0 && all(greaterThan(wp, uWR.xy)) && all(lessThan(wp, uWR.xy + uWR.zw))) {
    float tail = 1.0 - smoothstep(-372.0, -262.0, wp.x);
    vec2 wq = wp + vec2(snoise(vec2(wp.x * 0.03 - t * 5.0, wp.y * 0.03)) * 0.3, snoise(vec2(wp.x * 0.035 - t * 5.5, wp.y * 0.035 + 3.0))) * 3.5 * tail;
    vec3 W = wmask(wq);   // his body, his cloak, his hair
    wiz = max(max(W.r, W.g), W.b) * uWiz;
    // lit as his SVG filter lit him: his top edges by his own light, his front by the fire, a pale rim round him
    float topE = wiz * (1.0 - wcov(wq - vec2(0.0, 2.2)));
    float frontE = wiz * (1.0 - wcov(wq + vec2(2.0, 0.0)));
    float halo = min(texture2D(tV, (wq - uWR.xy) / uWR.zw).r * 1.6, 1.0) * (1.0 - wiz / max(uWiz, 1e-3)) * uWiz;
    vec3 wc = mix(mix(mix(cVoid, cTxb, 0.04), mix(cVoid, cTxb, 0.07), W.r), mix(cVoid, cTxb, 0.72), W.b);
    col = mix(col, wc, wiz);
    col += cTxb * topE * (0.45 + 0.55 * min(lightK, 1.2)) + cWarn * frontE * 0.85 * fireK + cTxb * halo * 0.5 * min(0.4 + lightK, 1.2);
  }

  // the light: shafts through the smoke, cut by the shadows standing in it
  vec2 d = (uL - p) / 18.0;
  vec2 rq = p + d * hash(p + fract(t));
  float acc = 0.0, w = 1.0;
  for (int i = 0; i < 18; i++) {
    rq += d;
    float occB = mask(tB, piv + mat2(ca, -sa, sa, ca) * (rq - uFall.xy - piv)).r;
    float occS = smoothstep(0.42, 0.72, smokeCheap(rq, t));
    float occW = wcov((uGI * vec3(rq, 1.0)).xy) * uWiz;
    acc += (1.0 - max(max(occB, occS * 0.9), occW)) * w;
    w *= 0.95;
  }
  acc /= 12.06;
  float fall = 1.0 / (1.0 + pow(dl / (240.0 + 200.0 * ready), 2.0));
  col += cool * acc * acc * fall * (0.5 + 0.7 * smokeA) * lightK * 0.42 * (1.0 - 0.75 * max(body, wiz));
  col += cool * exp(-dl / 55.0) * (0.2 + 0.5 * ready + 2.0 * blow) * uLO;
  col += cool * exp(-length((p - vec2(-226.0, 318.0)) * vec2(0.6, 1.4)) / 70.0) * blow * 2.6;

  // the whip cracking up out of the deep to his ankle, then taut from it down into the deep
  if (uLash > 0.0 && p.x > uLashBox.x && p.y > uLashBox.y && p.x < uLashBox.z && p.y < uLashBox.w) {
    float dmin = 1e4;
    vec2 prev = uLashH;
    for (int i = 1; i <= 24; i++) {
      float s = float(i) / 24.0 * uLash;
      vec2 q = mix(mix(uLashH, uLashC, s), mix(uLashC, uLashA, s), s);
      vec2 pa = p - prev, ba = q - prev;
      dmin = min(dmin, length(pa - ba * clamp(dot(pa, ba) / max(dot(ba, ba), 1e-3), 0.0, 1.0)));
      prev = q;
    }
    float flick = 0.75 + 0.25 * snoise(p * 0.08 + vec2(0.0, -t * 9.0));
    col += (ramp(1.1) * (1.0 - smoothstep(0.8, 2.8, dmin)) + ramp(0.6) * exp(-dmin / 8.0) * 0.7) * flick;
    col += ramp(1.25) * exp(-length(p - prev) / 7.0) * (1.0 - step(0.999, uLash)) * 1.5;
  }

  // embers rising out of the deep
  vec3 emb = vec3(0.0);
  for (int k = 0; k < 3; k++) {
    float fk = float(k);
    float s = 46.0 + fk * 30.0;
    vec2 q = p + vec2(sin(t * 0.6 + p.y * 0.012 + fk * 2.0) * 10.0, t * (36.0 + fk * 24.0));
    vec2 cell = floor(q / s);
    float hs = hash(cell + fk * 31.7);
    if (hs < 0.16) {
      vec2 o = vec2(hash(cell + 1.3), hash(cell + 9.1)) * 0.7 + 0.15;
      vec2 dd = (fract(q / s) - o) * s;
      float r = length(dd * vec2(1.0, 0.42));
      float tw = 0.55 + 0.45 * sin(t * (4.0 + hs * 20.0) + hs * 60.0);
      emb += ramp(0.95 - fk * 0.12) * (1.0 - smoothstep(0.0, 1.7 + fk * 0.6, r)) * tw;
    }
  }
  col += emb * clamp(smoothstep(-150.0, 420.0, p.y) * 0.5 + fx * 0.6, 0.0, 1.0);

  // film: tone, vignette, grain
  col = 1.0 - exp(-col * 1.15);
  vec2 uv = gl_FragCoord.xy / uRes;
  col *= 1.0 - 0.45 * pow(length((uv - 0.5) * vec2(1.0, 1.2)), 2.2);
  col += (hash(gl_FragCoord.xy + fract(t * 13.0) * 97.0) - 0.5) * 0.028;
  gl_FragColor = vec4(mix(cCanvas, col, uIn), 1.0);
}`;

type Rect = { x: number; y: number; w: number; h: number };
// What the masks cover, in scene units: round the Balrog, and round Gandalf at rest.
const MR: Rect = { x: -440, y: -220, w: 1060, h: 580 };
const WR: Rect = { x: -400, y: 150, w: 210, h: 180 };
// Where the Balrog tips from as it falls (its feet), where Gandalf's fall turns
// (.kd-gandalf's transform-origin, index.css) and the ankle the whip takes.
const PIVOT = [205, 316], GANDALF = [-226, 319], ANKLE = [-228, 315];
// The exit, in ms after the boot leaves (index.css has the SVG's half): the blow
// lands at 300, the Balrog drops through the span from 380, and its whip cracks up
// out of the deep from 520 and has his ankle at 700, taut by 780.
const FALL_AT = 380, FALL_MS = 450, LASH_AT = 520, LASH_MS = 180;

/** Paints the masks from the SVG's own shapes: the Balrog's (sharp, softened, its
 *  cores and trunk, its whip) in the scene's frame round it, Gandalf's round him. */
function paintMasks(svg: SVGSVGElement) {
  const frame = svg.querySelector<SVGGElement>(".kd-balrog > g")!;
  const wizard = svg.querySelector<SVGGElement>(".kd-wizard > g")!;
  const fm = frame.transform.baseVal.consolidate()!.matrix, wm = wizard.transform.baseVal.consolidate()!.matrix;
  const ds = (root: Element, sel: string) => [...root.querySelectorAll<SVGPathElement>(sel)].map((e) => new Path2D(e.getAttribute("d")!));
  const rim = (id: string) => ds(frame, `g[clip-path="url(#${id})"] > path.kd-hot`);
  const all = ds(frame, "path.kd-hot");
  const fore = rim("kd-body"); // trunk, head, horns, sword arm
  const back = [...rim("kd-wing-l"), ...rim("kd-wing-r"), ...rim("kd-arm")];
  const trunk = [...fore, ...rim("kd-arm")];
  const blade = ds(frame, ".kd-sword"), whip = ds(frame, "path.kd-whip"), maw = ds(frame, ".kd-maw");
  const eye = frame.querySelector<SVGEllipseElement>(".kd-eye")!;
  // the mane's flames sit each at its tongue's foot; a wing's leading edge is the first five points of its outline
  const tongues = [...frame.querySelectorAll<SVGGElement>(".kd-ignite > g")].map((g) => g.transform.baseVal.consolidate()!.matrix);
  const edges = ["kd-wing-l", "kd-wing-r"].map((id) =>
    new Path2D("M " + frame.querySelector(`g[clip-path="url(#${id})"] > path.kd-hot`)!.getAttribute("d")!.match(/-?[\d.]+ -?[\d.]+/g)!.slice(0, 5).join(" L ")));
  const cloak = ds(wizard, ".kd-gfbody > .kd-cloak"), hair = ds(wizard, ".kd-gfbody > .kd-hair");
  const gf = ds(wizard, ".kd-gfbody > .kd-gf:not(.kd-cloak):not(.kd-hair)");

  // One channel per shape, added on black. A blur is a shape's shadow, cast back
  // from a copy drawn far off the canvas: canvas `filter` isn't there in every WebKit.
  const OFF = 100000;
  const layer = (r: Rect, k: number, m: DOMMatrix, paint: (x: CanvasRenderingContext2D, blur: (rgb: string, sigma: number, draw: () => void) => void) => void) => {
    const c = document.createElement("canvas");
    c.width = Math.round(r.w * k); c.height = Math.round(r.h * k);
    const x = c.getContext("2d")!;
    x.fillStyle = "#000"; x.fillRect(0, 0, c.width, c.height);
    x.globalCompositeOperation = "lighter";
    const at = (off: number) => { x.setTransform(k, 0, 0, k, -r.x * k - off, -r.y * k); x.transform(m.a, m.b, m.c, m.d, m.e, m.f); };
    at(0);
    paint(x, (rgb, sigma, draw) => {
      x.save(); at(OFF);
      x.shadowColor = x.fillStyle = x.strokeStyle = `rgb(${rgb})`; x.shadowBlur = sigma * k * 2; x.shadowOffsetX = OFF;
      draw(); x.restore();
    });
    return c;
  };
  const fill = (x: CanvasRenderingContext2D, ps: Path2D[], rgb?: string) => { if (rgb) x.fillStyle = rgb; ps.forEach((p) => x.fill(p)); };
  const stroke = (x: CanvasRenderingContext2D, ps: Path2D[], w: number) => { x.lineWidth = w; x.lineCap = x.lineJoin = "round"; ps.forEach((p) => x.stroke(p)); };
  // the fire's sources: a dot at each mane tongue's foot (a bigger tongue burns hotter), and the wings' leading edges
  const sources = (x: CanvasRenderingContext2D) => {
    tongues.forEach((t) => { x.globalAlpha = Math.min(1, 0.3 + Math.hypot(t.a, t.b) * 0.25); x.beginPath(); x.arc(t.e, t.f, 8, 0, Math.PI * 2); x.fill(); });
    x.globalAlpha = 0.55; stroke(x, edges, 7.2); x.globalAlpha = 1;
    fill(x, blade);
  };
  const cores = (x: CanvasRenderingContext2D) => {
    fill(x, blade); fill(x, maw);
    x.save(); x.translate(+eye.getAttribute("cx")!, +eye.getAttribute("cy")!); x.rotate((-12 * Math.PI) / 180);
    x.beginPath(); x.ellipse(0, 0, 5, 2.2, 0, 0, Math.PI * 2); x.fill(); x.restore();
  };
  return [
    layer(MR, 1.5, fm, (x) => { fill(x, fore, "rgb(255,0,0)"); fill(x, back, "rgb(0,255,0)"); x.fillStyle = "rgb(0,0,255)"; cores(x); }),
    layer(MR, 0.5, fm, (x, blur) => {
      blur("255,0,0", 4, () => fill(x, all)); blur("0,255,0", 18, () => fill(x, all)); blur("0,0,255", 5, () => sources(x));
    }),
    layer(MR, 0.5, fm, (x, blur) => {
      blur("255,0,0", 6, () => cores(x)); blur("0,255,0", 7, () => fill(x, trunk)); blur("0,0,255", 4, () => fill(x, fore));
    }),
    layer(MR, 1, fm, (x, blur) => { x.strokeStyle = "rgb(255,0,0)"; stroke(x, whip, 2.2); blur("0,255,0", 3, () => stroke(x, whip, 5)); }),
    layer(WR, 2, wm, (x) => { fill(x, gf, "rgb(255,0,0)"); fill(x, cloak, "rgb(0,255,0)"); fill(x, hair, "rgb(0,0,255)"); }),
    layer(WR, 1, wm, (x, blur) => blur("255,0,0", 2.4, () => fill(x, [...gf, ...cloak, ...hair]))),
  ];
}

/** A theme colour (var() and color-mix() included) as 0..1 rgb, as it computes on `el`. */
function rgbOf(el: Element, css: string): [number, number, number] {
  const probe = document.createElementNS("http://www.w3.org/2000/svg", "g");
  probe.style.color = css; el.appendChild(probe);
  const c = getComputedStyle(probe).color; probe.remove();
  const n = c.match(/[\d.]+/g)!.map(Number);
  // color-mix() computes to color(srgb r g b), already 0..1
  return c.startsWith("color(") ? [n[0], n[1], n[2]] : [n[0] / 255, n[1] / 255, n[2] / 255];
}

/** CSS `transform` (matrix(a, b, c, d, e, f) or none) as [a, b, c, d, e, f]. */
function matrixOf(css: string): number[] {
  const n = css.match(/-?\d*\.?\d+(?:e[+-]?\d+)?/g)?.map(Number);
  return n && n.length === 6 ? n : [1, 0, 0, 1, 0, 0];
}

/** Starts the fire on `canvas` under KHAZAD-DÛM's `svg`. Returns its stop, or null
 *  when there's no WebGL (the SVG draws everything then). `onLost` runs if the
 *  GPU drops the context later, so the scene can hand back to the SVG. */
export function startFire(canvas: HTMLCanvasElement, svg: SVGSVGElement, onLost: () => void): (() => void) | null {
  const gl = canvas.getContext("webgl", { antialias: false, alpha: false, depth: false, stencil: false });
  if (!gl) return null;
  const shader = (type: number, src: string) => {
    const s = gl.createShader(type)!;
    gl.shaderSource(s, src); gl.compileShader(s);
    return s;
  };
  const prog = gl.createProgram()!;
  gl.attachShader(prog, shader(gl.VERTEX_SHADER, VERT)); gl.attachShader(prog, shader(gl.FRAGMENT_SHADER, FRAG));
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    console.warn("KHAZAD-DÛM fire:", gl.getProgramInfoLog(prog));
    return null;
  }
  gl.useProgram(prog);
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  const a = gl.getAttribLocation(prog, "a");
  gl.enableVertexAttribArray(a); gl.vertexAttribPointer(a, 2, gl.FLOAT, false, 0, 0);
  const U = (n: string) => gl.getUniformLocation(prog, n);

  paintMasks(svg).forEach((c, i) => {
    gl.activeTexture(gl.TEXTURE0 + i);
    gl.bindTexture(gl.TEXTURE_2D, gl.createTexture());
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, c);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.uniform1i(U(["tS", "tB", "tC", "tH", "tW", "tV"][i]), i);
  });
  gl.uniform4f(U("uMR"), MR.x, MR.y, MR.w, MR.h);
  gl.uniform4f(U("uWR"), WR.x, WR.y, WR.w, WR.h);
  for (const [u, css] of [["cErr", "var(--err)"], ["cWarn", "var(--warn)"], ["cTxb", "var(--txb)"], ["cInfo", "var(--info)"],
    ["cVoid", "var(--void)"], ["cCanvas", "var(--canvas)"]] as const) gl.uniform3fv(U(u), rgbOf(svg, css));

  // the whip's root in its fist, in the scene, from the first point of its first thong
  const fm = svg.querySelector<SVGGElement>(".kd-balrog > g")!.transform.baseVal.consolidate()!.matrix;
  const [hx, hy] = svg.querySelector(".kd-balrog path.kd-whip")!.getAttribute("d")!.match(/-?[\d.]+/g)!.map(Number);
  const HAND = [fm.a * hx + fm.c * hy + fm.e, fm.b * hx + fm.d * hy + fm.f];
  const tip = svg.querySelector<SVGCircleElement>(".kd-tip")!;
  const light = svg.querySelector<SVGGElement>(".kd-light")!;
  const gandalf = svg.querySelector<SVGGElement>(".kd-gandalf")!;
  // reduced motion draws the settled scene, redrawn only when a step answers, and no exit
  const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
  // a restart's continued boot skips the entrance (.bootcontinue, index.css)
  const born = performance.now() - (svg.closest(".bootcontinue") ? 3000 : 0);
  let raf = 0, p = -1, drawn = -1, lastN = -1, beatAt = -1e9, leaveAt = 0, last = born;

  const draw = () => {
    const now = performance.now(), t = still ? 12 : (now - born) / 1000;
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    // the steps answered, as the SVG has them; the light eases toward it like the SVG's transitions (.45s)
    const target = parseFloat(svg.style.getPropertyValue("--p")) || 0;
    const n = Math.round(target * 6);
    if (n > lastN && lastN >= 0) beatAt = t;
    lastN = n;
    p = still || p < 0 ? target : p + (target - p) * Math.min(1, dt * 7);
    if (still && p === drawn) return;
    drawn = p;
    if (svg.closest(".bootleaving")) leaveAt ||= now;
    const leave = still || !leaveAt ? -1 : now - leaveAt;

    // a canvas pixel per CSS pixel, half the device's on Retina: fire and smoke are soft
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    gl.viewport(0, 0, w, h);
    const cr = canvas.getBoundingClientRect(), sr = svg.getBoundingClientRect(), tr = tip.getBoundingClientRect();
    const sx = sr.width / 2800, sy = sr.height / 760; // the viewBox's size

    // the Balrog drops through the span, tipping back off the break; its whip hand goes with it
    const f = Math.max(0, (leave - FALL_AT) / FALL_MS), e = Math.min(f, 3) ** 2, k = Math.min(f, 1) ** 2;
    const fx = 20 * k, fy = 420 * e, fa = 0.3 * k, ca = Math.cos(fa), sa = Math.sin(fa);
    const H = [PIVOT[0] + fx + ca * (HAND[0] - PIVOT[0]) - sa * (HAND[1] - PIVOT[1]), PIVOT[1] + fy + sa * (HAND[0] - PIVOT[0]) + ca * (HAND[1] - PIVOT[1])];
    // Gandalf where .kd-gandalf's animation has him: M = T(o) · CSS · T(-o); the shader takes its inverse
    const [ma, mb, mc, md, me, mf] = matrixOf(getComputedStyle(gandalf).transform);
    const det = ma * md - mb * mc, ia = md / det, ib = -mb / det, ic = -mc / det, id = ma / det;
    const [ox, oy] = GANDALF, qx = ox + me, qy = oy + mf;
    const A = [ox + ma * (ANKLE[0] - ox) + mc * (ANKLE[1] - oy) + me, oy + mb * (ANKLE[0] - ox) + md * (ANKLE[1] - oy) + mf];
    // the lash: out to his ankle by LASH_AT + LASH_MS, arching high, then taut as it hauls
    const lash = leave < LASH_AT ? 0 : 1 - (1 - Math.min(1, (leave - LASH_AT) / LASH_MS)) ** 2;
    const C = [(H[0] + A[0]) / 2, (H[1] + A[1]) / 2 - 220 * (1 - Math.min(1, Math.max(0, (leave - 640) / 140)))];

    gl.uniform2f(U("uRes"), w, h);
    gl.uniform2f(U("uOrg"), sr.left - cr.left + 1400 * sx, sr.top - cr.top + 120 * sy);
    gl.uniform1f(U("uT"), t);
    gl.uniform1f(U("uP"), p);
    gl.uniform1f(U("uBeat"), t - beatAt);
    gl.uniform1f(U("uLeave"), leave);
    gl.uniform1f(U("uIn"), still ? 1 : Math.min(1, Math.max(0, (t - 0.1) / 1.2)));
    gl.uniform1f(U("uWiz"), still ? 1 : Math.min(1, Math.max(0, (t - 0.35) / 0.5)));
    gl.uniform1f(U("uLO"), +getComputedStyle(light).opacity);
    gl.uniform2f(U("uL"), (tr.left + tr.width / 2 - sr.left) / sx - 1400, (tr.top + tr.height / 2 - sr.top) / sy - 120);
    gl.uniform3f(U("uFall"), fx, fy, fa);
    gl.uniformMatrix3fv(U("uGI"), false, [ia, ib, 0, ic, id, 0, ox - ia * qx - ic * qy, oy - ib * qx - id * qy, 1]);
    gl.uniform1f(U("uLash"), lash);
    gl.uniform2f(U("uLashH"), H[0], H[1]);
    gl.uniform2f(U("uLashC"), C[0], C[1]);
    gl.uniform2f(U("uLashA"), A[0], A[1]);
    gl.uniform4f(U("uLashBox"), Math.min(H[0], C[0], A[0]) - 30, Math.min(H[1], C[1], A[1]) - 30, Math.max(H[0], C[0], A[0]) + 30, Math.max(H[1], C[1], A[1]) + 30);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  };
  const loop = () => { draw(); raf = requestAnimationFrame(loop); };
  const lost = (e: Event) => { e.preventDefault(); cancelAnimationFrame(raf); onLost(); };
  canvas.addEventListener("webglcontextlost", lost);
  loop();
  // the context stays: StrictMode mounts twice in dev, and a lost one can't start again
  return () => { cancelAnimationFrame(raf); canvas.removeEventListener("webglcontextlost", lost); };
}
