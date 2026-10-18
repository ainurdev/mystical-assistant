import { GitPullRequest, Hammer, Inbox, ListChecks, Newspaper, PenLine, Presentation, ScrollText, Users, Video } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { RivendellJob } from "../../api";
import { jobLabel } from "../../lib/jobs";

/** Each kind's glyph, beside its word (lib/jobs JOB_LABEL). */
export const JOB_ICON: Record<NonNullable<RivendellJob["kind"]>, LucideIcon> = {
  review: GitPullRequest, impl: Hammer, taskdesc: PenLine, todolist: ListChecks, changelog: ScrollText,
  news: Newspaper, deck: Presentation, video: Video, "meeting-notes": Users,
};

/** A job's tag on a session row: its glyph and word in Rivendell's purple. A
 *  job with no kind on record (a custom prompt from before jobs were kept) reads
 *  RIVENDELL. */
export function JobTag({ job }: { job: RivendellJob | null | undefined }) {
  const Icon = job?.kind ? JOB_ICON[job.kind] : Inbox;
  return (
    <span style={{ flex: "none", display: "inline-flex", alignItems: "center", gap: 4, color: "var(--purple)",
                   fontSize: "var(--t85)", fontWeight: 600, letterSpacing: ".09em" }}>
      <Icon size={10} strokeWidth={2.2} aria-hidden />{jobLabel(job)}
    </span>
  );
}

/** The Rivendell jobs group's tile: a project tile (.ptile, so every theme
 *  draws it like the rest) holding an inbox, in purple. */
export function JobsTile() {
  return (
    <b className="ptile" data-kind="icon" aria-hidden style={{ ["--pc" as string]: "var(--purple)" }}>
      <Inbox size={11} strokeWidth={2.2} />
    </b>
  );
}
