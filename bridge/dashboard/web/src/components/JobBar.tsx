import { useEffect, useState } from "react";
import { ArrowUpRight, Check, MessageSquare, RotateCw, Square, TriangleAlert, X } from "lucide-react";
import type { RivendellJob } from "../api";
import type { Turn } from "../chat";
import { canRunAgain, jobLabel } from "../lib/jobs";
import { hhmm, useClock12, wall } from "../lib/surfaces";

/** In place of the composer on a Rivendell job whose answer is the point (lib/jobs
 *  oneShot): there is nothing to type under a finished paper or review, so the
 *  bar says what became of the job instead. RUNNING with STOP; DONE once Rivendell
 *  has the answer; FAILED with RUN AGAIN when Rivendell can file it afresh; and
 *  UNREPORTED when the answer never reached Rivendell (it is still here). ASK
 *  ABOUT IT brings the composer back for a follow-up, which stays in this session. */
export function JobBar({ job, turn, onAsk, onStop, onAgain }: {
  job: RivendellJob;
  /** The job's turn (the session's first). */
  turn?: Turn;
  onAsk: () => void;
  onStop: () => void;
  /** RUN AGAIN; resolves to an error line, or null when Rivendell took it. */
  onAgain: () => Promise<string | null>;
}) {
  const h12 = useClock12();
  const running = turn?.status === "running";
  const [now, setNow] = useState(() => Date.now() / 1000);
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => setNow(Date.now() / 1000), 1000);
    return () => clearInterval(t);
  }, [running]);
  const [again, setAgain] = useState<"" | "busy" | "sent" | string>("");

  const res = [...(turn?.events ?? [])].reverse().find((e) => e.type === "result") as
    { cost?: number; elapsed?: number; at?: number } | undefined;
  const failed = job.outcome === "failed" || (!job.outcome && turn?.status === "error");
  const label = jobLabel(job);
  const meta = [
    res?.at ? hhmm(res.at, h12) : job.at ? hhmm(job.at, h12) : "",
    res?.elapsed ? wall(res.elapsed).toLowerCase() : "",
    typeof res?.cost === "number" ? `$${res.cost.toFixed(2)}` : "",
  ].filter(Boolean).join(" · ");
  // A conflicts job's PR opens in Rivendell first (its page there), GitHub when Rivendell sent none.
  const prUrl = job.kind === "conflict" ? job.url ?? job.html_url : job.kind === "review" ? job.html_url : undefined;
  const link = prUrl
    ? <a className="jobbar-btn" href={prUrl} target="_blank" rel="noreferrer"><ArrowUpRight size={12} aria-hidden />OPEN PR</a>
    : job.url
      ? <a className="jobbar-btn" href={job.url} target="_blank" rel="noreferrer">
          <ArrowUpRight size={12} aria-hidden />{job.kind === "news" ? "READ IN RIVENDELL" : "IN RIVENDELL"}</a>
      : null;
  const ask = (
    <button type="button" className="jobbar-btn" onClick={onAsk} title="a follow-up turn in this session; Rivendell keeps the answer it got">
      <MessageSquare size={12} aria-hidden />ASK ABOUT IT
    </button>
  );

  if (running) {
    const secs = turn?.started ? Math.max(0, now - turn.started) : 0;
    return (
      <div className="jobbar" data-state="running">
        <span className="jobbar-orb" aria-hidden />
        <span className="jobbar-w1">{label} · RUNNING FOR RIVENDELL</span>
        {secs > 0 && <span className="jobbar-w2">{wall(secs).toLowerCase()}</span>}
        <span className="jobbar-sp" />
        {link}
        <button type="button" className="jobbar-btn" data-stop onClick={onStop}><Square size={11} aria-hidden />STOP</button>
      </div>
    );
  }
  if (job.outcome === "unreported") {
    return (
      <div className="jobbar" data-state="unreported">
        <span className="jobbar-ic" data-tone="warn"><TriangleAlert size={12} strokeWidth={2.4} aria-hidden /></span>
        <span className="jobbar-w1">RIVENDELL NEVER GOT THE ANSWER</span>
        <span className="jobbar-w2">it is here, in this session</span>
        <span className="jobbar-sp" />
        {link}{ask}
      </div>
    );
  }
  if (failed) {
    const why = again && again !== "busy" && again !== "sent" ? again : job.error || "the run failed";
    return (
      <div className="jobbar" data-state="failed">
        <span className="jobbar-ic" data-tone="err"><X size={12} strokeWidth={2.6} aria-hidden /></span>
        <span className="jobbar-w1">{again === "sent" ? "SENT TO RIVENDELL AGAIN" : "RIVENDELL GOT A FAILURE"}</span>
        <span className="jobbar-w2" title={why}>{again === "sent" ? "it comes back here as a new job" : why}</span>
        <span className="jobbar-sp" />
        {link}
        {canRunAgain(job) && again !== "sent" && (
          <button type="button" className="jobbar-btn" data-pri disabled={again === "busy"}
            onClick={() => { setAgain("busy"); void onAgain().then((err) => setAgain(err ?? "sent")); }}>
            <RotateCw size={12} aria-hidden />{again === "busy" ? "ASKING…" : "RUN AGAIN"}
          </button>
        )}
        {ask}
      </div>
    );
  }
  return (
    <div className="jobbar" data-state="done">
      <span className="jobbar-ic" data-tone="ok"><Check size={12} strokeWidth={2.6} aria-hidden /></span>
      <span className="jobbar-w1">{job.outcome === "completed" ? `${label} SENT TO RIVENDELL` : `${label} · DONE`}</span>
      {meta && <span className="jobbar-w2">{meta}</span>}
      <span className="jobbar-sp" />
      {link}{ask}
    </div>
  );
}
