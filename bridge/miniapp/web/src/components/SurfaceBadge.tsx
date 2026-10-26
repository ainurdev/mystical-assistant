/* Where a session was started, as a two-letter tag. The colours are the
   index.css --surface-* tokens the dashboard uses for the same badge, so a chat
   reads the same on both screens. */

const SURFACES: Record<string, { tag: string; color: string; bg: string }> = {
  vscode: { tag: "VS", color: "var(--surface-vs)", bg: "var(--surface-vs-bg)" },
  dashboard: { tag: "WEB", color: "var(--surface-web)", bg: "var(--surface-web-bg)" },
  miniapp: { tag: "MA", color: "var(--surface-ma)", bg: "var(--surface-ma-bg)" },
  bot: { tag: "TG", color: "var(--surface-tg)", bg: "var(--surface-tg-bg)" },
  terminal: { tag: "CLI", color: "var(--muted-foreground)", bg: "transparent" },
};

// A Rivendell job's tag is its kind, in Rivendell's purple: the dashboard's
// words for it (dashboard lib/jobs JOB_LABEL).
const JOB_WORD: Record<string, string> = {
  review: "REVIEW", impl: "IMPLEMENT", taskdesc: "TASK DESC", todolist: "TODOLIST", changelog: "CHANGELOG",
  news: "NEWSPAPER", deck: "DECK", video: "VIDEO", "meeting-notes": "MEETING NOTES", "project-summary": "SUMMARY",
  "meeting-brief": "BRIEF", conflict: "CONFLICTS", "design-build": "DESIGN",
};

export function SurfaceBadge({ origin, job }: { origin?: string | null; job?: { kind?: string; step?: string } | null }) {
  if (origin === "rivendell" || origin?.startsWith("rivendell:")) {
    const tag = job?.kind === "todolist" && job.step === "recommendations" ? "RECOMMEND" : JOB_WORD[job?.kind ?? ""] ?? "RIVENDELL";
    return (
      <span
        className="shrink-0 rounded border px-1.5 py-px text-[9px] tracking-wider"
        style={{ color: "var(--purple)", background: "color-mix(in srgb, var(--purple) 10%, transparent)", borderColor: "var(--purple)" }}
      >
        {tag}
      </span>
    );
  }
  const s = SURFACES[origin ?? ""];
  if (!s) return null;
  return (
    <span
      className="shrink-0 rounded border px-1.5 py-px text-[9px] tracking-wider"
      style={{ color: s.color, background: s.bg, borderColor: s.color }}
    >
      {s.tag}
    </span>
  );
}
