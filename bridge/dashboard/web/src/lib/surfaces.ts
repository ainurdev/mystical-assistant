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
