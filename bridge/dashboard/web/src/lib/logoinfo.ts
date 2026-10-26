/* What a project's logo looks like, read off its pixels in a canvas:
   - whether it fills its square (opaque edges, an app icon), which AURORA's
     phosphor silhouette reads by lightness instead of by outline;
   - its strongest colours, the editor's FROM LOGO swatches;
   - whether it would vanish into a dark ground or a light one: AUTO, the
     default background, plates it only there (ProjectTile, index.css).

   This runs here because the bridge can't decode images (stdlib only, and no
   SVG renderer). A stored logo's name is the hash of its bytes, so its reading
   is cached by name in localStorage and never goes stale. */

import { useSyncExternalStore } from "react";
import { rgbToOklch, oklchToHex } from "./ink.ts";

export interface LogoInfo {
  fill: boolean;     // opaque to its edges: an app icon, not a see-through mark
  square: boolean;   // opaque along the middle of every edge: an app icon, rounded corners allowed
  colors: string[];  // up to 3 hex, strongest first
  night: boolean;    // vanishes on a dark ground: AUTO puts light behind it there
  day: boolean;      // vanishes on a light ground: AUTO puts dark behind it there
}

// The grounds AUTO reads a logo against (relative luminance): a dark theme's
// panel and a light one's. Two fixed readings, so a theme switch is pure CSS.
const NIGHT = 0.03, DAY = 0.9;
const lin = (c: number) => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
const stands = (L: number, ground: number) => (Math.max(L, ground) + 0.05) / (Math.min(L, ground) + 0.05) >= 2;

/** The reading itself, on raw RGBA pixels. Pure, for the check. */
export function analyse(px: ArrayLike<number>, w: number, h: number): LogoInfo {
  let edge = 0, edgeSolid = 0, mid = 0, midSolid = 0, ink = 0, seenN = 0, seenD = 0;
  const bins = new Map<number, { n: number; r: number; g: number; b: number }>();
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const a = px[i + 3];
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) { edge++; if (a > 240) edgeSolid++; }
      // The square test reads the middle 40% of each edge, by pixel centre so both ends
      // match: an app icon's rounded corners are see-through, a squircle's for a quarter
      // of the side (osanwe's, 2026-10-27).
      const u = (x + 0.5) / w, v = (y + 0.5) / h;
      if (((x === 0 || x === w - 1) && v > 0.3 && v < 0.7) || ((y === 0 || y === h - 1) && u > 0.3 && u < 0.7)) {
        mid++; if (a > 240) midSolid++;
      }
      if (a < 128) continue;
      const [r, g, b] = [px[i], px[i + 1], px[i + 2]];
      const L = 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
      ink++; if (stands(L, NIGHT)) seenN++; if (stands(L, DAY)) seenD++;
      const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
      const e = bins.get(key) ?? { n: 0, r: 0, g: 0, b: 0 };
      e.n++; e.r += r; e.g += g; e.b += b;
      bins.set(key, e);
    }
  }
  // Each bin's mean colour, scored by how much of the logo it covers times its
  // chroma squared, dark tones discounted. Then three tiers: real colours
  // first, muted ones after (a near-black ground that only wins on area), and
  // white or black only when the logo has nothing else.
  const cands = [...bins.values()].map((e) => {
    const [L, C, H] = rgbToOklch(e.r / e.n, e.g / e.n, e.b / e.n);
    const tier = C >= 0.06 ? 0 : C < 0.04 && (L > 0.93 || L < 0.2) ? 2 : 1;
    return { L, C, H, tier, score: e.n * (0.0004 + C * C) * Math.min(1, L / 0.45) };
  }).sort((a, b) => a.tier - b.tier || b.score - a.score);
  const pool = cands.some((c) => c.tier < 2) ? cands.filter((c) => c.tier < 2) : cands;
  const picked: typeof pool = [];
  for (const c of pool) {
    if (picked.length === 3) break;
    const apart = picked.every((p) => {
      const da = c.C * Math.cos((c.H * Math.PI) / 180) - p.C * Math.cos((p.H * Math.PI) / 180);
      const db = c.C * Math.sin((c.H * Math.PI) / 180) - p.C * Math.sin((p.H * Math.PI) / 180);
      return Math.hypot(c.L - p.L, da, db) > 0.12;
    });
    if (apart) picked.push(c);
  }
  // A background where under half of the ink stands out (2:1) from the ground;
  // never behind an icon that fills its square.
  const square = mid > 0 && midSolid / mid > 0.9;
  const plated = (seen: number) => ink > 0 && !square && seen / ink < 0.5;
  return {
    fill: edge > 0 && edgeSolid / edge > 0.9,
    square,
    colors: picked.map((c) => oklchToHex(c.L, c.C, c.H)),
    night: plated(seenN),
    day: plated(seenD),
  };
}

/** Read a logo off any URL the page can draw: a stored logo, or a dropped
 *  file's data: URL before it is saved. */
export async function readLogo(src: string): Promise<LogoInfo> {
  const img = new Image();
  img.src = src;
  await img.decode();
  const S = 64;
  const cv = document.createElement("canvas");
  cv.width = cv.height = S;
  const ctx = cv.getContext("2d", { willReadFrequently: true })!;
  const w = img.naturalWidth || S, h = img.naturalHeight || S;
  const k = Math.min(S / w, S / h);
  ctx.drawImage(img, (S - w * k) / 2, (S - h * k) / 2, w * k, h * k);
  return analyse(ctx.getImageData(0, 0, S, S).data, S, S);
}

// --- the cache: one reading per stored logo, kept in this browser -----------
const KEY = "hud-logo-info";
let cache: Record<string, LogoInfo> = {};
try { cache = JSON.parse(localStorage.getItem(KEY) || "{}") as Record<string, LogoInfo>; } catch { /* ignore */ }
const pending = new Set<string>();
const subs = new Set<() => void>();
let version = 0;

/** A stored logo's reading, or null until it has been read. */
export function useLogoInfo(name: string | null | undefined, src: string): LogoInfo | null {
  useSyncExternalStore((fn) => { subs.add(fn); return () => { subs.delete(fn); }; }, () => version);
  if (!name) return null;
  // A reading cached before AUTO lacks night/day, and one before the folded rail's
  // full tiles lacks square: read it again.
  if ((!cache[name] || cache[name].square === undefined) && !pending.has(name)) {
    pending.add(name);
    readLogo(src).then((info) => {
      cache = { ...cache, [name]: info };
      try { localStorage.setItem(KEY, JSON.stringify(cache)); } catch { /* ignore */ }
      version++;
      subs.forEach((fn) => fn());
    }).catch(() => { /* unreadable: AURORA reads it by outline */ });
  }
  return cache[name] ?? null;
}

/** A dropped or pasted file as what the bridge stores: base64 bytes, a raster
 *  shrunk to 256px when bigger (a tile is 22px; the editor's preview 64), an
 *  SVG kept as it is. Also a data: URL for the preview. */
export async function shrinkLogo(file: Blob): Promise<{ data: string; url: string }> {
  const asUrl = (b: Blob) => new Promise<string>((ok, bad) => {
    const fr = new FileReader();
    fr.onload = () => ok(String(fr.result));
    fr.onerror = () => bad(fr.error);
    fr.readAsDataURL(b);
  });
  const url = await asUrl(file);
  if (file.type === "image/svg+xml") return { data: url.slice(url.indexOf(",") + 1), url };
  const img = new Image();
  img.src = url;
  await img.decode();
  const M = 256;
  if (img.naturalWidth <= M && img.naturalHeight <= M && file.size <= 200 * 1024) {
    return { data: url.slice(url.indexOf(",") + 1), url };
  }
  const k = Math.min(M / img.naturalWidth, M / img.naturalHeight, 1);
  const cv = document.createElement("canvas");
  cv.width = Math.max(1, Math.round(img.naturalWidth * k));
  cv.height = Math.max(1, Math.round(img.naturalHeight * k));
  cv.getContext("2d")!.drawImage(img, 0, 0, cv.width, cv.height);
  const out = cv.toDataURL("image/png");
  return { data: out.slice(out.indexOf(",") + 1), url: out };
}
