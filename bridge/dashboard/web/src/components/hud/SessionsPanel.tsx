import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ProjectTile } from "../ui/ProjectTile";
import { useVirtualizer } from "@tanstack/react-virtual";
import { BellRing, FolderTree, History, Hourglass, Image as ImageIcon, PanelLeftOpen, Plus, Puzzle, Search } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { SessionBrief, SessionStatus } from "../../api";
import { api } from "../../api";
import { ago, projectName, projectTint } from "../../lib/surfaces";
import type { ProjectTint } from "../../lib/surfaces";
import { dayLabel, isJob, JOB_LABEL, jobGroup, jobLabel, JOBS_REL, jobTarget } from "../../lib/jobs";
import { JOB_ICON, JobsTile } from "./JobTag";
import { orderBranches } from "../../lib/branchorder";
import { useIntegrations } from "../../lib/integrations";
import { useStickyObj } from "../../lib/prefs";
import { isDeviceRun, rowAge } from "../../lib/devicerun";
import { isTeam, readOnly, shareFacts, SHARED_REL } from "../../lib/team";
import { shotUnseen, useSeenShots } from "../../lib/seenshots";
import { TeamTile } from "../TeamBar";
import { Avatar } from "./TeamPanel";
import { DeviceTile } from "../DeviceRunPlate";
import type { ProjectGroup } from "./ProjectsPanel";
import { RivendellQueue } from "./RivendellQueue";

/** A prompt of yours that hasn't run yet, flagged on the session it belongs to:
 *  unsent text in the composer, a relevance check in flight, or a held card
 *  waiting on your answer. */
export type PromptFlag = "draft" | "checking" | "held";

// Flags render as quiet glyphs at the row's right edge, beside its state — a
// chip would out-shout the state dot that the whole panel now leans on, and a
// line of their own would make the row grow when you start typing.
const FLAG_VIEW: Record<PromptFlag, { c: string; l: string; t: string }> = {
  draft: { c: "var(--warn)", l: "✎", t: "unsent prompt waiting in this session" },
  checking: { c: "var(--purple)", l: "⋯", t: "checking this prompt fits this session" },
  held: { c: "var(--warn)", l: "held", t: "a prompt here needs your decision" },
};

interface Props {
  sessions: SessionBrief[]; // full list — RECENT and expanded projects need more than the capped group slices
  groups: ProjectGroup[];
  hidden: Record<string, boolean>; // HIDE's picks, folders and groups: their sessions list in PLUGINS only
  status: Map<string, SessionStatus>;
  done: Set<string>; // finished a turn, not opened since
  flags: Map<string, PromptFlag>; // prompts of yours that haven't run yet
  pins: Set<string>; // sessions you pinned — ranked first here and in the context menu
  selectedSessionId: string | null;
  /** First session list hasn't landed yet — the empty list means nothing yet. */
  booting?: boolean;
  activeProject: string | null;
  onTogglePin: (id: string) => void;
  onSelectSession: (s: SessionBrief) => void;
  onAnalyze: (rel: string) => void;
  onNewSession: (rel: string) => void;
  /** Start a typed session: the form's fields, already composed into a prompt. */
  onWorktreeSession: (rel: string, branch: string, create: boolean, parent?: string) => void;
  /** Scaffold a repo and open its first session on the given prompt. */
  onCreateProject: (name: string, prompt: string) => void;
  /** Folded to the rail: one tile per project you are working in. */
  folded?: boolean;
  onUnfold?: () => void;
}

type Mode = "attention" | "projects" | "plugins" | "recent";
/** Which pieces of a row's provenance it prints. Independent, because the four
 *  presets this replaced could not express the obvious wants — a sidebar that
 *  names the project but not the branch was simply not on the menu. */
type Detail = { proj: boolean; branch: boolean; wt: boolean };
// "recent" is the saved key for newest-started; it was last-used once, and
// keeping the key keeps everyone's saved pick.
type OrderMode = "recent" | "alpha" | "biggest" | "custom";

const PROJ_CAP = 10; // project chips shown before "SHOW ALL"
const BRANCH_CAP = 8; // branch chips shown before "SHOW ALL"

const ORDER_LABEL: Record<OrderMode, string> = {
  recent: "newest started", alpha: "a → z", biggest: "biggest", custom: "custom",
};
const ORDERS: OrderMode[] = ["recent", "alpha", "biggest", "custom"];

const FIELDS: { k: keyof Detail; label: string; tip: string }[] = [
  { k: "proj", label: "project name", tip: "Name the project on every row" },
  { k: "branch", label: "branch", tip: "Print the branch on every row" },
  { k: "wt", label: "worktree", tip: "Mark rows working in a worktree rather than the main checkout" },
];
/** PROJECTS rows sit under a header that already names the project, so that tick
 *  is not offered there — the other two tabs mix projects and need it. */
const fieldsFor = (mode: Mode) => (mode === "projects" ? FIELDS.filter((f) => f.k !== "proj") : FIELDS);
/** Detail is per tab, because each tab shows a different slice: ATTENTION mixes
 *  every project into four lanes and can't be read without the project name,
 *  while PROJECTS rows would rather spend the width on the branch. RECENT is its
 *  own stream again. */
const DETAIL_DEFAULT: Record<Mode, Detail> = {
  attention: { proj: true, branch: true, wt: true },
  projects: { proj: false, branch: true, wt: true },
  plugins: { proj: true, branch: true, wt: true },
  recent: { proj: true, branch: true, wt: true },
};

/** Rivendell jobs wear the PLUGINS lane's purple, apart from your own projects'. */
const JOB_TINT: ProjectTint = {
  color: "var(--purple)",
  border: "color-mix(in srgb, var(--purple) 45%, transparent)",
  dim: "color-mix(in srgb, var(--purple) 55%, var(--txd))",
  faint: "color-mix(in srgb, var(--purple) 30%, var(--txd))",
};

/** The PLUGINS tab's rows, one entry per worker the bridge can run, so a second
 *  plugin lands as a new lane here, not a redesign. The tab itself exists while
 *  Rivendell is installed. A lane holds what PROJECTS files under that plugin's
 *  group (lib/jobs isJob), not only sessions with its origin: meeting notes run
 *  by hand carry none, so they never showed here. DEVICE RUNS are teammates'
 *  runs on this device (lib/devicerun), in the device-run blue, apart from your
 *  accent and Rivendell's purple. */
const PLUGINS: { label: string; sub?: string; tint: string; match: (s: SessionBrief) => boolean }[] = [
  { label: "DEVICE RUNS", sub: "teammates on this device", tint: "var(--info)", match: (s) => isDeviceRun(s.origin) },
  { label: "FROM TEAMMATES", sub: "sessions sent to you", tint: "var(--purple)", match: (s) => isTeam(s.origin) },
  { label: "RIVENDELL", tint: "var(--purple)", match: isJob },
];
/** Newest-started first: when a session was created, not last touched, so a
 *  turn starting or ending never moves its row. Every tab but RECENT reads it.
 *  `created` is optional on older payloads, so fall back to `updated`. */
const byCreated = (a: SessionBrief, b: SessionBrief) =>
  (b.created ?? b.updated) - (a.created ?? a.updated);

// Which mode you were on, how PROJECTS is ordered, and your hand-dragged order.
// ponytail: localStorage = per-browser, like every other HUD pref (see lib/surfaces.ts).
const PREFS_KEY = "hud-sessions-prefs";
type Prefs = { mode: Mode; order: OrderMode; custom: string[]; shut: string[] };

function loadPrefs(): Prefs {
  try {
    const r = JSON.parse(localStorage.getItem(PREFS_KEY) || "{}") as Partial<Prefs> & { tab?: string };
    // Pre-v3 prefs stored {tab: "recent"|"grouped"} — carry the choice over once.
    const mode: Mode =
      r.mode === "attention" || r.mode === "projects" || r.mode === "plugins" || r.mode === "recent" ? r.mode
        : r.tab === "grouped" ? "projects" : r.tab === "recent" ? "recent" : "attention";
    return {
      mode,
      order: r.order && ORDERS.includes(r.order) ? r.order : "recent",
      custom: Array.isArray(r.custom) ? r.custom : [],
      shut: Array.isArray(r.shut) ? r.shut : [],
    };
  } catch { return { mode: "attention", order: "recent", custom: [], shut: [] }; }
}

/** The six lanes ATTENTION sorts every session into. */
type LaneKey = "ask" | "work" | "wait" | "parked" | "done" | "idle";

const LANES: { k: LaneKey; label: string; tint: string }[] = [
  { k: "ask", label: "NEEDS YOU", tint: "var(--warn)" },
  { k: "work", label: "WORKING", tint: "var(--ok)" },
  { k: "wait", label: "WAITING", tint: "var(--purple)" },
  { k: "parked", label: "PARKED", tint: "var(--info)" },
  { k: "done", label: "DONE — NOT OPENED", tint: "var(--acc)" },
  { k: "idle", label: "IDLE", tint: "var(--txd)" },
];

// Server state → lane, dot colour, filled?, tooltip. The dot's grammar: filled
// means the bridge holds a turn here — running, blocked on you, or parked until
// it can resume; a ring is passive. Ring colour still tells idle (dim) from
// live-elsewhere (info) — the lane collapses to five, the dot keeps the detail.
// Parked wears info, not warn: nothing on it is yours to answer.
const SV: Record<string, { lane: LaneKey; c: string; fill: boolean; t: string }> = {
  working: { lane: "work", c: "var(--ok)", fill: true, t: "working now" },
  checking: { lane: "work", c: "var(--ok)", fill: true, t: "checking your prompt against this session" },
  awaiting: { lane: "ask", c: "var(--warn)", fill: true, t: "waiting on your answer" },
  asking: { lane: "ask", c: "var(--warn)", fill: true, t: "asking you a question" },
  live: { lane: "idle", c: "var(--info)", fill: false, t: "live in another window" },
  parked: { lane: "parked", c: "var(--info)", fill: true, t: "parked — resumes on its own" },
  waiting: { lane: "wait", c: "var(--purple)", fill: true, t: "waiting on another session — wakes when it finishes" },
  idle: { lane: "idle", c: "var(--txl)", fill: false, t: "idle" },
};
const SV_DONE = { lane: "done" as LaneKey, c: "var(--acc)", fill: false, t: "finished a turn — not opened yet" };

const BUSY_NOW = ["working", "awaiting", "asking", "checking", "parked", "waiting"];

type StateView = { lane: LaneKey; c: string; fill: boolean; t: string };

/** A state's word where there is room for one (the composer's wait pill). */
export const LANE_WORD: Record<LaneKey, string> = {
  ask: "needs you", work: "working", wait: "waiting", parked: "parked", done: "idle", idle: "idle",
};

export function resolve(st: SessionStatus | undefined, isDone: boolean, flag?: PromptFlag): StateView {
  // DONE (finished, unopened) outranks idle/live, but never a state it's in
  // *now* — working, awaiting you, asking you, or having a prompt checked.
  const state = st?.state ?? "idle";
  const busy = BUSY_NOW.includes(state);
  let v = isDone && !busy ? SV_DONE : SV[state] ?? SV.idle;
  // The server knows when a parked turn comes back ("usage limit — resuming ~14:00").
  if (state === "parked" && st?.label) v = { ...v, t: st.label };
  if (state === "waiting" && st?.label) v = { ...v, t: st.then ? `${st.label} — then ${st.then}` : st.label };
  // A held card is a session that wants you, whatever its runner state says —
  // warn ring, not fill: nothing is running, a prompt of yours is parked on it.
  if (flag === "held" && (v.lane === "idle" || v.lane === "done"))
    v = { ...v, lane: "ask", c: "var(--warn)" };
  return v;
}

/** What a WAITING row knows about the session it waits on: whether you are the
 *  one holding it up (its title is in the row's tooltip, from the state label). */
type WaitLine = { needs: boolean };

/** How long a state has held, in the width a sidebar has: seconds under a
 *  minute, then minutes, then hours and minutes. */
const lasted = (s: number) =>
  s < 60 ? `${Math.max(1, s | 0)}s` : s < 3600 ? `${(s / 60) | 0}m` : `${(s / 3600) | 0}h ${String(((s % 3600) / 60) | 0).padStart(2, "0")}m`;

/** The two states that are yours to act on, as chips at a row's right edge. */
const edgeChip = (c: string, l: string) => (
  <span style={{ display: "inline-flex", alignItems: "center", height: 18, padding: "0 7px", borderRadius: "var(--f-rad-s, 0px)",
                 fontSize: "var(--t10)", fontWeight: 700, color: c, background: `color-mix(in srgb, ${c} 16%, transparent)` }}>{l}</span>
);

function SessionRow({
  s, i, on, v, st, flag, wait, shots, branch, home, pinned, showDot, showProj, detail, pulse, onPin, onAttach,
}: {
  s: SessionBrief;
  st?: SessionStatus;
  wait?: WaitLine;
  shots: number;     // its pictures you haven't opened (lib/seenshots)
  i?: number;        // place in a non-virtualised list — its entrance stagger
  on: boolean;
  v: StateView;
  flag?: PromptFlag;
  branch: string;
  home?: string;     // the project checkout's own branch — a row on it has nothing to say about branches
  pinned: boolean;
  showDot: boolean;  // PROJECTS rows carry the state dot; lane rows wear it as their left edge
  showProj: boolean; // lane rows name their project; PROJECTS rows sit under a header that already does
  detail: Detail;    // how much provenance the meta line prints
  pulse: boolean;    // a turn is in flight — the one state that earns motion
  onPin: () => void;
  onAttach: () => void;
}) {
  const [hov, setHov] = useState(false);
  const job = isJob(s);
  // A teammate's device run: no project of yours, so it wears the device-run blue.
  const dev = isDeviceRun(s.origin) ? s.device : null;
  // A session a teammate sent: theirs, so it wears Shared's purple and says whose it is.
  const team = isTeam(s.origin) ? s.team : null;
  const theirProj = team ? shareFacts("session", team.meta).project : undefined;
  const tint = job || team ? JOB_TINT : { ...projectTint(s.project), ...(dev && { color: "var(--info)", dim: "var(--info)" }) };
  const now = Date.now() / 1000;
  const age = dev ? rowAge(s, pulse, now) : null;
  const fv = flag ? FLAG_VIEW[flag] : null;
  // A sidebar has no room for a full ref, so a row prints the branch's last
  // segment; the full ref lives in the row tooltip. ROW DETAILS ticks decide
  // which facts are worth the width at all.
  // `s.worktree` is empty for the main checkout (git.worktree_name), so "in a
  // worktree at all" and "not the main worktree" are the same question.
  const inWorktree = !!(s.worktree || s.work_cwd);
  const wtTitle = s.work_cwd ? `working in ${s.work_cwd}` : s.worktree ? `worktree ${s.worktree}` : "";
  // A Rivendell job says what kind it is and what it was about, not where it ran.
  const target = job ? jobTarget(s.job) : "";
  const JobIcon = job && s.job?.kind ? JOB_ICON[s.job.kind as keyof typeof JOB_ICON] : null;
  // A row prints what differs from its neighbours, on a second line, and only
  // facts that hold still: the project where a tab mixes them, a branch that
  // isn't the checkout's, a worktree. State never takes a line — it is the
  // right edge — so a row keeps its height whatever its session does.
  const projShown = !job && !team && showProj && detail.proj;
  const branchShown = !job && !team && detail.branch && !!branch && branch !== home;
  const wtShown = !job && !team && detail.wt && inWorktree;
  const one = !dev && !projShown && !branchShown && !wtShown;
  // The state where the age used to be: how long a turn has run or waited,
  // the two states that are yours to act on, the age at rest.
  const since = st?.since;
  const edge = v.lane === "work" ? <span style={{ color: "var(--ok)" }}>{since ? lasted(now - since) : "now"}</span>
    : v.lane === "ask" ? edgeChip("var(--warn)", "Answer")
    : v.lane === "done" ? edgeChip("var(--ok)", "New")
    : v.lane === "wait" ? (
      <span style={{ display: "inline-flex", alignItems: "center", gap: 3, color: wait?.needs ? "var(--warn)" : "var(--purple)" }}>
        <Hourglass size={10} strokeWidth={2.2} aria-hidden />{since ? lasted(now - since) : ago(s.updated)}
      </span>
    )
    // the server's label says when it comes back ("usage limit — resuming ~14:00")
    : v.lane === "parked" ? <span style={{ color: "var(--info)" }}>↻ {st?.label?.match(/\d{1,2}:\d{2}/)?.[0] ?? ago(s.updated)}</span>
    : <span>{ago(s.updated)}</span>;
  // Unseen pictures: the WORK plate's NEW badge in miniature, under the time
  // where Telegram puts an unread count. Out of flow, so a tag coming or going
  // moves no row; a one-line row carries it beside the time instead.
  const shotTag = shots > 0 && (
    <span
      role="img" aria-label={`${shots} new picture${shots === 1 ? "" : "s"}`}
      title={`${shots} new picture${shots === 1 ? "" : "s"} you haven't opened`}
      style={{ ...(!one ? { position: "absolute", right: 0, top: 18 } : { flex: "none" }),
               display: "inline-flex", alignItems: "center", gap: 3, height: 15, padding: "0 5px 0 4px", borderRadius: 4,
               background: "var(--acc)", color: "var(--acc-on, var(--canvas))", fontSize: "var(--t85)", fontWeight: 800,
               lineHeight: 1, boxShadow: "0 0 8px color-mix(in oklab, var(--acc) 35%, transparent)" }}
    >
      <ImageIcon size={10} strokeWidth={2.4} aria-hidden style={{ flex: "none" }} />{shots > 99 ? "99+" : shots}
    </span>
  );
  return (
    <div
      onClick={onAttach}
      className="sessrow" data-on={showDot && on} data-one={one}
      onMouseEnter={() => setHov(true)} onMouseLeave={() => setHov(false)}
      data-ctx-type="session" data-ctx-id={s.id} data-ctx-label={s.title || "session"}
      title={job ? `${s.title || "untitled session"} · ${jobLabel(s.job).toLowerCase()}${target ? ` ${target}` : ""} · from Rivendell · ${v.t}`
        : team ? `${s.title || "untitled session"} · from ${team.from.name}${theirProj ? ` · ${theirProj}` : ""} · read only`
        : `${s.title || "untitled session"} · ${projectName(s.project)} · ${branch} · ${v.t}`}
      style={{
        display: "grid", gridTemplateColumns: showDot ? "8px 1fr auto" : "1fr auto", columnGap: 10,
        alignItems: one ? "center" : "start", padding: one ? "6px 8px" : "8px 8px 9px", position: "relative",
        // Lane rows wear their state on the left edge; PROJECTS rows carry a
        // dot instead and the .sessrow bar (--openbar) marks the open one.
        borderLeft: showDot ? undefined : `2px solid ${on ? tint.dim : `color-mix(in srgb, ${v.c} 32%, transparent)`}`,
        background: on ? `color-mix(in srgb, ${tint.color} 7%, transparent)` : hov ? "color-mix(in srgb, var(--acc) 4%, transparent)" : "transparent",
        cursor: "pointer", transition: "background .13s ease",
        // Rows cascade in when the list they sit in is rebuilt — a tab switch, a
        // project opening. Virtualised rows pass no `i`: they mount on scroll,
        // and a cascade every time you scroll is noise, not motion.
        animation: i === undefined ? undefined : "mfadeup .4s ease both",
        animationDelay: i === undefined ? undefined : `${Math.min(i, 10) * 35}ms`,
        ["--openbar" as string]: tint.dim,
      }}
    >
      {showDot && (
        <span
          className="sessdot" data-work={pulse} title={v.t}
          style={{ width: 8, height: 8, marginTop: one ? 0 : 3, borderRadius: "50%", boxSizing: "border-box",
                   background: v.fill ? v.c : "transparent", border: v.fill ? 0 : `1.5px solid ${v.c}`,
                   boxShadow: v.fill ? `0 0 7px color-mix(in srgb, ${v.c} 40%, transparent)` : "none" }}
        />
      )}
      <div style={{ minWidth: 0, display: "flex", flexDirection: "column", gap: 5 }}>
        <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                       fontSize: showDot ? "var(--t12)" : "var(--t125)", lineHeight: 1.3,
                       fontWeight: on ? 600 : 500, color: on ? "var(--txb)" : "var(--txh)" }}>
          {s.title || "untitled session"}
        </span>
        {dev ? (
          // Who asked, in the run's blue, then the repo and its PR: short of
          // room the repo's name gives way first, and the PR never does.
          <div style={{ display: "flex", alignItems: "center", gap: 7, minWidth: 0, fontSize: "var(--t95)", lineHeight: 1 }}>
            <span className="sessproj" style={{ flex: "0 0 auto", maxWidth: "60%", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--info)" }}>
              <DeviceTile />{dev.by}
            </span>
            <span style={{ flex: "0 1 auto", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontFamily: "var(--mono)", color: "var(--txl)" }}>
              {dev.repo.split("/").pop()}
            </span>
            {dev.pr != null && <span style={{ flex: "none", marginLeft: -2, fontFamily: "var(--mono)", color: "var(--txl)" }}>#{dev.pr}</span>}
          </div>
        ) : !one && (
          <div style={{ display: "flex", alignItems: "center", gap: 7, minWidth: 0, fontSize: "var(--t95)", lineHeight: 1 }}>
            {projShown && (
              <span className="sessproj" style={{ flex: "0 1 auto", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: tint.color }}>
                <ProjectTile project={s.project} />{projectName(s.project)}
              </span>
            )}
            {branchShown && (
              <span style={{ flex: "0 1 auto", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                             color: inWorktree ? tint.dim : tint.faint }}>
                ⎇ {branch.split("/").pop()}
              </span>
            )}
            {wtShown && (
              <span title={wtTitle} style={{ flex: "0 1 auto", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis",
                                             whiteSpace: "nowrap", color: tint.dim }}>
                ⧉{s.worktree ? ` ${s.worktree}` : ""}
              </span>
            )}
          </div>
        )}
      </div>
      {/* The pin leads: a row's first span is its title to the theme rules
          (`.sessrow > div > span:first-child`), and nothing here is one. */}
      <div style={{ display: "flex", alignItems: "center", gap: 7, height: 18, fontSize: "var(--t10)", fontWeight: 600, lineHeight: 1,
                    color: "var(--txl)", fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap", position: "relative" }}>
        <button
          onClick={(e) => { e.stopPropagation(); onPin(); }}
          title={pinned ? "unpin — stops holding the top of the list" : "pin to the top of the list"}
          className="rowact" data-keep={pinned}
          style={{ appearance: "none", cursor: "pointer", flex: "none", width: 11, border: 0, background: "transparent",
                   padding: 0, fontFamily: "inherit", fontSize: "var(--t10)", lineHeight: 1, textAlign: "center",
                   color: pinned ? "var(--warn)" : "var(--txl)" }}
        >{pinned ? "★" : "☆"}</button>
        {fv && (flag !== "held" || v.lane !== "ask") && <span title={fv.t} style={{ color: fv.c }}>{fv.l}</span>}
        {s.goal && (
          // Active goals pulse; a blocked one is the row that wants you.
          <span
            title={`goal (${s.goal.state}): ${s.goal.objective}`}
            style={{ fontSize: "var(--t9)",
                     color: s.goal.state === "blocked" ? "var(--warn)"
                          : s.goal.state === "active" ? "var(--acc)" : "var(--txf)",
                     animation: s.goal.state === "active" ? "mpulse 2.4s infinite" : "none" }}
          >◎</span>
        )}
        {JobIcon && <span title={jobLabel(s.job).toLowerCase()} style={{ display: "inline-flex", color: "var(--purple)" }}><JobIcon size={12} strokeWidth={2.1} aria-hidden /></span>}
        {team && <Avatar id={team.from.id || team.from.name} name={team.from.name} size={16} />}
        {shotTag}
        {age ? (
          <span style={{ color: age.tone === "run" ? "var(--info)" : pulse ? "var(--ok)" : "var(--txl)" }}>
            {age.tone === "ok" || age.tone === "bad"
              // ✓ / ✕ in their own colour, the age after it quiet like every row's
              ? <><span style={{ color: age.tone === "ok" ? "var(--ok)" : "var(--err)" }}>{age.text.slice(0, 1)}</span>{age.text.slice(1)}</>
              : age.text}
          </span>
        ) : edge}
      </div>
    </div>
  );
}

/** The open Rivendell jobs group's kind filter: ALL plus one chip per kind it
 *  holds, most first, each with its count. */
function KindFilter({ rows, kind, onKind }: { rows: SessionBrief[]; kind: string; onKind: (k: string) => void }) {
  const counts = new Map<string, number>();
  for (const s of rows) counts.set(s.job?.kind ?? "", (counts.get(s.job?.kind ?? "") ?? 0) + 1);
  const kinds = [...counts].filter(([k]) => k).sort((a, b) => b[1] - a[1]);
  if (kinds.length < 2) return null;              // one kind: nothing to filter
  const chip = (k: string, label: string, n: number, Icon?: LucideIcon) => {
    const on = kind === k;
    return (
      <button key={k || "all"} onClick={() => onKind(on && k ? "" : k)} aria-pressed={on}
        style={{ display: "inline-flex", alignItems: "center", gap: 5, height: 22, padding: "0 7px", borderRadius: 6, cursor: "pointer",
                 border: `1px solid ${on ? "color-mix(in srgb, var(--purple) 55%, transparent)" : "color-mix(in srgb, var(--acc) 12%, transparent)"}`,
                 background: on ? "color-mix(in srgb, var(--purple) 12%, transparent)" : "transparent",
                 color: on ? "var(--purple)" : "var(--txm)", fontFamily: "inherit", fontSize: "var(--t85)", letterSpacing: ".06em" }}>
        {Icon && <Icon size={10} strokeWidth={2.2} aria-hidden />}{label}
        <span style={{ color: on ? "color-mix(in srgb, var(--purple) 70%, var(--txl))" : "var(--txl)" }}>{n}</span>
      </button>
    );
  };
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 5, margin: "2px 4px 6px 6px" }}>
      {chip("", "ALL", rows.length)}
      {kinds.map(([k, n]) => chip(k, jobLabel({ kind: k as keyof typeof JOB_LABEL }), n, JOB_ICON[k as keyof typeof JOB_ICON]))}
    </div>
  );
}

/** A day's label between job rows: the open jobs group's and PLUGINS'. */
function DayCut({ label }: { label: string }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, height: 22, margin: "6px 0 0", padding: "0 8px",
                  fontSize: "var(--t85)", letterSpacing: ".14em", color: "var(--txl)" }}>
      {label}<span style={{ flex: 1, height: 1, background: "color-mix(in srgb, var(--acc) 7%, transparent)" }} />
    </div>
  );
}

/** A project head's tally: one dot and count per lane that has any, in the
 *  order they want you — a question first, then what's new, then what's busy. */
const TALLY: { k: LaneKey; c: string; fill: boolean; t: string }[] = [
  { k: "ask", c: "var(--warn)", fill: true, t: "need you" },
  { k: "done", c: "var(--acc)", fill: false, t: "finished, not opened" },
  { k: "wait", c: "var(--purple)", fill: true, t: "waiting" },
  { k: "parked", c: "var(--info)", fill: true, t: "parked" },
  { k: "work", c: "var(--ok)", fill: true, t: "working" },
];
function Tally({ n }: { n: Partial<Record<LaneKey, number>> }) {
  const on = TALLY.filter((x) => n[x.k]);
  if (!on.length) return null;
  return (
    <span title={on.map((x) => `${n[x.k]} ${x.t}`).join(" · ")}
          style={{ flex: "none", display: "flex", alignItems: "center", gap: 10, marginRight: 4, fontSize: "var(--t10)",
                   fontWeight: 700, lineHeight: 1, color: "var(--txd)", fontVariantNumeric: "tabular-nums" }}>
      {on.map((x) => (
        <span key={x.k} style={{ display: "inline-flex", alignItems: "center", gap: 4, color: x.k === "ask" ? "var(--warn)" : undefined }}>
          <span style={{ width: 6, height: 6, borderRadius: "50%", boxSizing: "border-box",
                         background: x.fill ? x.c : "transparent", border: x.fill ? 0 : `1.5px solid ${x.c}` }} />
          {n[x.k]}
        </span>
      ))}
    </span>
  );
}

/** One virtualised entry in a lane list: a lane header, a session row, the
 *  idle lane's fold toggle, or a PLUGINS day label. */
type LaneItem =
  | { k: "head"; label: string; sub?: string; tint: string; count?: number; pulse: boolean; first: boolean }
  | { k: "row"; s: SessionBrief }
  | { k: "fold"; label: string }
  | { k: "day"; label: string };

export function SessionsPanel(props: Props) {
  const {
    sessions, groups, hidden, status, done, flags, pins, selectedSessionId, activeProject, booting,
    onTogglePin, onSelectSession, onNewSession, onWorktreeSession, onCreateProject, folded: asRail, onUnfold,
  } = props;

  // New-session form.
  const [nsOpen, setNsOpen] = useState(false);
  const [nsProject, setNsProject] = useState<string | null>(null);
  const [branches, setBranches] = useState<string[]>([]);
  const [current, setCurrent] = useState("");
  const [nsBranch, setNsBranch] = useState("");
  const [nsNewOpen, setNsNewOpen] = useState(false);
  const [nsNewBranch, setNsNewBranch] = useState("");
  const [nsParent, setNsParent] = useState("");
  const [nsScoped, setNsScoped] = useState(false); // opened from a project header — project is fixed
  const [projQ, setProjQ] = useState("");
  // New-project form — the PROJECTS mode's counterpart to NEW SESSION.
  const [npOpen, setNpOpen] = useState(false);
  const [npName, setNpName] = useState("");
  const [npPrompt, setNpPrompt] = useState("");
  const [projAll, setProjAll] = useState(false);
  const [branchQ, setBranchQ] = useState("");
  const [branchAll, setBranchAll] = useState(false);
  // Branches already checked out — the project checkout and every linked worktree.
  const [held, setHeld] = useState<Set<string>>(new Set());
  const [parentMenu, setParentMenu] = useState(false);

  // Browser state — mode + project order remembered across reloads.
  const plugins = useIntegrations();
  const [picked, setPicked] = useState<Mode>(() => loadPrefs().mode);
  // A saved PLUGINS pick renders as ATTENTION while Rivendell isn't installed,
  // and stays saved: installing it again puts you back on the tab you chose.
  const mode: Mode = picked === "plugins" && !plugins.rivendell ? "attention" : picked;
  const [order, setOrder] = useState<OrderMode>(() => loadPrefs().order);
  const [customOrder, setCustomOrder] = useState<string[]>(() => loadPrefs().custom);
  const [orderMenu, setOrderMenu] = useState(false);
  // Native HTML5 drag state for CUSTOM order.
  const [dragRel, setDragRel] = useState<string | null>(null);
  const [overRel, setOverRel] = useState<string | null>(null);
  // How much provenance each row prints. Remembered, because it tracks the
  // machine you work on — one repo on one branch wants less than fifteen.
  // ponytail: new key per shape change, no migration — useStickyObj merges one
  // level deep, so a stored preset string would survive as a Detail that has no
  // fields and silently print nothing. Three ticks are cheaper to re-pick.
  const [detailPrefs, setDetailPrefs] = useStickyObj<Record<Mode, Detail>>("hud-sessions-fields", DETAIL_DEFAULT);
  const detail = { ...DETAIL_DEFAULT[mode], ...detailPrefs[mode] };
  const toggleField = (k: keyof Detail) =>
    setDetailPrefs((p) => ({ ...p, [mode]: { ...detail, [k]: !detail[k] } }));
  const shownFields = fieldsFor(mode).filter((f) => detail[f.k]).map((f) => f.label).join(" + ");
  const [detailMenu, setDetailMenu] = useState(false);
  // ATTENTION's idle lane is the long tail — folded to four rows until asked.
  const [folded, setFolded] = useState(true);
  // Projects you collapsed with the header — remembered, because the projects
  // you keep out of the way are the same ones every day.
  const [shut, setShut] = useState<Set<string>>(() => new Set(loadPrefs().shut));
  // Projects expanded past their default rows. ponytail: not persisted — an
  // expand is "show me this now", not a preference.
  const [open, setOpen] = useState<Set<string>>(new Set());
  // Which kind the open Rivendell jobs group shows ("" = every kind).
  const [jobKind, setJobKind] = useState("");
  // A mode switch replaces every row, so the list cascades in once. Rows mount
  // on scroll too, and those must not — hence a flag, not an always-on entrance.
  const [fresh, setFresh] = useState(true);
  const [sessionQ, setSessionQ] = useState("");
  // One hover key for every small control — the rows manage their own.
  const [hov, setHov] = useState("");
  const [chipHov, setChipHov] = useState("");
  const [closeHov, setCloseHov] = useState(false);
  // Folded: the project whose rows hang beside its tile, and where its tile sits.
  const [fly, setFly] = useState<{ rel: string; top: number } | null>(null);
  const flyT = useRef<number | undefined>(undefined);
  const railRef = useRef<HTMLDivElement>(null);
  const [startHov, setStartHov] = useState(false);
  const [cancelHov, setCancelHov] = useState(false);

  useEffect(() => {
    setFresh(true);
    const t = setTimeout(() => setFresh(false), 900);
    return () => clearTimeout(t);
  }, [mode]);

  useEffect(() => {
    try { localStorage.setItem(PREFS_KEY, JSON.stringify({ mode: picked, order, custom: customOrder, shut: [...shut] })); }
    catch { /* ignore */ }
  }, [picked, order, customOrder, shut]);

  // "/" jumps to the search box — the hint badge in it promises this. Folded,
  // there is no box until the panel unfolds, so it unfolds first.
  const searchRef = useRef<HTMLInputElement>(null);
  const unfoldRef = useRef(onUnfold);
  unfoldRef.current = onUnfold;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey) return;
      if (t?.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(t?.tagName ?? "")) return;
      e.preventDefault();
      if (!searchRef.current) unfoldRef.current?.();
      requestAnimationFrame(() => searchRef.current?.focus());
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // A search left in the box would filter the rail with nothing on screen to
  // say so; a flyout outlives nothing that folds or unfolds.
  useEffect(() => { setFly(null); if (asRail) setSessionQ(""); }, [asRail]);
  useEffect(() => {
    if (!fly) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setFly(null); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [fly]);
  // Each session's pictures from the last day, counted against what you have
  // had on screen: the WORK plate's own rule, so the tag and the plate agree.
  // A bridge older than GET /local/shots answers 404, and no tag shows.
  const [pics, setPics] = useState<Record<string, [string, number][]>>({});
  useEffect(() => {
    let live = true;
    const load = () => api.shots(Date.now() / 1000 - 86400).then((r) => { if (live) setPics(r); }, () => {});
    void load();
    const t = setInterval(load, 15000);
    return () => { live = false; clearInterval(t); };
  }, []);
  useSeenShots(); // a picture marked seen re-counts its tag
  const unseen = new Map(Object.entries(pics).map(([id, ps]) => [id, ps.filter(([p, at]) => shotUnseen(p, at)).length]));

  // Branches power the WORKTREE chips + parent cycle — load per selected project
  // while the form is open (same endpoint the old inline picker used).
  useEffect(() => {
    if (!nsOpen || !nsProject) return;
    let live = true;
    // Which branches are checked out rides along with the list, so the chips
    // order once instead of reshuffling when a second answer lands. It only
    // ranks and marks them: if it fails, the list still loads in git's order.
    void Promise.all([
      api.branches(nsProject),
      api.worktrees(nsProject).then((w) => w.worktrees.map((x) => x.branch), () => [] as string[]),
    ]).then(([b, wt]) => {
      if (!live) return;
      const cur = b.current || b.branches[0] || "main";
      // Default to the branch of the session you're in when it's this project —
      // new work continues where you are, not wherever the main checkout sits.
      const mine = sessions.find((s) => s.id === selectedSessionId);
      const pick = mine?.project === nsProject && mine.branch && b.branches.includes(mine.branch)
        ? mine.branch : cur;
      setBranches(b.branches);
      setHeld(new Set(wt));
      setCurrent(cur);
      setNsBranch(pick);
      setNsParent(pick);
    }).catch(() => {});
    return () => { live = false; };
  }, [nsOpen, nsProject]);

  const branchOf = new Map(groups.map((g) => [g.rel, g.badge?.branch]));
  // One resolution of "which branch is this session on", so the row label and
  // the search box can never disagree about it.
  const branchFor = (s: SessionBrief) => s.branch || branchOf.get(s.project) || "main";

  const sq = sessionQ.trim().toLowerCase();
  // Pinned first, then newest-started first: a row holds its place while its
  // turns start and end, and the dot says what changed. Every list below slices
  // this one, so a pin holds the top of its lane, its bucket, and its project's
  // rows alike — and the search applied here reaches every mode from one place.
  const sorted = [...sessions]
    .filter((s) => !sq || `${s.title ?? ""} ${branchFor(s)}`.toLowerCase().includes(sq))
    .sort((a, b) => Number(pins.has(b.id)) - Number(pins.has(a.id)) || byCreated(a, b));

  // One state resolution per session per render — lanes, dots and counts all
  // read this map so they can never disagree.
  const views = new Map(sorted.map((s) => [s.id, resolve(status.get(s.id), done.has(s.id), flags.get(s.id))]));
  const laneOf = (s: SessionBrief) => views.get(s.id)?.lane ?? "idle";
  // What HIDE leaves in the sidebar: a session whose folder and group (Rivendell
  // jobs, Shared) are both shown.
  const listed = (s: SessionBrief) => !hidden[s.project] && !hidden[jobGroup(s)];
  // A teammate's device run or share is never yours to attend to, and what you
  // hid is out of your way: both live in PLUGINS only, out of every other tab
  // and the ATTENTION count.
  const mine = sorted.filter((s) => !readOnly(s.origin) && listed(s));

  // ATTENTION: the four lanes. Idle is the long tail, so it folds to four rows
  // and nothing else is capped. Searching drops the fold — a search is already
  // the filter.
  type Lane = { label: string; sub?: string; tint: string; count?: number; pulse: boolean; rows: SessionBrief[]; fold: string };
  let lanes: Lane[] = [];
  if (mode === "attention") {
    lanes = LANES.flatMap((d) => {
      const all = mine.filter((s) => laneOf(s) === d.k);
      if (!all.length) return [];
      const folds = d.k === "idle" && !sq && all.length > 4;
      return [{
        // IDLE is every session at rest, so its header carries no number.
        label: d.label, tint: d.tint, count: d.k === "idle" ? undefined : all.length, pulse: d.k === "work",
        rows: folds && folded ? all.slice(0, 4) : all,
        fold: folds ? (folded ? `${all.length - 4} more idle ↓` : "show less ↑") : "",
      }];
    });
  } else if (mode === "plugins") {
    // PLUGINS: one lane per worker. An empty lane stays — "RIVENDELL 0" is the
    // "configured, nothing yet" answer this tab exists to give.
    lanes = PLUGINS.map(({ label, sub, tint, match }) => {
      const rows = sorted.filter(match).sort(byCreated);
      return {
        label, sub, tint, count: rows.length,
        pulse: rows.some((s) => laneOf(s) === "work"), rows, fold: "",
      };
    });
  } else if (mode === "recent") {
    // RECENT is one flat stream, cut into time buckets — no project grouping.
    // The one tab that follows the last touch: recency is its point.
    const now = Date.now() / 1000;
    const cuts: [number, string][] = [[86400, "TODAY"], [7 * 86400, "THIS WEEK"], [Infinity, "EARLIER"]];
    lanes = cuts.flatMap(([max, label], i) => {
      const min = i === 0 ? -1 : cuts[i - 1][0];
      const age = (s: SessionBrief) => now - s.updated;
      const rows = mine.filter((s) => age(s) > min && age(s) <= max)
        .sort((a, b) => Number(pins.has(b.id)) - Number(pins.has(a.id)) || b.updated - a.updated);
      return rows.length ? [{ label, tint: "var(--txd)", count: rows.length, pulse: false, rows, fold: "" }] : [];
    });
  }

  // The lane modes flatten to one virtualised list — ATTENTION and RECENT both
  // carry the full session list, which is the one list long enough to be worth
  // the code. PROJECTS shows two rows per project and renders plain.
  const laneItems: LaneItem[] = [];
  if (mode !== "projects") {
    lanes.forEach((l, i) => {
      laneItems.push({ k: "head", label: l.label, sub: l.sub, tint: l.tint, count: l.count, pulse: l.pulse, first: i === 0 });
      let day = "";
      for (const s of l.rows) {
        // PLUGINS reads as a log, like the opened jobs group: each day gets a label.
        const d = mode === "plugins" ? dayLabel(s.created ?? s.updated) : "";
        if (d && d !== day) laneItems.push({ k: "day", label: d });
        day = d;
        laneItems.push({ k: "row", s });
      }
      if (l.fold) laneItems.push({ k: "fold", label: l.fold });
    });
  }

  // PROJECTS: the tree. By default a project ranks by its newest session's
  // start, so it rises when you start one there, never because a turn ran.
  const started = new Map<string, number>();
  for (const s of sessions) {
    const g = jobGroup(s), t = s.created ?? s.updated;
    if (t > (started.get(g) ?? 0)) started.set(g, t);
  }
  const byStart = [...groups].sort((a, b) => (started.get(b.rel) ?? 0) - (started.get(a.rel) ?? 0));
  // CUSTOM: dragged positions first (sort is stable, so anything you never
  // dragged keeps its start order behind them).
  const rank = (rel: string) => { const i = customOrder.indexOf(rel); return i < 0 ? Infinity : i; };
  const ps =
    order === "alpha" ? [...groups].sort((a, b) => a.name.localeCompare(b.name))
      : order === "biggest" ? [...groups].sort((a, b) => b.sessionCount - a.sessionCount)
        : order === "custom" ? [...byStart].sort((a, b) => rank(a.rel) - rank(b.rel))
          : byStart;
  // A capped project lists every session that is doing something (WORK/WAIT/
  // ASK/DONE), holding a prompt of yours, pinned, open right now, or holding
  // pictures you haven't opened (a folded row's tag is no tag) — hiding the
  // chat you are looking at reads as "it's gone". Only a project with none of
  // those falls back to its newest rows.
  // Expanding is a drill-down, not a longer list: while one project is open the
  // others step aside, and "← All projects" is the way back.
  const drilled = !sq && open.size > 0;
  // Shared lists what teammates sent, which `mine` keeps out of every other group.
  const rowsOf = (g: ProjectGroup) => (g.rel === SHARED_REL ? sorted.filter(listed) : mine).filter((s) => jobGroup(s) === g.rel);
  // Newest rows *plus* anything live — a union, not a replacement: selecting
  // an idle row made it "live" and shoved its sibling out of the list.
  const capped = (f: SessionBrief[]) => {
    const keep = new Set(f.slice(0, 2).map((s) => s.id));
    return f.filter((s) => keep.has(s.id) || s.id === selectedSessionId || pins.has(s.id) || laneOf(s) !== "idle" || flags.has(s.id) || !!unseen.get(s.id));
  };
  // A head's tally: how many of its sessions sit in each lane. It counts every
  // session, not the rows showing, so a shut project still says what's inside.
  const tallyOf = (f: SessionBrief[]) => {
    const n: Partial<Record<LaneKey, number>> = {};
    for (const s of f) { const k = laneOf(s); n[k] = (n[k] ?? 0) + 1; }
    return n;
  };
  const tree = mode !== "projects" ? [] : ps.flatMap((g) => {
    if (drilled && !open.has(g.rel)) return [];
    const f = rowsOf(g);
    if (sq && f.length === 0) return [];
    // Nothing to show is nothing to expand — an empty project is collapsed,
    // whatever the header was last clicked to.
    const isShut = !f.length || (shut.has(g.rel) && !sq);
    const vis = isShut ? [] : sq || open.has(g.rel)
      // Opened, the jobs group reads as a log: newest job first, one kind at a time.
      ? (g.rel === JOBS_REL ? f.filter((s) => !jobKind || (s.job?.kind ?? "") === jobKind).sort(byCreated) : f)
      : capped(f);
    const rest = Math.max(0, g.sessionCount - vis.length);
    return [{ g, f, isShut, vis, rest, n: tallyOf(f) }];
  });

  // A WAITING row's hourglass turns amber when the session it waits on waits on you.
  const waitOf = (s: SessionBrief): WaitLine | undefined => {
    const on = status.get(s.id)?.state === "waiting" ? status.get(s.id)?.on : undefined;
    if (!on) return undefined;
    const t = views.get(on) ?? resolve(status.get(on), done.has(on), flags.get(on));
    return { needs: t.lane === "ask" };
  };

  const rowFor = (s: SessionBrief, showDot: boolean, showProj: boolean, i?: number) => (
    <SessionRow
      key={s.id} s={s} i={i} showDot={showDot} showProj={showProj} detail={detail}
      on={s.id === selectedSessionId}
      v={views.get(s.id) ?? SV.idle} st={status.get(s.id)} flag={flags.get(s.id)} wait={waitOf(s)} shots={unseen.get(s.id) ?? 0}
      pulse={(status.get(s.id)?.state ?? "idle") === "working"}
      branch={branchFor(s)} home={branchOf.get(s.project)}
      pinned={pins.has(s.id)} onPin={() => onTogglePin(s.id)}
      onAttach={() => onSelectSession(s)}
    />
  );

  // Virtualize the lane list against the shared .mscroll scroller.
  const scrollRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [scrollMargin, setScrollMargin] = useState(0);
  const rowV = useVirtualizer<HTMLDivElement, HTMLDivElement>({
    count: laneItems.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (i) => {
      const it = laneItems[i];
      return it.k === "head" ? (it.first ? 24 : 40) : it.k === "fold" ? 30 : it.k === "day" ? 28 : 50;
    },
    overscan: 8,
    scrollMargin,
  });
  // The new-session form sits above the list inside the scroller, so the list's
  // start offset shifts when it opens/closes — re-measure and feed it back.
  useLayoutEffect(() => {
    const sc = scrollRef.current, li = listRef.current;
    if (!sc || !li) return;
    const m = li.getBoundingClientRect().top - sc.getBoundingClientRect().top + sc.scrollTop;
    setScrollMargin((prev) => (Math.abs(prev - m) > 0.5 ? m : prev));
  });

  function resetForm() {
    setBranches([]); setCurrent(""); setNsBranch(""); setNsParent("");
    setNsNewOpen(false); setNsNewBranch(""); setBranchQ(""); setBranchAll(false);
  }

  function toggleForm() {
    if (nsOpen && !nsScoped) { setNsOpen(false); return; }
    setNsProject((p) => p ?? activeProject ?? groups[0]?.rel ?? null);
    resetForm(); setNsScoped(false); setProjQ(""); setProjAll(false); setNsOpen(true);
  }

  /** New session for one project — same form, project locked to it, opened
   *  inline under that project's header. */
  function openFor(rel: string) {
    if (nsOpen && nsScoped && nsProject === rel) { setNsOpen(false); return; }
    setNsProject(rel); setNsScoped(true); setNsOpen(true); resetForm();
  }

  /** Drop `dragRel` into `target`'s slot, materialising the visible order as the
   *  custom one on first drag. */
  function dropOn(target: string) {
    if (dragRel && dragRel !== target) {
      const next = tree.map(({ g }) => g.rel).filter((r) => r !== dragRel);
      const at = next.indexOf(target);
      next.splice(at < 0 ? next.length : at, 0, dragRel);
      setCustomOrder(next);
    }
    setDragRel(null); setOverRel(null);
  }

  function start() {
    if (!nsProject) return;
    const nb = nsNewOpen ? nsNewBranch.trim().replace(/\s+/g, "-") : "";
    // Same routing as the old per-project picker: new branch → create worktree,
    // other existing branch → attach worktree, current branch → plain session.
    if (nb) onWorktreeSession(nsProject, nb, true, nsParent || undefined);
    else if (nsBranch && current && nsBranch !== current) onWorktreeSession(nsProject, nsBranch, false);
    else onNewSession(nsProject);
    setNsOpen(false); setNsNewOpen(false); setNsNewBranch("");
  }

  // FROM is a text box over the branch list, so a typo has to be caught here
  // rather than by git failing a minute later. An exact match lists everything —
  // otherwise reopening the menu after a pick would show that one branch.
  const parentOk = !nsParent || branches.includes(nsParent);
  const parentHits = parentOk ? branches : branches.filter((b) => b.toLowerCase().includes(nsParent.toLowerCase()));

  // Form pickers: searchable, and long lists stay collapsed until asked for.
  const q = projQ.trim().toLowerCase();
  // Selected project first, so it never hides behind SHOW ALL (sort is stable —
  // everything else keeps its order).
  const projList = (q ? groups.filter((g) => `${g.name} ${g.rel}`.toLowerCase().includes(q)) : groups)
    .slice().sort((a, b) => Number(b.rel === nsProject) - Number(a.rel === nsProject));
  const projShown = projAll ? projList : projList.slice(0, PROJ_CAP);
  const projHidden = projList.length - projShown.length;
  const bq = branchQ.trim().toLowerCase();
  // Same collapse as the projects, at a larger scale: a repo keeps hundreds of
  // branches and has a handful checked out, so those are the ones worth a chip.
  const branchList = orderBranches(bq ? branches.filter((b) => b.toLowerCase().includes(bq)) : branches, nsBranch, held);
  const branchOpen = branchAll && branchList.length > BRANCH_CAP;
  const branchesShown = branchOpen ? branchList : branchList.slice(0, BRANCH_CAP);
  const branchesHidden = branchList.length - branchesShown.length;
  const branchChips = branchesShown.map((b) => {
    const on = !nsNewOpen && b === nsBranch;
    const h = chipHov === `b:${b}`;
    // ⧉ is the mark session rows already use for "runs in a linked worktree".
    const linked = held.has(b) && b !== current;
    // A pick folds the opened list: it sorts first, so staying scrolled where
    // you clicked would leave the chip you just chose out of view.
    return (
      <button
        key={b} onClick={() => { setNsBranch(b); setNsNewOpen(false); setBranchAll(false); }}
        onMouseEnter={() => setChipHov(`b:${b}`)} onMouseLeave={() => setChipHov("")}
        title={`${b} · ${linked ? "has a worktree" : b === current ? "the project checkout" : "no worktree yet — starting here makes one"}`}
        style={{
          appearance: "none", cursor: "pointer", display: "flex", alignItems: "center", gap: 5,
          border: `1px solid ${on || h ? "var(--purple)" : "color-mix(in srgb, var(--purple) 30%, transparent)"}`,
          background: on ? "color-mix(in srgb, var(--purple) 16%, transparent)" : "color-mix(in srgb, var(--purple) 6%, transparent)",
          color: on ? "var(--purple-b)" : "var(--purple-h)",
          fontFamily: "'JetBrains Mono',monospace", fontSize: "var(--t95)", padding: "5px 8px", maxWidth: "100%", minWidth: 0,
        }}
      >
        <span style={{ color: "var(--purple)", flex: "none" }}>{linked ? "⧉" : "⎇"}</span>
        <span style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{b}</span>
      </button>
    );
  });

  // The form renders under whatever opened it: the NEW SESSION button (pinned
  // above the scroller) or a project header's + NEW.
  const nsForm = (
    <div style={{ border: "1px solid color-mix(in srgb, var(--purple) 30%, transparent)", background: "linear-gradient(160deg,color-mix(in srgb, var(--purple) 7%, transparent),color-mix(in srgb, var(--panel) 40%, transparent))", padding: 12, marginBottom: 11, animation: "mslide .22s ease both" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 11 }}>
        <span style={{ width: 7, height: 7, borderRadius: "50%", background: "var(--purple)", flex: "none" }} />
        <span style={{ fontSize: "var(--t9)", letterSpacing: 1.5, color: "var(--purple-h)" }}>NEW SESSION</span>
        {nsScoped && (
          <span style={{ fontSize: "var(--t95)", color: "var(--txm)", minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
            · {groups.find((g) => g.rel === nsProject)?.name ?? nsProject}
          </span>
        )}
        <span style={{ flex: 1 }} />
        <button
          onClick={() => setNsOpen(false)} title="close"
          onMouseEnter={() => setCloseHov(true)} onMouseLeave={() => setCloseHov(false)}
          aria-label="close"
          style={{ appearance: "none", cursor: "pointer", flex: "none", width: 24, height: 24, padding: 0, borderRadius: 7,
                   display: "grid", placeItems: "center", border: 0,
                   background: closeHov ? "color-mix(in srgb, var(--purple) 14%, transparent)" : "transparent",
                   color: closeHov ? "var(--purple-b)" : "var(--purple-g)", transition: "background .15s ease, color .15s ease" }}
        >
          <svg width="10" height="10" viewBox="0 0 12 12" aria-hidden="true">
            <path d="M2 2l8 8M10 2l-8 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          </svg>
        </button>
      </div>
      {!nsScoped && (<>
      <div style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 6 }}>
        <span style={{ fontSize: "var(--t8)", letterSpacing: 1.5, color: "var(--txl)", flex: "none" }}>PROJECT</span>
        <input
          value={projQ} onChange={(e) => setProjQ(e.target.value)} placeholder="search projects…"
          style={{ flex: 1, minWidth: 0, background: "color-mix(in srgb, var(--panel2) 60%, transparent)", border: "1px solid color-mix(in srgb, var(--acc) 16%, transparent)", outline: "none", color: "var(--txb)", fontFamily: "'JetBrains Mono',monospace", fontSize: "var(--t95)", padding: "4px 7px" }}
        />
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
        {projShown.map((g) => {
          const on = g.rel === nsProject;
          const h = chipHov === `p:${g.rel}`;
          const tint = projectTint(g.rel);
          return (
            <button
              key={g.rel} onClick={() => setNsProject(g.rel)}
              onMouseEnter={() => setChipHov(`p:${g.rel}`)} onMouseLeave={() => setChipHov("")}
              style={{
                appearance: "none", cursor: "pointer", display: "flex", alignItems: "center", gap: 5,
                border: `1px solid ${on || h ? "var(--acc)" : "color-mix(in srgb, var(--acc) 18%, transparent)"}`,
                background: on ? "color-mix(in srgb, var(--acc) 10%, transparent)" : "color-mix(in srgb, var(--panel2) 40%, transparent)",
                color: on ? "var(--txb)" : "var(--txm)",
                fontFamily: "'JetBrains Mono',monospace", fontSize: "var(--t95)", padding: "4px 8px", minWidth: 0, maxWidth: "100%",
              }}
            >
              <span style={{ width: 6, height: 6, borderRadius: "50%", background: tint.color, flex: "none" }} />
              <span style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{g.name}</span>
            </button>
          );
        })}
        {projHidden > 0 && (
          <button
            onClick={() => setProjAll(true)}
            style={{ appearance: "none", cursor: "pointer", border: "1px dashed color-mix(in srgb, var(--acc) 25%, transparent)", background: "transparent", color: "var(--txd)", fontFamily: "inherit", fontSize: "var(--t9)", letterSpacing: 0.5, padding: "4px 8px" }}
          >SHOW ALL · {projHidden} MORE</button>
        )}
        {projAll && projList.length > PROJ_CAP && (
          <button
            onClick={() => setProjAll(false)}
            style={{ appearance: "none", cursor: "pointer", border: "1px dashed color-mix(in srgb, var(--acc) 25%, transparent)", background: "transparent", color: "var(--txd)", fontFamily: "inherit", fontSize: "var(--t9)", letterSpacing: 0.5, padding: "4px 8px" }}
          >COLLAPSE</button>
        )}
        {projList.length === 0 && (
          <span style={{ fontSize: "var(--t95)", color: "var(--txl)", padding: "4px 2px" }}>no project matches “{projQ}”</span>
        )}
      </div>
      </>)}
      <div style={{ display: "flex", alignItems: "center", gap: 7, margin: "12px 0 6px" }}>
        <span style={{ fontSize: "var(--t8)", letterSpacing: 1.5, color: "var(--txl)", flex: "none" }}>WORKTREE</span>
        {branches.length > 5 && (
          <input
            value={branchQ} onChange={(e) => setBranchQ(e.target.value)} placeholder={`search ${branches.length} branches…`}
            style={{ flex: 1, minWidth: 0, background: "color-mix(in srgb, var(--panel2) 60%, transparent)", border: "1px solid color-mix(in srgb, var(--purple) 25%, transparent)", outline: "none", color: "var(--txb)", fontFamily: "'JetBrains Mono',monospace", fontSize: "var(--t95)", padding: "4px 7px" }}
          />
        )}
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
        {/* Opened, the chips scroll inside a fixed box: SHOW ALL on a repo with
            hundreds of branches must not push START SESSION out of reach again.
            Eight and a half rows at any font scale (a chip is 1.5 lines of
            --t95 plus 12px, rows 5px apart) — the cut row is what says there
            is more. Keyed on the query so a new search starts at its first match. */}
        {branchOpen
          ? <div key={bq} style={{ flex: "1 0 100%", display: "flex", flexWrap: "wrap", gap: 5, maxHeight: "calc(var(--t95) * 12.75 + 142px)", overflowY: "auto", overscrollBehavior: "contain" }}>{branchChips}</div>
          : branchChips}
        {bq && branchList.length === 0 && (
          <span style={{ fontSize: "var(--t95)", color: "var(--txd)", padding: "4px 2px" }}>no branch matches “{branchQ}”</span>
        )}
        {branchesHidden > 0 && (
          <button
            onClick={() => setBranchAll(true)}
            style={{ appearance: "none", cursor: "pointer", border: "1px dashed color-mix(in srgb, var(--purple) 30%, transparent)", background: "transparent", color: "var(--purple-d)", fontFamily: "inherit", fontSize: "var(--t9)", letterSpacing: 0.5, padding: "4px 8px" }}
          >SHOW ALL · {branchesHidden} MORE</button>
        )}
        {branchOpen && (
          <button
            onClick={() => setBranchAll(false)}
            style={{ appearance: "none", cursor: "pointer", border: "1px dashed color-mix(in srgb, var(--purple) 30%, transparent)", background: "transparent", color: "var(--purple-d)", fontFamily: "inherit", fontSize: "var(--t9)", letterSpacing: 0.5, padding: "4px 8px" }}
          >COLLAPSE</button>
        )}
        <button
          onClick={() => setNsNewOpen((o) => !o)} title="create a new worktree branch"
          style={{ appearance: "none", cursor: "pointer", border: `1px solid ${nsNewOpen ? "var(--purple)" : "color-mix(in srgb, var(--purple) 30%, transparent)"}`, background: nsNewOpen ? "color-mix(in srgb, var(--purple) 14%, transparent)" : "transparent", color: "var(--purple-h)", fontFamily: "inherit", fontSize: "var(--t95)", letterSpacing: 0.5, padding: "5px 9px" }}
        >+ NEW WORKTREE</button>
      </div>
      {nsNewOpen && (
        <>
          <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 8 }}>
            <span style={{ fontSize: "var(--t8)", letterSpacing: 1, color: "var(--purple-g)", flex: "none" }}>FROM</span>
            {/* Type to filter, or open the list — same popup shape as the order menu. */}
            <div style={{ position: "relative", display: "flex", alignItems: "center", gap: 4, flex: "0 1 220px", minWidth: 0, border: `1px solid ${parentOk ? "color-mix(in srgb, var(--purple) 30%, transparent)" : "var(--err)"}`, background: "color-mix(in srgb, var(--purple) 6%, transparent)", padding: "3px 7px" }}>
              <span style={{ color: "var(--purple)", flex: "none" }}>⎇</span>
              <input
                value={nsParent} onFocus={() => setParentMenu(true)} onClick={() => setParentMenu(true)}
                onChange={(e) => { setNsParent(e.target.value); setParentMenu(true); }}
                onKeyDown={(e) => {
                  if (e.key === "Escape") { setParentMenu(false); return; }
                  if (e.key === "Enter" && parentHits[0]) { e.preventDefault(); setNsParent(parentHits[0]); setParentMenu(false); }
                }}
                placeholder="main" title="parent branch — type to search"
                style={{ flex: 1, minWidth: 0, border: 0, background: "transparent", outline: "none", color: parentOk ? "var(--purple-h)" : "var(--err)", fontFamily: "'JetBrains Mono',monospace", fontSize: "var(--t9)", padding: 0 }}
              />
              <button
                onMouseDown={(e) => e.preventDefault()} onClick={() => setParentMenu((o) => !o)}
                title={`${branches.length} branches`} aria-expanded={parentMenu}
                style={{ flex: "none", border: 0, background: "transparent", padding: 0, margin: 0, cursor: "pointer", fontFamily: "inherit", fontSize: "var(--t9)", lineHeight: 1, color: "var(--purple-g)" }}
              >▾</button>
              {parentMenu && (
                <>
                  <div onClick={() => setParentMenu(false)} style={{ position: "fixed", inset: 0, zIndex: 96 }} />
                  <div style={{ position: "absolute", top: "calc(100% + 2px)", left: -1, right: -1, zIndex: 97, maxHeight: 190, overflowY: "auto",
                                border: "1px solid color-mix(in srgb, var(--purple) 34%, transparent)", background: "var(--panel)",
                                boxShadow: "0 8px 22px var(--shadow-pop)", padding: 3, animation: "mslide .16s ease both" }}>
                    {parentHits.map((b) => (
                      <button
                        key={b} onClick={() => { setNsParent(b); setParentMenu(false); }}
                        onMouseEnter={() => setChipHov(`par:${b}`)} onMouseLeave={() => setChipHov("")}
                        style={{ width: "100%", appearance: "none", cursor: "pointer", textAlign: "left", border: 0, display: "flex", alignItems: "center", gap: 5,
                                 background: b === nsParent ? "color-mix(in srgb, var(--purple) 16%, transparent)"
                                   : chipHov === `par:${b}` ? "color-mix(in srgb, var(--purple) 8%, transparent)" : "transparent",
                                 color: b === nsParent ? "var(--purple-b)" : "var(--purple-h)", fontFamily: "'JetBrains Mono',monospace", fontSize: "var(--t9)", padding: "5px 7px" }}
                      >
                        <span style={{ color: "var(--purple)", flex: "none" }}>⎇</span>
                        <span style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{b}</span>
                      </button>
                    ))}
                    {parentHits.length === 0 && (
                      <div style={{ fontSize: "var(--t9)", color: "var(--txl)", padding: "5px 7px" }}>no branch matches</div>
                    )}
                  </div>
                </>
              )}
            </div>
            {!parentOk && <span style={{ flex: "none", whiteSpace: "nowrap", fontSize: "var(--t9)", color: "var(--err-g)" }}>no such branch</span>}
          </div>
          <input
            value={nsNewBranch} onChange={(e) => setNsNewBranch(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && nsNewBranch.trim()) start(); }}
            placeholder="new-worktree-branch"
            style={{ width: "100%", boxSizing: "border-box", marginTop: 7, background: "color-mix(in srgb, var(--panel2) 60%, transparent)", border: "1px solid color-mix(in srgb, var(--purple) 35%, transparent)", outline: "none", color: "var(--txb)", fontFamily: "'JetBrains Mono',monospace", fontSize: "var(--t11)", padding: "7px 9px" }}
          />
        </>
      )}
      <div style={{ display: "flex", gap: 7, marginTop: 9 }}>
        <button
          onClick={start} disabled={nsNewOpen && !parentOk}
          title={nsNewOpen && !parentOk ? `FROM: no branch named “${nsParent}”` : undefined}
          onMouseEnter={() => setStartHov(true)} onMouseLeave={() => setStartHov(false)}
          style={{ flex: 1, appearance: "none", cursor: nsNewOpen && !parentOk ? "not-allowed" : "pointer", opacity: nsNewOpen && !parentOk ? 0.45 : 1, border: "1px solid var(--purple)", background: startHov ? "color-mix(in srgb, var(--purple) 26%, transparent)" : "color-mix(in srgb, var(--purple) 16%, transparent)", color: "var(--purple-b)", fontFamily: "inherit", fontSize: "var(--t10)", letterSpacing: 1.5, padding: 9, display: "flex", alignItems: "center", justifyContent: "center", gap: 6 }}
        ><span style={{ color: "var(--purple)" }}>▸</span>START SESSION</button>
        <button
          onClick={() => setNsOpen(false)}
          onMouseEnter={() => setCancelHov(true)} onMouseLeave={() => setCancelHov(false)}
          style={{ appearance: "none", cursor: "pointer", border: "1px solid color-mix(in srgb, var(--acc) 20%, transparent)", background: cancelHov ? "color-mix(in srgb, var(--acc) 6%, transparent)" : "transparent", color: "var(--txd)", fontFamily: "inherit", fontSize: "var(--t10)", letterSpacing: 1.5, padding: "9px 12px" }}
        >CANCEL</button>
      </div>
      {/* Adding a project is rare, so it lives in here rather than taking a row of its own. */}
      {!nsScoped && (
        <button
          onClick={() => { setNsOpen(false); setNpOpen(true); }}
          onMouseEnter={() => setHov("addproj")} onMouseLeave={() => setHov("")}
          style={{ appearance: "none", cursor: "pointer", display: "block", marginTop: 10, padding: 0, border: 0, background: "transparent",
                   fontFamily: "inherit", fontSize: "var(--t95)", color: hov === "addproj" ? "var(--info)" : "var(--txd)" }}
        >or add a new project ›</button>
      )}
    </div>
  );

  // The new-project form: a repo name and the first thing to build in it. Same
  // shape as nsForm, one tint over — a project is not a session.
  const npForm = (
    <div style={{ border: "1px solid color-mix(in srgb, var(--info) 30%, transparent)", background: "linear-gradient(160deg,color-mix(in srgb, var(--info) 7%, transparent),color-mix(in srgb, var(--panel) 40%, transparent))", padding: 12, marginBottom: 11, animation: "mslide .22s ease both" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 11 }}>
        <span style={{ width: 7, height: 7, borderRadius: "50%", background: "var(--info)", flex: "none" }} />
        <span style={{ fontSize: "var(--t9)", letterSpacing: 1.5, color: "var(--info-hi)" }}>NEW PROJECT</span>
        <span style={{ flex: 1 }} />
        <button
          onClick={() => setNpOpen(false)} title="close" aria-label="close"
          onMouseEnter={() => setHov("npclose")} onMouseLeave={() => setHov("")}
          style={{ appearance: "none", cursor: "pointer", flex: "none", width: 24, height: 24, padding: 0, borderRadius: 7,
                   display: "grid", placeItems: "center", border: 0,
                   background: hov === "npclose" ? "color-mix(in srgb, var(--info) 14%, transparent)" : "transparent",
                   color: hov === "npclose" ? "var(--info-b)" : "var(--txd)", transition: "background .15s ease, color .15s ease" }}
        >
          <svg width="10" height="10" viewBox="0 0 12 12" aria-hidden="true">
            <path d="M2 2l8 8M10 2l-8 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          </svg>
        </button>
      </div>
      <input
        value={npName} onChange={(e) => setNpName(e.target.value)} placeholder="project-name"
        style={{ width: "100%", boxSizing: "border-box", background: "color-mix(in srgb, var(--panel2) 60%, transparent)", border: "1px solid color-mix(in srgb, var(--info) 25%, transparent)", outline: "none", color: "var(--txb)", fontFamily: "'JetBrains Mono',monospace", fontSize: "var(--t11)", padding: "6px 9px" }} />
      <textarea
        value={npPrompt} onChange={(e) => setNpPrompt(e.target.value)} placeholder="starting prompt — what should Claude build first?"
        style={{ width: "100%", boxSizing: "border-box", minHeight: 60, resize: "vertical", marginTop: 8, background: "color-mix(in srgb, var(--panel2) 60%, transparent)", border: "1px solid color-mix(in srgb, var(--acc) 18%, transparent)", outline: "none", color: "var(--txb)", fontFamily: "inherit", fontSize: "var(--t12)", lineHeight: 1.5, padding: "8px 9px" }} />
      <div style={{ display: "flex", gap: 7, marginTop: 9 }}>
        <button
          onClick={() => {
            const name = npName.trim(), prompt = npPrompt.trim();
            if (!name || !prompt) return;
            onCreateProject(name, prompt);
            setNpName(""); setNpPrompt(""); setNpOpen(false);
          }}
          disabled={!npName.trim() || !npPrompt.trim()}
          onMouseEnter={() => setHov("npgo")} onMouseLeave={() => setHov("")}
          style={{ flex: 1, appearance: "none", cursor: npName.trim() && npPrompt.trim() ? "pointer" : "not-allowed", opacity: npName.trim() && npPrompt.trim() ? 1 : 0.45, border: "1px solid var(--info)", background: hov === "npgo" ? "color-mix(in srgb, var(--info) 26%, transparent)" : "color-mix(in srgb, var(--info) 16%, transparent)", color: "var(--info-b)", fontFamily: "inherit", fontSize: "var(--t10)", letterSpacing: 1.5, padding: 9, display: "flex", alignItems: "center", justifyContent: "center", gap: 6 }}
        ><span style={{ color: "var(--info)" }}>▸</span>CREATE & START</button>
        <button
          onClick={() => setNpOpen(false)}
          onMouseEnter={() => setHov("npcancel")} onMouseLeave={() => setHov("")}
          style={{ appearance: "none", cursor: "pointer", border: "1px solid color-mix(in srgb, var(--acc) 20%, transparent)", background: hov === "npcancel" ? "color-mix(in srgb, var(--acc) 6%, transparent)" : "transparent", color: "var(--txd)", fontFamily: "inherit", fontSize: "var(--t10)", letterSpacing: 1.5, padding: "9px 12px" }}
        >CANCEL</button>
      </div>
    </div>
  );

  // The PLUGINS tab exists while Rivendell is installed, and `mode` can't be
  // "plugins" otherwise, so the pill never stands on a tab that isn't rendered.
  const pluginRows = sorted.filter((s) => PLUGINS.some((p) => p.match(s)));
  // Tabs are icons only — the label survives as the tooltip and the
  // accessible name, so the bar stays narrow and never wraps.
  const modeTabs: { id: Mode; label: string; Icon: LucideIcon; count: number; tip: string }[] = [
    // ATTENTION counts what wants you — a question, or a finish you haven't
    // opened — not everything that's busy: eight running turns are not eight to-dos.
    { id: "attention", label: "Attention", Icon: BellRing, count: mine.filter((s) => laneOf(s) === "ask" || laneOf(s) === "done").length, tip: "Attention — grouped by what each session wants from you" },
    { id: "projects", label: "Projects", Icon: FolderTree, count: groups.length, tip: "Projects — grouped by project" },
    ...(plugins.rivendell ? [{ id: "plugins" as Mode, label: "Plugins", Icon: Puzzle, count: pluginRows.length, tip: "Plugins — sessions started by configured plugin workers" }] : []),
    { id: "recent", label: "Recent", Icon: History, count: mine.length, tip: "Recent — one flat stream, newest first" },
  ];
  // The PLUGINS icon's blue dot: a teammate's run is going on this device (a
  // search doesn't hide it).
  const deviceLive = sessions.some((s) => isDeviceRun(s.origin) && status.get(s.id)?.state === "working");

  const laneHead = (it: Extract<LaneItem, { k: "head" }>) => (
    <div className="lanehead" style={{ display: "flex", alignItems: "center", gap: 9, height: 24, padding: "0 6px", marginTop: it.first ? 0 : 16 }}>
      <span className="sessdot" data-work={it.pulse}
            style={{ flex: "none", width: 6, height: 6, borderRadius: "50%", background: it.tint }} />
      <span style={{ flex: "none", fontSize: "var(--t9)", letterSpacing: ".22em", color: it.tint }}>{it.label}</span>
      {it.sub && <span style={{ flex: "0 1 auto", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: "var(--t9)", letterSpacing: ".04em", color: "var(--txl)" }}>· {it.sub}</span>}
      <span style={{ flex: 1, minWidth: 8, height: 1, background: "color-mix(in srgb, var(--acc) 7%, transparent)" }} />
      {it.count !== undefined && <span style={{ flex: "none", fontSize: "var(--t9)", color: "var(--txl)" }}>{it.count}</span>}
    </div>
  );


  // FOLDED: the column is a rail of the projects you are working in — any with
  // a session busy or touched this week, and the open one's — each wearing its
  // tally as a badge: a question in amber, else how many are running, and a dot
  // for a finish you haven't opened. A tile opens its rows beside it; anything
  // more unfolds the panel.
  if (asRail) {
    const cur = sessions.find((x) => x.id === selectedSessionId);
    const openRel = cur ? jobGroup(cur) : activeProject;
    const week = Date.now() / 1000 - 7 * 86400;
    const peek = (rel: string, el: HTMLElement, wait = 120) => {
      window.clearTimeout(flyT.current);
      const top = el.getBoundingClientRect().top;
      flyT.current = window.setTimeout(() => setFly({ rel, top }), wait);
    };
    const unpeek = () => {
      window.clearTimeout(flyT.current);
      flyT.current = window.setTimeout(() => setFly(null), 220);
    };
    const tile = (g: ProjectGroup) =>
      g.rel === JOBS_REL ? <JobsTile /> : g.rel === SHARED_REL ? <TeamTile /> : <ProjectTile project={g.rel} />;
    const flyG = fly && ps.find((g) => g.rel === fly.rel);
    const flyRows = flyG ? rowsOf(flyG) : [];
    const flyVis = capped(flyRows);
    const flyRest = flyG ? Math.max(0, flyG.sessionCount - flyVis.length) : 0;
    return (
      <div ref={railRef} className="srail">
        <button className="srail-btn" aria-label="Search sessions" title="Search sessions  /"
                onClick={() => { onUnfold?.(); requestAnimationFrame(() => searchRef.current?.focus()); }}>
          <Search size={16} strokeWidth={2} aria-hidden />
        </button>
        <button className="srail-btn" data-acc aria-label="New session" title="New session"
                onClick={() => { onUnfold?.(); toggleForm(); }}>
          <Plus size={17} strokeWidth={2.2} aria-hidden />
        </button>
        <span className="srail-sep" />
        <div className="srail-tiles">
          {ps.filter((g) => g.rel === openRel || rowsOf(g).some((x) => x.updated > week || laneOf(x) !== "idle")).map((g) => {
            const n = tallyOf(rowsOf(g));
            return (
              <button
                key={g.rel} className="srail-tile" aria-label={g.name}
                data-on={g.rel === openRel} data-hot={fly?.rel === g.rel}
                onMouseEnter={(e) => peek(g.rel, e.currentTarget)} onMouseLeave={unpeek}
                onClick={(e) => (fly?.rel === g.rel ? setFly(null) : peek(g.rel, e.currentTarget, 0))}
              >
                {tile(g)}
                {n.ask ? <span className="srail-bd" data-ask>{n.ask}</span> : n.work ? <span className="srail-bd">{n.work}</span> : null}
                {!!n.done && <span className="srail-new" />}
              </button>
            );
          })}
        </div>
        <span className="srail-sep" />
        <button className="srail-btn" data-bare aria-label="Unfold the sidebar" title="Unfold the sidebar" onClick={onUnfold}>
          <PanelLeftOpen size={17} strokeWidth={1.9} aria-hidden />
        </button>
        {flyG && fly && (
          // A popover like the order menu (--shadow-pop), so each family dresses it as one.
          <div
            className="srail-fly" onMouseEnter={() => window.clearTimeout(flyT.current)} onMouseLeave={unpeek}
            onClick={() => setFly(null)}
            style={{ left: (railRef.current?.getBoundingClientRect().right ?? 72) + 8,
                     top: Math.max(8, Math.min(fly.top - 8, window.innerHeight - 200)),
                     border: "1px solid color-mix(in srgb, var(--acc) 28%, transparent)", background: "var(--panel)",
                     boxShadow: "0 8px 22px var(--shadow-pop)" }}
          >
            <div className="projgrp">
              <div className="projhead" style={{ display: "flex", alignItems: "center", gap: 9, height: 26, padding: "0 6px", cursor: "default" }}>
                <span className="pdot" style={{ flex: "none", width: 6, height: 6, background: projectTint(flyG.rel).color }} />
                {tile(flyG)}
                <span style={{ flex: "0 1 auto", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                               fontSize: "var(--t115)", letterSpacing: ".06em", color: "var(--txm)" }}>{flyG.name}</span>
                <span style={{ flex: 1, minWidth: 6 }} />
                <Tally n={tallyOf(flyRows)} />
              </div>
              <div className="projrail" style={{ margin: "1px 0 0 3px", borderLeft: `1px solid color-mix(in srgb, ${projectTint(flyG.rel).color} 20%, transparent)` }}>
                {flyVis.map((x) => rowFor(x, true, false))}
                {flyRest > 0 && (
                  <button
                    onClick={(e) => {
                      // the rest is a drill-down in PROJECTS: unfold onto it
                      e.stopPropagation(); setFly(null); onUnfold?.(); setPicked("projects");
                      setShut((c) => { const n = new Set(c); n.delete(flyG.rel); return n; });
                      setOpen(new Set([flyG.rel]));
                    }}
                    onMouseEnter={() => setHov("flymore")} onMouseLeave={() => setHov("")}
                    style={{ display: "block", width: "100%", textAlign: "left", padding: "7px 8px", border: 0, background: "transparent",
                             fontFamily: "inherit", fontSize: "var(--t95)", letterSpacing: ".1em", cursor: "pointer",
                             color: hov === "flymore" ? "var(--acc)" : "var(--txl)" }}
                  >{flyRest} more →</button>
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    );
  }
  return (
    <div className="panel" style={{ border: "1px solid color-mix(in srgb, var(--acc) 16%, transparent)", background: "color-mix(in srgb, var(--panel) 86%, transparent)", animation: "enterLeft .55s cubic-bezier(.2,.8,.2,1) both .12s", flex: 1, display: "flex", flexDirection: "column", minHeight: 0 }}>
      <div style={{ flex: "none", display: "flex", flexDirection: "column", padding: "14px 16px 0" }}>
        <div style={{ position: "relative", display: "flex", alignItems: "stretch", gap: 2, padding: 2, borderRadius: 4, background: "color-mix(in srgb, var(--acc) 4%, transparent)" }}>
          {/* One pill travels to the tab you picked. Three backgrounds fading in
              and out reads as a blink; a thing that moves reads as a switch.
              Its own width + the 2px gap is one step, so the maths survives a
              fourth tab. */}
          <span
            aria-hidden
            style={{ position: "absolute", top: 2, bottom: 2, left: 2, width: `calc((100% - ${2 * 2 + (modeTabs.length - 1) * 2}px) / ${modeTabs.length})`,
                     borderRadius: 3, background: "color-mix(in srgb, var(--acc) 10%, transparent)", pointerEvents: "none",
                     transform: `translateX(calc(${modeTabs.findIndex((m) => m.id === mode)} * (100% + 2px)))`,
                     transition: "transform .22s cubic-bezier(.2,.8,.2,1)" }}
          />
          {modeTabs.map((m) => {
            const on = mode === m.id;
            return (
              <button
                key={m.id} onClick={() => setPicked(m.id)} title={m.tip} aria-label={m.label} aria-pressed={on}
                style={{ position: "relative", flex: "1 1 0", minWidth: 0, display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
                         height: 27, border: 0, borderRadius: 3, padding: 0, margin: 0, background: "transparent",
                         cursor: "pointer", fontFamily: "inherit", color: on ? "var(--txb)" : "var(--txf)", transition: "color .15s ease" }}
              >
                <m.Icon size={14} strokeWidth={1.8} aria-hidden style={{ flex: "none" }} />
                {m.id === "plugins" && deviceLive && (
                  <span aria-hidden
                    style={{ position: "absolute", top: 4, left: "calc(50% + 4px)", width: 6, height: 6, borderRadius: "50%", background: "var(--info)",
                             boxShadow: "0 0 0 2px var(--panel2), 0 0 8px var(--info)" }} />
                )}
                {/* Only ATTENTION's count is a number you act on, so it shows
                    only while there is something to act on. */}
                {m.id === "attention" && m.count > 0 && (
                  <span style={{ flex: "none", fontSize: "var(--t9)", fontWeight: 700, color: "var(--warn)" }}>{m.count}</span>
                )}
              </button>
            );
          })}
        </div>
        {/* New stands beside the search, in the same well: one line, where the
            full-width NEW SESSION / ADD PROJECT rows used to take one each.
            It wears .sess-search too, so every family draws it as that well. */}
        <div style={{ display: "flex", alignItems: "flex-start", gap: 6 }}>
          <div className="sess-search" style={{ flex: 1, minWidth: 0, display: "flex", alignItems: "center", gap: 10, height: 38, marginTop: 11, position: "relative",
                        borderBottom: "1px solid color-mix(in srgb, var(--acc) 9%, transparent)" }}>
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" style={{ flex: "none" }} aria-hidden="true">
              <circle cx="5" cy="5" r="3.6" stroke="var(--txl)" strokeWidth="1.3" />
              <line x1="7.8" y1="7.8" x2="11" y2="11" stroke="var(--txl)" strokeWidth="1.3" strokeLinecap="round" />
            </svg>
            <input
              ref={searchRef}
              value={sessionQ} onChange={(e) => setSessionQ(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Escape") { setSessionQ(""); e.currentTarget.blur(); } }}
              placeholder="Search title or branch"
              style={{ flex: 1, minWidth: 0, height: "100%", border: 0, outline: "none", background: "transparent", fontFamily: "'JetBrains Mono',monospace", fontSize: "var(--t115)", color: "var(--txb)" }}
            />
            <span title="Press / to jump here" style={{ flex: "none", fontSize: "var(--t9)", color: "var(--txl)" }}>/</span>
            {/* Job rows print no project, branch or worktree, so PLUGINS has no row details to pick. */}
            {mode !== "plugins" && <span style={{ flex: "none", width: 1, height: 14, background: "color-mix(in srgb, var(--acc) 10%, transparent)" }} />}
            {mode === "projects" && (
              <button
                onClick={() => { setDetailMenu(false); setOrderMenu((o) => !o); }}
                title={`Project order — ${ORDER_LABEL[order]}`}
                aria-expanded={orderMenu}
                onMouseEnter={() => setHov("order")} onMouseLeave={() => setHov("")}
                style={{ flex: "none", border: 0, background: "transparent", padding: "0 2px", margin: 0, cursor: "pointer", fontFamily: "inherit",
                         fontSize: "var(--t12)", lineHeight: 1,
                         color: orderMenu || hov === "order" ? "var(--acc)" : "var(--txl)" }}
              >⇅</button>
            )}
            {orderMenu && (
              <>
                <div onClick={() => setOrderMenu(false)} style={{ position: "fixed", inset: 0, zIndex: 96 }} />
                <div style={{ position: "absolute", top: "calc(100% - 2px)", right: 0, zIndex: 97, minWidth: 140,
                              border: "1px solid color-mix(in srgb, var(--acc) 28%, transparent)", background: "var(--panel)",
                              boxShadow: "0 8px 22px var(--shadow-pop)", padding: 3, animation: "mslide .16s ease both" }}>
                  <div style={{ padding: "5px 8px 4px", fontSize: "var(--t8)", letterSpacing: ".18em", color: "var(--txl)" }}>PROJECT ORDER</div>
                  {ORDERS.map((m) => (
                    <button
                      key={m} onClick={() => { setOrder(m); setOrderMenu(false); }}
                      onMouseEnter={() => setHov(`ord:${m}`)} onMouseLeave={() => setHov("")}
                      style={{ width: "100%", appearance: "none", cursor: "pointer", textAlign: "left", border: 0,
                               background: order === m ? "color-mix(in srgb, var(--acc) 14%, transparent)"
                                 : hov === `ord:${m}` ? "color-mix(in srgb, var(--acc) 7%, transparent)" : "transparent",
                               color: order === m ? "var(--txb)" : "var(--txd)", fontFamily: "inherit",
                               fontSize: "var(--t9)", letterSpacing: ".1em", textTransform: "uppercase", padding: "6px 8px" }}
                    >{order === m ? "▸ " : "   "}{ORDER_LABEL[m]}</button>
                  ))}
                  {order === "custom" && (
                    <div style={{ padding: "5px 8px 4px", fontSize: "var(--t85)", color: "var(--txf)", letterSpacing: ".04em" }}>
                      drag a project header to reorder
                    </div>
                  )}
                </div>
              </>
            )}
            {mode !== "plugins" && <button
              onClick={() => { setOrderMenu(false); setDetailMenu((o) => !o); }}
              title={`Row details in ${mode.toUpperCase()} — ${shownFields || "nothing"}`}
              aria-expanded={detailMenu}
              onMouseEnter={() => setHov("detail")} onMouseLeave={() => setHov("")}
              style={{ flex: "none", border: 0, background: "transparent", padding: "0 2px", margin: 0, cursor: "pointer", fontFamily: "inherit",
                       fontSize: "var(--t12)", lineHeight: 1,
                       color: detailMenu || hov === "detail" ? "var(--acc)" : shownFields ? "var(--acc)" : "var(--txl)" }}
            >⎇</button>}
            {detailMenu && (
              <>
                <div onClick={() => setDetailMenu(false)} style={{ position: "fixed", inset: 0, zIndex: 96 }} />
                <div style={{ position: "absolute", top: "calc(100% - 2px)", right: 0, zIndex: 97, minWidth: 168,
                              border: "1px solid color-mix(in srgb, var(--acc) 28%, transparent)", background: "var(--panel)",
                              boxShadow: "0 8px 22px var(--shadow-pop)", padding: 3, animation: "mslide .16s ease both" }}>
                  <div style={{ padding: "5px 8px 4px", fontSize: "var(--t8)", letterSpacing: ".18em", color: "var(--txl)" }}>ROW DETAILS · {mode.toUpperCase()}</div>
                  {fieldsFor(mode).map((f) => {
                    const on = detail[f.k];
                    return (
                      // Ticks, not a preset list — the menu stays open so you can
                      // set all three against the rows changing behind it.
                      <button
                        key={f.k} onClick={() => toggleField(f.k)} title={f.tip}
                        role="menuitemcheckbox" aria-checked={on}
                        onMouseEnter={() => setHov(`det:${f.k}`)} onMouseLeave={() => setHov("")}
                        style={{ width: "100%", appearance: "none", cursor: "pointer", textAlign: "left", border: 0,
                                 display: "flex", alignItems: "center", gap: 8,
                                 background: hov === `det:${f.k}` ? "color-mix(in srgb, var(--acc) 7%, transparent)" : "transparent",
                                 color: on ? "var(--txb)" : "var(--txd)", fontFamily: "inherit",
                                 fontSize: "var(--t9)", letterSpacing: ".1em", textTransform: "uppercase", padding: "6px 8px" }}
                      >
                        <span style={{ flex: "none", width: 12, height: 12, display: "flex", alignItems: "center", justifyContent: "center",
                                       border: `1px solid ${on ? "var(--acc)" : "color-mix(in srgb, var(--acc) 30%, transparent)"}`,
                                       background: on ? "var(--acc)" : "transparent", color: "var(--acc-on)",
                                       fontSize: "var(--t9)", fontWeight: 700 }}>{on ? "✓" : ""}</span>
                        {f.label}
                      </button>
                    );
                  })}
                </div>
              </>
            )}
          </div>
          {/* PLUGINS lists what plugin workers started — there's no session of yours to start there. */}
          {mode !== "plugins" && (
            <button
              className="sess-search sess-plus" onClick={toggleForm} aria-label="New session" aria-expanded={nsOpen && !nsScoped}
              title="New session — in a project's checkout or a worktree"
              style={{ flex: "none", height: 38, aspectRatio: "1", marginTop: 11, padding: 0, display: "grid", placeItems: "center",
                       border: 0, borderBottom: "1px solid color-mix(in srgb, var(--acc) 9%, transparent)", cursor: "pointer", color: "var(--acc)" }}
            ><Plus size={16} strokeWidth={2.2} aria-hidden /></button>
          )}
        </div>
      </div>

      <div ref={scrollRef} className="mscroll" style={{ flex: 1, minHeight: 0, padding: "16px 10px 26px" }}>
        {nsOpen && !nsScoped && mode !== "plugins" && nsForm}
        {npOpen && mode !== "plugins" && npForm}
        {/* Pending plugin requests sit above the sessions they become on accept. */}
        {plugins.rivendell && <RivendellQueue active={mode === "plugins"} />}

        {mode !== "projects" ? (
          <div ref={listRef} style={{ position: "relative", height: rowV.getTotalSize() }}>
            {rowV.getVirtualItems().map((vi) => {
              const it = laneItems[vi.index];
              return (
                <div
                  key={vi.key}
                  data-index={vi.index}
                  ref={rowV.measureElement}
                  style={{ position: "absolute", top: 0, left: 0, width: "100%", transform: `translateY(${vi.start - scrollMargin}px)` }}
                >
                  {it.k === "head" ? laneHead(it)
                    : it.k === "row" ? rowFor(it.s, false, true, fresh ? vi.index : undefined)
                    : it.k === "day" ? <DayCut label={it.label} />
                    : (
                      <button
                        onClick={() => setFolded((v) => !v)}
                        onMouseEnter={() => setHov("fold")} onMouseLeave={() => setHov("")}
                        style={{ display: "block", width: "100%", textAlign: "left", padding: "7px 8px 7px 14px", border: 0,
                                 background: "transparent", fontFamily: "inherit", fontSize: "var(--t95)", letterSpacing: ".1em",
                                 color: hov === "fold" ? "var(--acc)" : "var(--txl)", cursor: "pointer" }}
                      >{it.label}</button>
                    )}
                </div>
              );
            })}
          </div>
        ) : (
          <>
            {tree.map(({ g, f, isShut, vis, rest, n }) => {
              const jobs = g.rel === JOBS_REL;
              const shared = g.rel === SHARED_REL;    // no folder of yours: no project menu, no New
              const tint = jobs || shared ? JOB_TINT : projectTint(g.rel);
              return (
                <div
                  key={g.rel}
                  className="projgrp"
                  data-ctx-type={jobs || shared ? undefined : "project"} data-ctx-id={g.rel} data-ctx-label={g.name}
                  onDragOver={dragRel ? (e) => { e.preventDefault(); setOverRel(g.rel); } : undefined}
                  onDrop={dragRel ? (e) => { e.preventDefault(); dropOn(g.rel); } : undefined}
                  style={{ marginBottom: isShut ? 4 : 13, opacity: dragRel === g.rel ? 0.4 : 1,
                           borderTop: `2px solid ${dragRel && overRel === g.rel && dragRel !== g.rel ? "var(--acc)" : "transparent"}` }}
                >
                  <div
                    className="projhead"
                    draggable={order === "custom" && !sq}
                    onDragStart={order === "custom" && !sq
                      ? (e) => { e.dataTransfer.effectAllowed = "move"; setDragRel(g.rel); } : undefined}
                    onDragEnd={order === "custom" ? () => { setDragRel(null); setOverRel(null); } : undefined}
                    onClick={() => {
                      // Collapsing the one project you drilled into would leave
                      // an empty panel — leave the drill first.
                      setOpen((c) => { const n = new Set(c); n.delete(g.rel); return n; });
                      setShut((c) => {
                        const n = new Set(c);
                        if (!n.delete(g.rel)) n.add(g.rel);
                        return n;
                      });
                    }}
                    title={order === "custom" && !sq
                      ? `${g.rel} — drag to reorder, click to ${isShut ? "expand" : "collapse"}`
                      : `${g.rel} · ${sq ? `${f.length} of ${g.sessionCount} match` : `${g.sessionCount} sessions`} — click to ${isShut ? "expand" : "collapse"}`}
                    style={{ display: "flex", alignItems: "center", gap: 9, height: 26, padding: "0 6px", userSelect: "none",
                             cursor: order === "custom" && !sq ? "grab" : "pointer",
                             // shut on a question: the head is the only thing left to say so
                             background: isShut && n.ask ? "color-mix(in srgb, var(--warn) 9%, transparent)" : undefined }}
                  >
                    <span className="pdot" style={{ flex: "none", width: 6, height: 6, background: tint.color }} />
                    {jobs ? <JobsTile /> : shared ? <TeamTile /> : <ProjectTile project={g.rel} />}
                    {/* A label, not a destination — a tier under the session titles so they read first. */}
                    <span style={{ flex: "none", maxWidth: 210, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                                   fontSize: "var(--t115)", letterSpacing: ".06em", color: isShut ? "var(--txd)" : "var(--txm)" }}>{g.name}</span>
                    <span style={{ flex: 1, minWidth: 6 }} />
                    <Tally n={n} />
                    {/* Rivendell or a teammate started these; there is no session of yours to start here. */}
                    {!jobs && !shared && <button
                      onClick={(e) => { e.stopPropagation(); openFor(g.rel); }}
                      title={`New session in ${g.rel}`}
                      draggable={false} onDragStart={(e) => e.preventDefault()}
                      onMouseEnter={() => setHov(`add:${g.rel}`)} onMouseLeave={() => setHov("")}
                      className="rowact" data-keep={nsOpen && nsScoped && nsProject === g.rel}
                      // Sits inside a header that collapses on click, so a near
                      // miss shuts the project instead. Full row height plus
                      // side padding, pulled back so nothing moves.
                      style={{ flex: "none", alignSelf: "stretch", display: "flex", alignItems: "center", gap: 6, border: 0, background: "transparent",
                               padding: "0 8px", margin: "0 -8px", cursor: "pointer", fontFamily: "inherit", fontSize: "var(--t9)",
                               letterSpacing: ".14em", textTransform: "uppercase",
                               color: hov === `add:${g.rel}` || (nsOpen && nsScoped && nsProject === g.rel) ? "var(--acc)" : "var(--txl)" }}
                    >
                      <svg width="9" height="9" viewBox="0 0 12 12" aria-hidden="true" style={{ flex: "none" }}>
                        <path d="M6 1v10M1 6h10" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                      </svg>
                      New
                    </button>}
                  </div>
                  {nsOpen && nsScoped && nsProject === g.rel && nsForm}
                  {/* Expanded, a project can be hundreds of rows long — the way
                      out has to sit at the top, not under all of them. */}
                  {open.has(g.rel) && (
                    <div style={{ display: "flex", alignItems: "center", gap: 10, height: 24, padding: "0 6px", margin: "2px 0 4px" }}>
                      <button
                        onClick={() => setOpen((c) => { const n = new Set(c); n.delete(g.rel); return n; })}
                        onMouseEnter={() => setHov(`back:${g.rel}`)} onMouseLeave={() => setHov("")}
                        style={{ flex: "none", display: "flex", alignItems: "center", gap: 6, border: 0, background: "transparent",
                                 padding: 0, margin: 0, cursor: "pointer", fontFamily: "inherit", fontSize: "var(--t9)",
                                 letterSpacing: ".2em", textTransform: "uppercase",
                                 color: hov === `back:${g.rel}` ? "var(--acc)" : "var(--txl)" }}
                      >← All projects</button>
                      <span style={{ flex: 1, minWidth: 8, height: 1, background: "color-mix(in srgb, var(--acc) 7%, transparent)" }} />
                      <span style={{ flex: "none", fontSize: "var(--t9)", color: "var(--txl)" }}>{f.length}</span>
                    </div>
                  )}
                  {jobs && open.has(g.rel) && !sq && <KindFilter rows={f} kind={jobKind} onKind={setJobKind} />}
                  <div className="projrail" style={{ margin: "1px 0 0 3px", borderLeft: `1px solid color-mix(in srgb, ${tint.color} ${isShut ? 7 : 20}%, transparent)` }}>
                    {/* A search drops the per-project cap, so this can be every
                        session in the store — skip off-screen rows. */}
                    {vis.length > 0 && <div className="vskip-card">{jobs && open.has(g.rel) && !sq
                      ? vis.flatMap((s, i) => {
                          const d = dayLabel(s.created ?? s.updated);
                          const cut = i === 0 || d !== dayLabel(vis[i - 1].created ?? vis[i - 1].updated);
                          return cut ? [<DayCut key={`day:${d}`} label={d} />, rowFor(s, true, false, i)] : [rowFor(s, true, false, i)];
                        })
                      : vis.map((s, i) => rowFor(s, true, false, i))}</div>}
                    {!isShut && !sq && (rest > 0 || (open.has(g.rel) && f.length > 2)) && (
                      <button
                        onClick={() => setOpen((c) => {
                          const n = new Set(c);
                          if (!n.delete(g.rel)) n.add(g.rel);
                          return n;
                        })}
                        onMouseEnter={() => setHov(`more:${g.rel}`)} onMouseLeave={() => setHov("")}
                        style={{ display: "block", width: "100%", textAlign: "left", padding: "7px 8px", border: 0, background: "transparent",
                                 fontFamily: "inherit", fontSize: "var(--t95)", letterSpacing: ".1em",
                                 color: hov === `more:${g.rel}` ? "var(--acc)" : "var(--txl)", cursor: "pointer" }}
                      >{open.has(g.rel) ? "show less ↑" : `${rest} more ↓`}</button>
                    )}
                  </div>
                </div>
              );
            })}
          </>
        )}

        {groups.length === 0 && (
          <div style={{ fontSize: "var(--t11)", color: "var(--txl)", padding: "10px 4px" }}>
            {booting ? "LOADING SESSIONS…" : "No projects with sessions yet."}
          </div>
        )}
        {groups.length > 0 && sq && sorted.length === 0 && (
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 14, padding: "72px 16px" }}>
            <div style={{ fontSize: "var(--t11)", color: "var(--txf)" }}>Nothing matches “{sessionQ.trim()}”</div>
            <button
              onClick={() => setSessionQ("")}
              style={{ border: 0, background: "transparent", padding: 0, cursor: "pointer", fontFamily: "inherit",
                       fontSize: "var(--t95)", letterSpacing: ".16em", textTransform: "uppercase", color: "var(--acc)" }}
            >Clear search</button>
          </div>
        )}
      </div>
    </div>
  );
}
