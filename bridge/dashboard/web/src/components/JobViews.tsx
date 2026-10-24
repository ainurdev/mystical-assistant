import { useState, type CSSProperties, type ReactElement, type ReactNode } from "react";
import {
  GitCommitHorizontal, GitMerge,
  ArrowRight, ArrowUpRight, CalendarClock, CircleAlert, CircleArrowUp, CircleCheck, CircleDashed, CircleMinus,
  CircleQuestionMark, Clapperboard, FileCode, GitBranch, GitPullRequest, MessageCircleQuestionMark, Minus, Stamp,
} from "lucide-react";
import { api, type RivendellJob } from "../api";
import { parsePaper } from "../lib/jobs";
import {
  clockOf, fileOf, otherSide, parseBrief, parseChangelog, parseImpl, parseNotes, parseReview, parseSummary,
  parseTaskDesc, parseVideo, questionOf, withTimecodes,
  type Brief, type BriefItem, type Changelog, type Impl, type Notes, type Review, type Summary, type TaskDesc, type Video, branchesOf, parseConflict, type Conflict} from "../lib/jobviews";
import { Markdown } from "./Markdown";
import { Newspaper } from "./Newspaper";

// A Rivendell job's answer drawn as the thing it is — a brief, minutes, a review,
// release notes — the way the newspaper always was, instead of its JSON or its
// markdown. Every kind sits on the newspaper's sheet (.paper) and draws only what
// the answer, the job's facts or Rivendell's prompt for it hold: whatever only
// Rivendell's server adds (client names, deploy badges, "N merged") stays out.
// An answer its parser can't read (lib/jobviews) gets no view: the box keeps the
// markdown, so nothing is lost. Spec: docs/superpowers/specs/job-views.md.

/** What a job's view reads besides the answer: its facts and Rivendell's prompt (turn 1). */
export type JobViewInput = { job: RivendellJob; prompt: string };

/** The view a job's answer is drawn as, or null to keep the markdown. */
export function jobView({ job, prompt }: JobViewInput, result: string): ReactElement | null {
  switch (job.kind) {
    case "news": { const p = parsePaper(result); return p ? <Newspaper paper={p} date={job.date} /> : null; }
    case "meeting-brief": { const b = parseBrief(result); return b ? <BriefView b={b} job={job} prompt={prompt} /> : null; }
    case "project-summary": { const s = parseSummary(result, prompt); return s ? <SummaryView s={s} job={job} /> : null; }
    case "meeting-notes": { const n = parseNotes(result); return n ? <NotesView n={n} job={job} /> : null; }
    case "review": { const r = parseReview(result); return r ? <ReviewView r={r} job={job} /> : null; }
    case "impl": { const m = parseImpl(result, job.repo); return m ? <ImplView m={m} job={job} /> : null; }
    case "conflict": { const c = parseConflict(result); return c ? <ConflictView c={c} job={job} prompt={prompt} /> : null; }
    case "taskdesc": { const t = parseTaskDesc(result); return t ? <TaskDescView t={t} job={job} /> : null; }
    case "changelog": { const c = parseChangelog(result); return c ? <ChangelogView c={c} job={job} /> : null; }
    case "video": {
      const v = job.step === "ask" ? null : parseVideo(result, prompt);
      if (v) return <VideoView v={v} job={job} prompt={prompt} />;
      return job.step === "ask" || questionOf(prompt) ? <AskView answer={result} job={job} prompt={prompt} /> : null;
    }
    default: return null;
  }
}

// ── shared pieces ─────────────────────────────────────────────────────────────

function Md({ children }: { children: string }) {
  return <Markdown className="jv-md">{children}</Markdown>;
}

function Sec({ label, n, tone }: { label: string; n?: number | string; tone?: string }) {
  return <div className="jv-sec" style={tone ? { color: tone } : undefined}>{label}{n != null && n !== "" && <b>{n}</b>}</div>;
}

function Foot({ children, links }: { children?: ReactNode; links?: { href?: string; label: string }[] }) {
  const ls = (links ?? []).filter((l) => l.href);
  return (
    <div className="jv-foot">
      {children}
      {ls.length > 0 && (
        <span className="jv-links">
          {ls.map((l) => (
            <a key={l.label} className="jv-lnk" href={l.href} target="_blank" rel="noreferrer"><ArrowUpRight size={11} aria-hidden />{l.label}</a>
          ))}
        </span>
      )}
    </div>
  );
}
const inRivendell = (job: RivendellJob) => ({ href: job.url, label: "In Rivendell" });

/** A one-line title with its `code` drawn as code (finding and task titles carry identifiers). */
function Inline({ text }: { text: string }) {
  return <>{text.split(/`([^`]+)`/).map((p, i) => (i % 2 ? <code key={i}>{p}</code> : p))}</>;
}

function Refs({ refs }: { refs: string[] }) {
  return <>{refs.map((r) => <span key={r} className="jv-rf">{r}</span>)}</>;
}

// ── MEETING BRIEF ─────────────────────────────────────────────────────────────

const BRIEF_SEC = {
  done: { label: "Done", Icon: CircleCheck, tone: "var(--ok)" },
  progress: { label: "In progress", Icon: CircleDashed, tone: "var(--info)" },
  next: { label: "Coming next", Icon: CalendarClock, tone: "var(--think)" },
} as const;

/** "in 1h 48m", "now", "started 4 min ago" — or "" when the start is far off or unknown. */
function countdown(iso: string | undefined, now = Date.now()): { big: string; small: string } | null {
  const t = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(t)) return null;
  const min = Math.round((t - now) / 60000);
  if (min > 24 * 60 || min < -90) return null;
  if (min > 0) return { big: min >= 60 ? `${Math.floor(min / 60)}h ${String(min % 60).padStart(2, "0")}m` : `${min}m`, small: "UNTIL IT STARTS" };
  return { big: "NOW", small: min === 0 ? "STARTING" : `STARTED ${-min} MIN AGO` };
}

function BriefItems({ items }: { items: BriefItem[] }) {
  return (
    <>
      {items.map((it, i) => (
        <div key={i} className="jv-it">{it.text}{it.who && <span className="jv-who"> — {it.who}</span>}<Refs refs={it.refs} /></div>
      ))}
    </>
  );
}

function BriefView({ b, job, prompt }: { b: Brief; job: RivendellJob; prompt: string }) {
  const start = job.starts ? new Date(job.starts) : null;
  const ok = start && !Number.isNaN(start.getTime());
  const soon = countdown(job.starts);
  const ask = b.sections.find((s) => s.kind === "ask");
  const boxes = b.sections.filter((s) => s.kind !== "ask");
  const who = otherSide(prompt);
  return (
    <div className="paper jv jv-brief">
      <div className="jv-mast jv-bf-mast">
        {ok ? (
          <div className="jv-cal"><b>{start!.toLocaleDateString("en-GB", { weekday: "short" }).toUpperCase()}</b><span>{start!.getDate()}</span></div>
        ) : <span className="jv-tile big"><CalendarClock size={22} aria-hidden /></span>}
        <div className="min-w-0">
          <div className="jv-ey">Meeting brief{ok && ` · ${start!.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}`}</div>
          <div className="jv-title">{job.title || "Meeting"}</div>
          <div className="jv-subl">{b.projects.length ? `${b.projects.length} project${b.projects.length > 1 ? "s" : ""}` : "one project"}{ask && ` · questions for ${who}`}</div>
        </div>
        {soon && <div className="jv-soon"><b>{soon.big}</b><span>{soon.small}</span></div>}
      </div>
      <p className="jv-lead">{b.lead}</p>
      {boxes.length > 0 && (
        <div className="jv-bf-grid">
          {boxes.map((s, i) => {
            const k = BRIEF_SEC[s.kind as keyof typeof BRIEF_SEC];
            const wide = boxes.length % 2 === 1 && i === boxes.length - 1;
            return (
              <div key={s.kind} className="jv-bs" style={{ "--c": k.tone, gridColumn: wide ? "1 / -1" : undefined } as CSSProperties}>
                <h5><k.Icon size={13} aria-hidden />{k.label}<em>{s.items.length}</em></h5>
                <BriefItems items={s.items} />
              </div>
            );
          })}
        </div>
      )}
      {b.projects.length > 0 && (
        <>
          <Sec label="By project" n={b.projects.length} />
          {b.projects.map((p) => (
            <div key={p.name} className="jv-proj">
              <span className="jv-pm">{p.name.slice(0, 1).toUpperCase()}</span>
              <div className="min-w-0">
                <h4>{p.name}<span className="jv-tl">{p.items.length} ITEM{p.items.length > 1 ? "S" : ""}</span></h4>
                <ul>{p.items.map((it, i) => <li key={i}>{it.text}{it.who && <span className="jv-who"> — {it.who}</span>}<Refs refs={it.refs} /></li>)}</ul>
              </div>
            </div>
          ))}
        </>
      )}
      {ask && (
        <div className="jv-askbox">
          <h5><MessageCircleQuestionMark size={13} aria-hidden />TO ASK {who.toUpperCase()} · {ask.items.length}</h5>
          {ask.items.map((it, i) => <div key={i} className="jv-q"><i>?</i><span>{it.text}<Refs refs={it.refs} /></span></div>)}
        </div>
      )}
      <Foot links={[inRivendell(job)]}><span>Written from the sources only · read it before you pass it on</span></Foot>
    </div>
  );
}

// ── PROJECT SUMMARY ───────────────────────────────────────────────────────────

function SummaryView({ s, job }: { s: Summary; job: RivendellJob }) {
  const all = s.forward.length + s.attention.length;
  const cut = all ? Math.round((s.forward.length / all) * 100) : 100;
  return (
    <div className="paper jv jv-summary">
      <div className="jv-mast jv-sm-mast">
        <span className="jv-pm big">{(job.title || "P").slice(0, 1).toUpperCase()}</span>
        <div className="min-w-0">
          <div className="jv-ey">Project summary{s.period && ` · ${s.period.label}`}</div>
          <div className="jv-title">{job.title || "Project"}</div>
        </div>
        {s.period && <div className="jv-span">{s.period.from}<i />{s.period.to}</div>}
      </div>
      <div className="jv-flow" style={{ "--cut": `${cut}%` } as CSSProperties}>
        {s.forward.length > 0 && <div className="jv-fl-h"><CircleArrowUp size={14} aria-hidden />MOVED FORWARD</div>}
        {s.forward.map((b, i) => <div key={`f${i}`} className="jv-bl"><Md>{b}</Md></div>)}
        {s.attention.length > 0 && <div className="jv-fl-h att"><CircleAlert size={14} aria-hidden />NEEDS ATTENTION</div>}
        {s.attention.map((b, i) => <div key={`a${i}`} className="jv-bl att"><Md>{b}</Md></div>)}
      </div>
      <Foot links={[inRivendell(job)]}><span>{all} point{all > 1 ? "s" : ""}</span></Foot>
    </div>
  );
}

// ── MEETING NOTES ─────────────────────────────────────────────────────────────

function NotesView({ n, job }: { n: Notes; job: RivendellJob }) {
  const source = job.step === "recording" ? "from the recording" : job.step === "text" ? "from the notes" : "";
  return (
    <div className="paper jv jv-notes">
      <div className="jv-mast jv-mn-mast">
        <div className="min-w-0">
          <div className="jv-ey">Meeting notes{source && ` · ${source}`}</div>
          <div className="jv-title">{job.title || "Meeting"}</div>
        </div>
        <div className="jv-chips">
          {n.decisions.length > 0 && <span className="jv-chip acc">{n.decisions.length} decision{n.decisions.length > 1 ? "s" : ""}</span>}
          {n.actions.length > 0 && <span className="jv-chip">{n.actions.length} to do</span>}
        </div>
      </div>
      {n.summary && <div className="jv-deck"><Md>{n.summary}</Md></div>}
      <div className={n.topics.length && (n.decisions.length || n.actions.length) ? "jv-mn-body" : undefined}>
        {n.topics.length > 0 && (
          <div>
            <Sec label="Topics" n={n.topics.length} />
            {n.topics.map((t) => <div key={t.title} className="jv-topic"><h4>{t.title}</h4><Md>{t.body}</Md></div>)}
          </div>
        )}
        {(n.decisions.length > 0 || n.actions.length > 0) && (
          <div>
            {n.decisions.length > 0 && (
              <>
                <Sec label="Decisions" n={n.decisions.length} />
                <ul className="jv-dec">{n.decisions.map((d, i) => <li key={i}><Stamp size={14} aria-hidden /><Md>{d}</Md></li>)}</ul>
              </>
            )}
            {n.actions.length > 0 && (
              <>
                <Sec label="Action items" n={n.actions.length} />
                {n.actions.map((a, i) => (
                  <div key={i} className="jv-act">
                    <i className="jv-box" />
                    <div className="min-w-0">
                      <h5>{a.title}</h5>
                      {a.description && <p>{a.description}</p>}
                      {a.owner ? <span className="jv-owner"><span className="jv-av">{initials(a.owner)}</span>{a.owner}</span>
                        : <span className="jv-owner none">no owner said</span>}
                    </div>
                  </div>
                ))}
              </>
            )}
          </div>
        )}
      </div>
      <Foot links={[inRivendell(job)]}>{n.actions.length > 0 && <span>{n.actions.length} action item{n.actions.length > 1 ? "s" : ""} wait in Rivendell</span>}</Foot>
    </div>
  );
}
const initials = (name: string) => name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join("").toUpperCase();

// ── REVIEW ────────────────────────────────────────────────────────────────────

function ReviewView({ r, job }: { r: Review; job: RivendellJob }) {
  const all = r.groups.flatMap((g) => g.findings);
  const refs = all.reduce((a, f) => a + f.refs.length, 0);
  return (
    <div className="paper jv jv-review">
      <div className="jv-mast jv-rv-mast">
        <div className="min-w-0">
          <div className="jv-ey">Code review{job.number ? ` · PR #${job.number}` : ""}</div>
          <div className="jv-title">{job.title || "Review"}</div>
          {job.repo && <div className="jv-subl"><span><GitBranch size={12} aria-hidden />{job.repo}</span></div>}
        </div>
        {r.verdict && <div className="jv-stamp" data-tone={r.verdict.tone}>{stampWords(r.verdict.text)}</div>}
      </div>
      {r.intro && <div className="jv-deck"><Md>{r.intro}</Md></div>}
      {r.groups.map((g, gi) => (
        <div key={gi} className="jv-rv-group">
          {g.title && <Sec label={g.title} n={g.findings.length || undefined} />}
          {g.findings.map((f) => (
            <div key={f.n} className="jv-fd">
              <span className="jv-fd-n" data-nit={/nit/i.test(g.title) || undefined}>{f.n}</span>
              <div className="min-w-0">
                <h4><Inline text={f.title} /></h4>
                {f.refs.length > 0 && <div className="jv-refs">{f.refs.map((x) => <span key={x} className="jv-ref">{FILE.test(x) && <FileCode size={11} aria-hidden />}{x}</span>)}</div>}
                {f.body && <Md>{f.body}</Md>}
                {f.fix && <div className="jv-fix"><b>FIX</b><Md>{f.fix}</Md></div>}
              </div>
            </div>
          ))}
          {g.body && <Md>{g.body}</Md>}
        </div>
      ))}
      <Foot links={[{ href: job.html_url, label: "Open PR" }, inRivendell(job)]}>
        <span>{all.length} finding{all.length > 1 ? "s" : ""}{refs ? ` · ${refs} file ref${refs > 1 ? "s" : ""}` : ""}</span>
      </Foot>
    </div>
  );
}
/** A ref that names a file ("a/b.ts", "contacts.$id.tsx:195-204") gets the file glyph; a symbol doesn't. */
const FILE = /\/|\.(tsx?|jsx?|mjs|cjs|py|go|rs|rb|java|kt|swift|css|scss|html?|md|json|ya?ml|sql|sh|toml|vue|svelte|php|cs|c|h|cpp)(:\d+(-\d+)?)?$/i;

/** "approve with changes" -> APPROVE / WITH CHANGES on the stamp's two lines. */
function stampWords(v: string) {
  const m = /^(\S+(?:\s+changes)?)\s+(.+)$/.exec(v);
  return m && m[2].length <= 22 ? <>{m[1].toUpperCase()}<small>{m[2].toUpperCase()}</small></> : <>{v.toUpperCase()}</>;
}

// ── IMPLEMENT ─────────────────────────────────────────────────────────────────

function ImplView({ m, job }: { m: Impl; job: RivendellJob }) {
  const done = m.tasks.filter((t) => t.done).length, skipped = m.tasks.length - done;
  return (
    <div className="paper jv jv-impl">
      <div className="jv-ey">Implemented{m.tasks.length > 1 ? ` · batch · ${m.tasks.length} tasks` : ""}</div>
      <div className="jv-title">{job.title || "Implementation"}</div>
      {m.pr && (
        <div className="jv-stub">
          <div>
            <div className="jv-pr-h"><span className="jv-tile ok"><GitPullRequest size={15} aria-hidden /></span><span className="n">#{m.pr.number}</span><span className="jv-chip">{m.pr.repo}</span></div>
            {m.branch && <div className="jv-pr-br"><span className="b">{m.branch}</span></div>}
          </div>
          <div className="jv-tear"><a className="jv-lnk" href={m.pr.url} target="_blank" rel="noreferrer"><ArrowUpRight size={11} aria-hidden />Open PR</a></div>
        </div>
      )}
      {m.tasks.length > 0 && (
        <>
          <Sec label="Tasks" n={[done && `${done} done`, skipped && `${skipped} skipped`].filter(Boolean).join(" · ")} />
          <div className="jv-tasks">
            {m.tasks.map((t) => (
              <div key={t.key} className="jv-task" data-skip={!t.done || undefined}>
                <span className="st">{t.done ? <CircleCheck size={15} aria-hidden /> : <CircleMinus size={15} aria-hidden />}</span>
                <span className="key">{t.key}</span>
                <span className="nm"><Inline text={t.name} />{t.why && <span className="why">Skipped: {t.why}</span>}</span>
              </div>
            ))}
          </div>
        </>
      )}
      {m.body && <div className="jv-impl-body"><Md>{m.body}</Md></div>}
      {m.open.length > 0 && (
        <div className="jv-open">
          <Sec label="Open questions" n={m.open.length} tone="var(--warn)" />
          <ul>{m.open.map((o, i) => <li key={i}><Md>{o}</Md></li>)}</ul>
        </div>
      )}
      <Foot links={[inRivendell(job)]}>{job.repo && <span>{job.repo}</span>}</Foot>
    </div>
  );
}

// ── MERGE CONFLICTS ───────────────────────────────────────────────────────────

/** A conflicts job's report, as a merge slip: the base folded into the branch under a
 *  RESOLVED (or STOPPED) stamp, each file and how it was settled, the tests that ran
 *  and the commit it pushed. The PR opens in Rivendell first. */
function ConflictView({ c, job, prompt }: { c: Conflict; job: RivendellJob; prompt: string }) {
  const br = branchesOf(prompt);
  const resolved = c.outcome === "resolved";
  return (
    <div className="paper jv jv-conflict">
      <div className="jv-mast jv-rv-mast">
        <div className="min-w-0">
          <div className="jv-ey">Merge conflicts{job.number ? ` · PR #${job.number}` : ""}</div>
          <div className="jv-title">{job.title || "Merge conflicts"}</div>
          {(job.repo || br) && (
            <div className="jv-subl">
              {job.repo && <span><GitMerge size={12} aria-hidden />{job.repo}</span>}
              {br && <span className="jv-cf-br"><b>{br.base}</b> into <b>{br.head}</b></span>}
            </div>
          )}
        </div>
        <div className="jv-stamp" data-tone={resolved ? undefined : "warn"}>{resolved ? "RESOLVED" : "STOPPED"}</div>
      </div>
      {c.summary && <div className="jv-deck"><Md>{c.summary}</Md></div>}
      {c.files.length > 0 && (
        <>
          <Sec label="Files" n={c.files.length} />
          <div className="jv-cf-files">
            {c.files.map((f) => (
              <div key={f.path} className="jv-cf-file">
                <span className="jv-ref"><FileCode size={11} aria-hidden />{f.path}</span>
                {f.how && <span className="how"><Inline text={f.how} /></span>}
              </div>
            ))}
          </div>
        </>
      )}
      {c.tests && (
        <div className="jv-cf-tests" data-ok={c.tests.passed || undefined}>
          {c.tests.passed ? <CircleCheck size={15} aria-hidden /> : <CircleMinus size={15} aria-hidden />}
          <span className="min-w-0"><b>{c.tests.passed ? "Tests passed" : "Tests failed"}</b>{c.tests.summary && ` · ${c.tests.summary}`}
            {c.tests.command && <code>{c.tests.command}</code>}</span>
        </div>
      )}
      {c.notes && (
        <div className="jv-open">
          <Sec label={resolved ? "Notes" : "Why it stopped"} tone={resolved ? undefined : "var(--warn)"} />
          <Md>{c.notes}</Md>
        </div>
      )}
      <Foot links={[{ href: job.url ?? job.html_url, label: "Open PR" }, { href: job.url ? job.html_url : undefined, label: "On GitHub" }]}>
        {c.commit ? <span className="jv-cf-commit"><GitCommitHorizontal size={12} aria-hidden />pushed {c.commit.slice(0, 7)}</span> : <span>nothing pushed</span>}
      </Foot>
    </div>
  );
}

// ── TASK DESCRIPTION ──────────────────────────────────────────────────────────

function TaskDescView({ t, job }: { t: TaskDesc; job: RivendellJob }) {
  const key = /\b[A-Z][A-Z0-9]+-\d+\b/.exec(job.title ?? "")?.[0] ?? "TASK";
  return (
    <div className="paper jv jv-taskdesc">
      <div className="jv-tk">
        <div className="jv-tk-tab"><span>{key}</span></div>
        <div className="jv-tk-main">
          <div className="jv-ey">Task description</div>
          <div className="jv-tk-title">{job.title || "Task"}</div>
          <div className="jv-chips"><span className="jv-chip">replaces the task’s description</span><span className="jv-chip">~{t.words} words</span></div>
          {t.goal && <div className="jv-goal"><b>GOAL</b><Md>{t.goal}</Md></div>}
          {t.context && <div className="jv-td-sec"><Sec label="Context" /><Md>{t.context}</Md></div>}
          {t.scope.length > 0 && (
            <div className="jv-td-sec"><Sec label="Scope" n={t.scope.length} />
              <ul className="jv-scope">{t.scope.map((s, i) => <li key={i}><ArrowRight size={13} aria-hidden /><Md>{s}</Md></li>)}</ul></div>
          )}
          {t.criteria.length > 0 && (
            <div className="jv-td-sec"><Sec label="Acceptance criteria" n={t.criteria.length} />
              <ul className="jv-ac">{t.criteria.map((s, i) => <li key={i}><i /><Md>{s}</Md></li>)}</ul></div>
          )}
          {(t.out.length > 0 || t.questions.length > 0) && (
            <div className="jv-td-sec jv-two">
              {t.out.length > 0 && <div><Sec label="Out of scope" /><ul className="jv-scope oos">{t.out.map((s, i) => <li key={i}><Minus size={13} aria-hidden /><Md>{s}</Md></li>)}</ul></div>}
              {t.questions.length > 0 && <div><Sec label="Open questions" n={t.questions.length} /><ul className="jv-scope oq">{t.questions.map((s, i) => <li key={i}><CircleQuestionMark size={13} aria-hidden /><Md>{s}</Md></li>)}</ul></div>}
            </div>
          )}
        </div>
      </div>
      <Foot links={[{ href: job.html_url, label: "Open task" }, inRivendell(job)]}><span>Rivendell writes this into the task</span></Foot>
    </div>
  );
}

// ── CHANGELOG ─────────────────────────────────────────────────────────────────

const GROUP_TONE: [RegExp, string][] = [
  [/^added|^new/i, "var(--ok)"], [/^changed|^improved/i, "var(--info)"], [/^fixed/i, "var(--warn)"],
  [/^security/i, "var(--err)"], [/^coming/i, "var(--think)"], [/^deprecated/i, "var(--warn)"],
];
const toneOf = (name: string) => GROUP_TONE.find(([re]) => re.test(name))?.[1] ?? "var(--txd)";

function ChangelogView({ c, job }: { c: Changelog; job: RivendellJob }) {
  const v = /^v?(\d[\w.-]*)$/i.exec(c.version);
  const entries = c.groups.reduce((a, g) => a + g.entries.length, 0);
  const prs = new Set(c.groups.flatMap((g) => g.entries.flatMap((e) => e.refs.map((r) => r.label)).filter((l) => /^#\d+$/.test(l)))).size;
  const day = c.date ? new Date(`${c.date}T12:00:00`).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) : "";
  return (
    <div className="paper jv jv-changelog">
      <div className="jv-mast jv-cl-mast">
        <div className="jv-ver" data-word={!v || undefined}>{v ? <><small>v</small>{v[1]}</> : c.version}</div>
        <div className="min-w-0">
          <div className="jv-ey">Release notes{day && ` · ${day}`}</div>
          <div className="jv-cl-name">{job.title || ""}</div>
        </div>
      </div>
      {c.summary && <div className="jv-deck"><Md>{c.summary}</Md></div>}
      {c.groups.map((g) => (
        <div key={g.name} className="jv-grp" style={{ "--c": toneOf(g.name) } as CSSProperties}>
          <div className="jv-grp-h"><b>{g.name.toUpperCase()} · {g.entries.length}</b></div>
          {g.entries.map((e, i) => (
            <div key={i} className="jv-ent">
              <div className="min-w-0">
                {e.breaking && <span className="jv-brk">BREAKING</span>}
                <Md>{e.text}</Md>
                {e.refs.length > 0 && (
                  <span className="jv-crefs">{e.refs.map((r) => r.url
                    ? <a key={r.label} href={r.url} target="_blank" rel="noreferrer">{r.label}</a>
                    : <span key={r.label}>{r.label}</span>)}</span>
                )}
              </div>
            </div>
          ))}
        </div>
      ))}
      <Foot links={[inRivendell(job)]}><span>{entries} change{entries > 1 ? "s" : ""}{prs ? ` · ${prs} PR${prs > 1 ? "s" : ""}` : ""}</span></Foot>
    </div>
  );
}

// ── VIDEO ─────────────────────────────────────────────────────────────────────

const SCREENS_SHUT = 8;

function VideoView({ v, job, prompt }: { v: Video; job: RivendellJob; prompt: string }) {
  const [allShots, setAllShots] = useState(v.screens.length <= SCREENS_SHUT + 2);
  const name = fileOf(prompt)?.name ?? job.title ?? "Recording";
  const end = Math.max(v.length, ...v.chapters.map((c) => c.ms + 1000));
  return (
    <div className="paper jv jv-video">
      <div className="jv-mast jv-vd-mast">
        <span className="jv-tile big info"><Clapperboard size={22} aria-hidden /></span>
        <div className="min-w-0">
          <div className="jv-ey">Recording · transcribed{job.language ? ` · ${job.language}` : ""}</div>
          <div className="jv-title">{name}</div>
          <div className="jv-subl">{[v.length ? clockOf(v.length) : "", v.chapters.length && `${v.chapters.length} chapters`, v.screens.length && `${v.screens.length} screens`].filter(Boolean).join(" · ")}</div>
        </div>
      </div>
      {v.chapters.length > 1 && (
        <div className="jv-reel" aria-hidden>
          <div className="jv-track">
            {v.chapters.map((c, i) => {
              const next = v.chapters[i + 1]?.ms ?? end;
              return <div key={i} className="jv-seg" style={{ flex: Math.max(1, next - c.ms) }}><i>{i + 1}</i></div>;
            })}
          </div>
          <div className="jv-ruler">{[0, 0.25, 0.5, 0.75, 1].map((f) => <span key={f}>{clockOf(end * f)}</span>)}</div>
        </div>
      )}
      {v.summary && <p className="jv-deck jv-vd-sum">{v.summary}</p>}
      <div className={v.chapters.length && v.keyPoints.length ? "jv-vd-cols" : undefined}>
        {v.chapters.length > 0 && (
          <div><Sec label="Chapters" n={v.chapters.length} />
            <ul className="jv-chap">{v.chapters.map((c, i) => <li key={i}><b>{clockOf(c.ms)}</b>{c.title}</li>)}</ul></div>
        )}
        {v.keyPoints.length > 0 && (
          <div><Sec label="Key points" n={v.keyPoints.length} />
            <ol className="jv-kp">{v.keyPoints.map((k, i) => <li key={i}>{k}</li>)}</ol></div>
        )}
      </div>
      {v.screens.length > 0 && (
        <>
          <Sec label="Screens" n={v.screens.length} />
          <div className="jv-screens">
            {(allShots ? v.screens : v.screens.slice(0, SCREENS_SHUT)).map((s) => (
              <figure key={s.index} className="jv-shot">
                <div className="f">
                  {s.path && <img src={api.attachmentUrl(s.path)} alt="" loading="lazy" onError={(e) => { e.currentTarget.style.display = "none"; }} />}
                  {s.ms != null && <u>{clockOf(s.ms)}</u>}
                </div>
                <figcaption>{s.caption || `Screen ${s.index}`}</figcaption>
              </figure>
            ))}
          </div>
          {!allShots && <button type="button" className="jv-more" onClick={() => setAllShots(true)}>SHOW ALL {v.screens.length} SCREENS</button>}
        </>
      )}
      <Foot links={[inRivendell(job)]}><span>Transcript{job.language ? ` · ${job.language}` : ""}</span></Foot>
    </div>
  );
}

function AskView({ answer, job, prompt }: { answer: string; job: RivendellJob; prompt: string }) {
  const file = fileOf(prompt);
  const q = questionOf(prompt);
  return (
    <div className="paper jv jv-ask">
      <div className="jv-mast jv-va-mast">
        <span className="jv-tile big info"><Clapperboard size={18} aria-hidden /></span>
        <div className="min-w-0">
          <div className="jv-ey">Recording · asked</div>
          <div className="jv-va-file">{file?.name ?? job.title ?? "Recording"}{file?.length ? <span className="jv-dimmono"> · {clockOf(file.length)}</span> : null}</div>
        </div>
      </div>
      {q && <div className="jv-va-q"><span className="qq">?</span><p>{q}</p></div>}
      <div className="jv-va-a"><Markdown className="jv-md">{withTimecodes(answer)}</Markdown></div>
      <Foot links={[inRivendell(job)]}><span>m:ss marks a moment in the recording</span></Foot>
    </div>
  );
}
