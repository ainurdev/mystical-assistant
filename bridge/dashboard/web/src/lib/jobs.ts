// Rivendell jobs: which sessions are one, where they file, and how each kind reads.
// Every session a Rivendell job started files under one sidebar group, whatever
// folder it ran in. A review runs in its repo's checkout, a paper in BASE_PATH,
// a video under .bridge_uploads, and that folder still runs follow-ups, FILES and
// GIT; the group is only where the row is listed. The facts come from the session's
// `job` (bridge/rivendell_jobs.py).
import type { RivendellJob } from "../api";
import { isTeam, SHARED_REL } from "./team.ts";

/** The group's key in the PROJECTS tree. Not a path (those start with "/"), so it
 *  can't collide with a folder. */
export const JOBS_REL = "rivendell:jobs";
export const JOBS_NAME = "Rivendell jobs";

/** A kind's word: the PLUGINS queue's own (RivendellQueue KIND_LABEL). */
export const JOB_LABEL: Record<NonNullable<RivendellJob["kind"]>, string> = {
  review: "REVIEW", impl: "IMPLEMENT", todolist: "TODOLIST", taskdesc: "TASK DESC",
  changelog: "CHANGELOG", news: "NEWSPAPER", deck: "DECK", video: "VIDEO", "meeting-notes": "MEETING NOTES",
  "project-summary": "SUMMARY", "meeting-brief": "BRIEF",
};

export const jobLabel = (job: RivendellJob | null | undefined): string =>
  !job?.kind ? "RIVENDELL" : job.kind === "todolist" && job.step === "recommendations" ? "RECOMMEND" : JOB_LABEL[job.kind];

// Folders only Rivendell's runs make (bridge/rivendell.py): a session there is a
// job even when it predates the origin tag, like a meeting draft run by hand.
const RV_FOLDER = /^\/\.bridge_uploads\/(meetings|videos|video-[^/]+)(\/|$)/;

type Listed = { origin?: string | null; project: string; job?: RivendellJob | null };

/** Did a Rivendell job start this session? Its origin says so, or the folder it
 *  ran in, or the bridge filed a job on it (an older run indexed as a terminal
 *  session, known by its prompt: bridge/rivendell_jobs.py backfill). */
export const isJob = (s: Listed): boolean =>
  s.origin === "rivendell" || !!s.origin?.startsWith("rivendell:") || RV_FOLDER.test(s.project) || !!s.job?.kind;

/** The PROJECTS group a session lists under: Shared for one a teammate sent,
 *  Rivendell jobs, else its folder. */
export const jobGroup = (s: Listed): string => (isTeam(s.origin) ? SHARED_REL : isJob(s) ? JOBS_REL : s.project);

/** A job whose answer is the whole point: it gets the job bar instead of the
 *  composer. IMPLEMENT is real work you carry on, so it keeps the composer, and
 *  so does a job with no kind on record (nothing to say on a bar). */
export const oneShot = (job: RivendellJob | null | undefined): boolean => !!job?.kind && job.kind !== "impl";

const repoName = (repo?: string) => (repo ?? "").split("/").pop() || "";

/** "2026-10-18" -> "Sun 18 Oct", read as a local date. */
export function dayOf(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  const t = new Date(y, (m || 1) - 1, d || 1);
  return Number.isNaN(t.getTime()) ? date
    : t.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" }).replace(",", "");
}

/** What the job was about, after its tag on a row: "ibgroups_operations #81",
 *  "Sun 18 Oct", "transcribe · en". Empty when the title already says it. */
export function jobTarget(job: RivendellJob | null | undefined): string {
  if (!job?.kind) return "";
  switch (job.kind) {
    case "review": return [repoName(job.repo), job.number ? `#${job.number}` : ""].filter(Boolean).join(" ");
    case "impl": return repoName(job.repo);
    case "news": return job.date ? dayOf(job.date) : "";
    case "video": case "meeting-notes": return [job.step, job.language].filter(Boolean).join(" · ");
    default: return "";
  }
}

/** Can RUN AGAIN file this job afresh? The bridge's rivendell.again_call, asked
 *  before the button shows: a review, task description or todolist with the id
 *  it needs, or today's paper. */
export function canRunAgain(job: RivendellJob | null | undefined, today = new Date()): boolean {
  if (!job?.kind) return false;
  const iso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
  return (job.kind === "review" && !!job.pr_id) || (job.kind === "taskdesc" && !!job.task_id)
    || (job.kind === "todolist" && !!job.project_id) || (job.kind === "news" && job.date === iso);
}

/** The day label a job row files under when the group is open: TODAY,
 *  YESTERDAY, else "FRI 16 OCT". */
export function dayLabel(epochSec: number, now = new Date()): string {
  const d = new Date(epochSec * 1000);
  const start = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((start(now) - start(d)) / 86400000);
  if (days === 0) return "TODAY";
  if (days === 1) return "YESTERDAY";
  return d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" }).replace(",", "").toUpperCase();
}

/** A newspaper's answer as its paper, or null when it isn't one. The answer is
 *  the paper's JSON (Rivendell's news-parse shape), sometimes in a ```json fence. */
export interface Paper {
  ear?: string;
  forecast?: { summary?: string; mood?: string };
  lead?: Story;
  stories?: Story[];
  briefs?: { text: string }[];
  ads?: { size?: string; title: string; text?: string; due?: string | null; illustration?: string }[];
}
export interface Story { headline: string; deck?: string | null; body?: string[]; illustration?: string }

export function parsePaper(text: string | null | undefined): Paper | null {
  const raw = text ?? "";
  const i = raw.indexOf("{"), j = raw.lastIndexOf("}");
  if (i < 0 || j <= i) return null;
  try {
    const p = JSON.parse(raw.slice(i, j + 1));
    return p && typeof p === "object" && p.lead && typeof p.lead.headline === "string" ? p as Paper : null;
  } catch { return null; }
}
