// The session an AI is fixing a failed update (or push) in, as the UPDATE reader's
// fixing row reads it. While it works, /running says what it is doing now (its job's
// activity, the label its status carries); once it goes quiet, its last turn says how
// it ended (transcript_page.summarize's first answer line). Pure, so the check runs
// without a bridge; UpdateButton's hook does the polling.
import type { RunningInfo, Transcript } from "../api.ts";

export interface FixView {
  phase: "starting" | "running" | "ask" | "done" | "failed";
  title: string;
  line: string;
  secs: number | null;   // how long the last turn took, once it ended
}

type Run = Pick<RunningInfo, "jobs" | "status">;
type Tail = Pick<Transcript, "session" | "turns">;

/** Its last turn has ended: nothing will change until you send it something. */
export function finished(t: Tail | null): boolean {
  const last = t?.turns.at(-1);
  return !!last && last.status !== "running";
}

/** /running holds it: a job, or a status other than idle. */
export function isLive(id: string, run: Run): boolean {
  const st = run.status?.[id];
  return run.jobs.some((j) => j.session_id === id) || (!!st && st.state !== "idle");
}

export function fixView(id: string, run: Run, t: Tail | null): FixView {
  const job = run.jobs.find((j) => j.session_id === id);
  const st = run.status?.[id];
  const live = isLive(id, run);
  const title = job?.title || t?.session?.title || "";
  if (live) {
    const ask = st?.state === "awaiting" || st?.state === "asking";
    return { phase: ask ? "ask" : "running", title, line: job?.activity.label || st?.label || "", secs: null };
  }
  // Not in /running and no ended turn: the prompt is still on its way in.
  if (!finished(t)) return { phase: "starting", title, line: "", secs: null };
  const last = t!.turns.at(-1)!;
  return { phase: last.status === "error" ? "failed" : "done", title, line: last.sum?.answer ?? "", secs: last.elapsed ?? null };
}
