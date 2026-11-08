// The arithmetic behind the create form: colours that stay readable, and the starting points it
// offers. Pure, for designsystem.check.ts. The same file is in both apps.

export type Spec = {
  name: string; about: string; feel: string[]; avoid: string; accent: string; ground: string; surface: string; ink: string; muted: string; line: string;
  pair: string; heading: string; body: string; radius: number; density: "tight" | "regular" | "roomy"; size: number;
};

export const PAIRS: { id: string; label: string; heading: string; body: string; google: string[] }[] = [
  { id: "fraunces", label: "Fraunces and Source Sans", heading: "'Fraunces', Georgia, serif", body: "'Source Sans 3', system-ui, sans-serif", google: ["Fraunces:wght@400;600", "Source+Sans+3:wght@400;600"] },
  { id: "grotesk", label: "Space Grotesk and IBM Plex Sans", heading: "'Space Grotesk', system-ui, sans-serif", body: "'IBM Plex Sans', system-ui, sans-serif", google: ["Space+Grotesk:wght@500;700", "IBM+Plex+Sans:wght@400;600"] },
  { id: "dm", label: "DM Serif and DM Sans", heading: "'DM Serif Display', Georgia, serif", body: "'DM Sans', system-ui, sans-serif", google: ["DM+Serif+Display", "DM+Sans:wght@400;600"] },
  { id: "plex", label: "IBM Plex Sans and Plex Mono", heading: "'IBM Plex Sans', system-ui, sans-serif", body: "'IBM Plex Mono', ui-monospace, monospace", google: ["IBM+Plex+Sans:wght@500;600", "IBM+Plex+Mono:wght@400;500"] },
  { id: "playfair", label: "Playfair and Source Serif", heading: "'Playfair Display', Georgia, serif", body: "'Source Serif 4', Georgia, serif", google: ["Playfair+Display:wght@500;700", "Source+Serif+4:wght@400;600"] },
  { id: "nunito", label: "Nunito", heading: "'Nunito', system-ui, sans-serif", body: "'Nunito', system-ui, sans-serif", google: ["Nunito:wght@400;700;800"] },
  { id: "system", label: "The device's own fonts", heading: "system-ui, sans-serif", body: "system-ui, sans-serif", google: [] },
];

type Preset = Pick<Spec, "accent" | "ground" | "surface" | "ink" | "muted" | "line" | "pair" | "radius" | "density">;
export const FEELS: Record<string, Preset> = {
  Calm: { accent: "#2f6f5e", ground: "#f7f5ef", surface: "#ffffff", ink: "#1f2421", muted: "#5f675f", line: "#e2dfd6", pair: "fraunces", radius: 10, density: "roomy" },
  Bold: { accent: "#d7f03a", ground: "#0f0f0f", surface: "#1a1a1a", ink: "#f4f4f0", muted: "#a3a39b", line: "#2e2e2b", pair: "grotesk", radius: 0, density: "tight" },
  Warm: { accent: "#b4492a", ground: "#f8efe3", surface: "#fffaf3", ink: "#2b2118", muted: "#6d5d4d", line: "#e6d9c7", pair: "dm", radius: 12, density: "regular" },
  Technical: { accent: "#5b9dff", ground: "#0f1216", surface: "#171b21", ink: "#e6e9ee", muted: "#98a2ae", line: "#29303a", pair: "plex", radius: 4, density: "tight" },
  Editorial: { accent: "#8c1c13", ground: "#fffdf8", surface: "#ffffff", ink: "#1b1a18", muted: "#65625c", line: "#e7e3da", pair: "playfair", radius: 2, density: "roomy" },
  Playful: { accent: "#e5482a", ground: "#fff7ec", surface: "#ffffff", ink: "#2a1f3d", muted: "#6a5f7a", line: "#f0e2cf", pair: "nunito", radius: 16, density: "regular" },
};

const rgb = (hex: string): [number, number, number] => {
  const h = hex.replace("#", "");
  const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16)) as [number, number, number];
};
const lum = (hex: string) => {
  const [r, g, b] = rgb(hex).map((x) => { const v = x / 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

/** WCAG contrast between two colours. */
export function contrast(a: string, b: string): number {
  const x = lum(a), y = lum(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

/** `amount` of the way from a to b. */
export function mix(a: string, b: string, amount: number): string {
  const x = rgb(a), y = rgb(b);
  return `#${x.map((v, i) => Math.round(v + (y[i] - v) * amount).toString(16).padStart(2, "0")).join("")}`;
}

/** What the form should say about these colours. Each is something a reader would run into. */
export function warnings(s: Pick<Spec, "accent" | "ground" | "ink" | "muted">): string[] {
  const out: string[] = [];
  const main = contrast(s.ink, s.ground);
  if (main < 4.5) out.push(`Text on the background is ${main.toFixed(1)}:1, and needs 4.5:1 to read comfortably.`);
  const quiet = contrast(s.muted, s.ground);
  if (quiet < 4.5) out.push(`Muted text is ${quiet.toFixed(1)}:1 on the background, and needs 4.5:1.`);
  const acc = contrast(s.accent, s.ground);
  if (acc < 3) out.push(`The accent is ${acc.toFixed(1)}:1 on the background, so buttons won't stand out. It needs 3:1.`);
  return out;
}

/** The text a button wears on the accent: whichever of black or white reads better. */
export const onAccent = (accent: string) => (contrast(accent, "#000000") >= contrast(accent, "#ffffff") ? "#000000" : "#ffffff");

/** A sample screen in these tokens, for the form's preview. */
export function sampleDoc(s: Spec): string {
  const pair = PAIRS.find((p) => p.id === s.pair);
  const fonts = pair?.google.length ? `<link rel="stylesheet" href="https://fonts.googleapis.com/css2?${pair.google.map((g) => `family=${g}`).join("&")}&display=swap">` : "";
  const unit = s.density === "roomy" ? 8 : s.density === "tight" ? 4 : 6;
  const esc = (t: string) => t.replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" })[c] as string);
  return `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">${fonts}<style>
*{box-sizing:border-box}body{margin:0;background:${s.ground};color:${s.ink};font:${s.size}px/1.5 ${s.heading === s.body ? s.body : s.body};padding:${unit * 4}px}
h1{font:600 ${Math.round(s.size * 2.2)}px/1.15 ${s.heading};margin:0 0 ${unit * 2}px}h2{font:600 ${Math.round(s.size * 1.2)}px/1.3 ${s.heading};margin:0 0 ${unit}px}
p{margin:0 0 ${unit * 3}px;color:${s.muted};max-width:46ch}.row{display:flex;flex-wrap:wrap;gap:${unit * 2}px;margin-bottom:${unit * 4}px}
.b{padding:${unit * 1.5}px ${unit * 3}px;border-radius:${s.radius}px;border:1px solid ${s.line};background:none;color:${s.ink};font:inherit;font-weight:600}.b.p{background:${s.accent};border-color:${s.accent};color:${onAccent(s.accent)}}
.card{flex:1 1 180px;padding:${unit * 3}px;background:${s.surface};border:1px solid ${s.line};border-radius:${s.radius}px}.card p{margin:0}input{width:100%;margin-top:${unit * 2}px;padding:${unit * 1.5}px;border:1px solid ${s.line};border-radius:${s.radius}px;background:${s.ground};color:${s.ink};font:inherit}
</style></head><body><h1>${esc(s.name || "Your design system")}</h1><p>${esc(s.about || "This is how a page would look. Headings, text, buttons and cards all come from what you pick here.")}</p>
<div class="row"><button class="b p">Main action</button><button class="b">Second action</button></div>
<div class="row"><div class="card"><h2>A card</h2><p>Quiet text that supports the heading above it.</p></div><div class="card"><h2>A form</h2><p>Fields and corners follow along.</p><input placeholder="Type here"></div></div></body></html>`;
}
