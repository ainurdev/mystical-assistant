// Maps a session/run origin to its surface chip (code + colors) and shared time helpers.
export interface Surface {
  code: string;
  label: string;
  color: string; // CSS var reference
  bg: string; // CSS var reference
}

const SURFACES: Record<string, Surface> = {
  vscode: { code: "VS", label: "VS Code", color: "var(--surface-vs)", bg: "var(--surface-vs-bg)" },
  bot: { code: "TG", label: "Telegram", color: "var(--surface-tg)", bg: "var(--surface-tg-bg)" },
  miniapp: { code: "MA", label: "Mini App", color: "var(--surface-ma)", bg: "var(--surface-ma-bg)" },
  dashboard: { code: "WEB", label: "Desktop", color: "var(--surface-web)", bg: "var(--surface-web-bg)" },
  terminal: { code: "CLI", label: "Terminal", color: "var(--muted-foreground)", bg: "rgba(156,149,176,.12)" },
};

const FALLBACK: Surface = {
  code: "··",
  label: "Bridge",
  color: "var(--muted-foreground)",
  bg: "rgba(156,149,176,.12)",
};

export function surfaceFor(origin: string | null | undefined): Surface {
  return SURFACES[origin ?? ""] ?? FALLBACK;
}

/** Surface to show for a session row: where the last prompt came from. Prefer
 *  where it's live *right now* (VS Code / terminal) over where it started.
 *  Bridge-driven (sdk) and offline sessions fall back to their stored origin. */
export function liveSurfaceFor(
  origin: string | null | undefined,
  liveSource?: string | null,
): Surface {
  if (liveSource === "vscode") return surfaceFor("vscode");
  if (liveSource === "cli") return surfaceFor("terminal");
  return surfaceFor(origin);
}

// A stable accent per project (the design colours each repo distinctly). Hashes
// the project name to a fixed phosphor palette so the same repo always looks the
// same across the strip, sidebar, terminal header, and analyze modal.
const PROJ_PALETTE = ["var(--acc)", "var(--purple)", "var(--ok)", "var(--info)", "var(--warn)", "#ff7ad9"];

export interface ProjectTint {
  color: string;
  border: string;
  tag: string;
}

export function projectTint(name: string | null | undefined): ProjectTint {
  const clean = (name ?? "").replace(/\/+$/, "");
  const base = clean.split("/").pop() || clean || "proj";
  let h = 0;
  for (let i = 0; i < base.length; i++) h = (h * 31 + base.charCodeAt(i)) >>> 0;
  const color = PROJ_PALETTE[h % PROJ_PALETTE.length];
  const tag = (base.replace(/[^a-z0-9]/gi, "").slice(0, 4) || "proj").toUpperCase();
  // Convert the hex accent to a translucent border.
  const r = parseInt(color.slice(1, 3), 16);
  const g = parseInt(color.slice(3, 5), 16);
  const b = parseInt(color.slice(5, 7), 16);
  return { color, border: `rgba(${r},${g},${b},.45)`, tag };
}

export function ago(sec: number | null): string {
  if (!sec) return "";
  const s = Math.max(0, Date.now() / 1000 - sec);
  if (s < 60) return "now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

/** "2h 14m" / "47m" / "30s" from a positive duration in seconds. */
export function fmtDuration(sec: number): string {
  if (sec <= 0) return "now";
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return `${Math.floor(sec)}s`;
}
