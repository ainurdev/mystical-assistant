import { useState } from "react";
import { ArrowUpRight, ChevronRight, Inbox } from "lucide-react";
import type { RivendellJob } from "../api";
import { dayOf, jobLabel } from "../lib/jobs";
import { hhmm, useClock12 } from "../lib/surfaces";
import { JOB_ICON } from "./hud/JobTag";

const longDay = (date: string) => {
  const [y, m, d] = date.split("-").map(Number);
  const t = new Date(y, (m || 1) - 1, d || 1);
  return Number.isNaN(t.getTime()) ? date : t.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" });
};

/** "2026-10-17 05:00" -> "Sat 17 Oct 05:00". */
const stamp = (s: string) => `${dayOf(s.slice(0, 10))} ${s.slice(11, 16)}`;

/** The line under the title: what the job was about, in the words a person
 *  checks it by. A paper's window comes from its prompt ("It covers … to …"),
 *  which is where Rivendell states it. */
function subLine(job: RivendellJob, prompt: string): string {
  switch (job.kind) {
    case "review": return [job.repo, job.number ? `#${job.number}` : ""].filter(Boolean).join("  ");
    case "impl": return job.repo ?? "";
    case "news": {
      const m = /It covers (\d{4}-\d{2}-\d{2} \d{2}:\d{2}) to (\d{4}-\d{2}-\d{2} \d{2}:\d{2})(?: \(([^)]+?) time\))?/.exec(prompt);
      return m ? `covers ${stamp(m[1])} → ${stamp(m[2])}${m[3] ? ` · ${m[3]} time` : ""}` : "";
    }
    case "video": case "meeting-notes": case "todolist": return [job.step, job.language].filter(Boolean).join(" · ");
    default: return "";
  }
}

const size = (s: string) => (s.length < 1000 ? `${s.length}` : `${(s.length / 1000).toFixed(1)}k`);

/** Turn 1 of a Rivendell job, in place of the YOU bubble: you didn't write that
 *  prompt, Rivendell did. The kind and FROM RIVENDELL, what the job is about
 *  (the PR, the task, the paper's edition), its links out, and the prompt itself
 *  folded behind PROMPT. OPEN PR goes to GitHub; IN RIVENDELL shows only when
 *  Rivendell sent the job's page (the bridge knows its API, not its web app). */
export function JobPlate({ job, prompt, at, title }: {
  job: RivendellJob; prompt: string; at?: number; title?: string | null;
}) {
  const h12 = useClock12();
  const [open, setOpen] = useState(false);
  const Icon = job.kind ? JOB_ICON[job.kind] : Inbox;
  const head = job.kind === "news" && job.date ? `Your paper for ${longDay(job.date)}` : job.title || title || "Rivendell job";
  const sub = subLine(job, prompt);
  return (
    <div className="jobplate" data-kind={job.kind}>
      <span className="jobplate-ic" aria-hidden><Icon size={17} strokeWidth={2} /></span>
      <div className="min-w-0">
        <div className="jobplate-kl">
          {jobLabel(job)}<s>·</s><span>FROM RIVENDELL</span>
          {at != null && <span className="jobplate-t">{hhmm(at, h12)}</span>}
        </div>
        <div className="jobplate-h">{head}</div>
        {sub && <div className="jobplate-sub">{sub}</div>}
        <div className="jobplate-acts">
          {job.html_url && (
            <a className="jobplate-lnk" href={job.html_url} target="_blank" rel="noreferrer">
              <ArrowUpRight size={12} aria-hidden />{job.kind === "review" ? "OPEN PR" : "OPEN TASK"}
            </a>
          )}
          {job.url && (
            <a className="jobplate-lnk" data-rv href={job.url} target="_blank" rel="noreferrer">
              <ArrowUpRight size={12} aria-hidden />{job.kind === "news" ? "READ IN RIVENDELL" : "IN RIVENDELL"}
            </a>
          )}
          <button type="button" className="jobplate-fold" aria-expanded={open} onClick={() => setOpen((o) => !o)}
            title={open ? "fold Rivendell's prompt" : "Rivendell's prompt for this job"}>
            PROMPT <b>{size(prompt)}</b>
            <ChevronRight size={11} aria-hidden style={{ transform: open ? "rotate(90deg)" : undefined, transition: "transform .15s" }} />
          </button>
        </div>
        {open && <pre className="jobplate-prompt">{prompt}</pre>}
      </div>
    </div>
  );
}
