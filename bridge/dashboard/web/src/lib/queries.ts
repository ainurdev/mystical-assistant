// The dashboard's one query client and the key module every bridge read goes through (ADR 0006).
//
// A key is [route, params]: the route as the bridge names it (`/local/sessions/:id`), its
// parameters as one object. Two components that ask the same route with the same parameters
// get one request and one cached answer, however often their effects re-run. Each read below
// also says how often it polls and whether it polls while the page is hidden: only the bell's
// notices and the running list do, because the bell, the Dock badge, OS banners and WAITING ON
// YOU hang on them. No read refetches when the window comes back; polls pick up on their own
// interval, so coming back sends no burst.
//
// The request function (api.ts `req`) stays the only way to reach the bridge and is the query
// function: api.ts hands it in through `readWith` (this module can't import api.ts back, and
// the check runs it under node with no window). A POST stays a plain `req` call; when it
// succeeds, `req` invalidates the routes CHANGES names beside it, so every panel showing that
// state updates at once.
//
// Why not a timer per component: each observer of a polled query runs its own interval, so two
// panels polling one key out of phase would double its rate. The query function skips a fetch
// that lands within half an interval of the last one for that key (unless the key was
// invalidated), so a shared poll runs at its listed rate however many panels watch it.
//
// One part per area (the main column, Settings, the rail's code tabs, the rest of the rail):
// the batches after the router (tickets 12-15) each add to their own part.
import { QueryClient, hashKey, queryOptions, type FetchQueryOptions } from "@tanstack/react-query";
import type {
  AccountsInfo, AcpAgentsInfo, AcpLogin, AgentActivity, AgentsInfo, AiFeature, CompareFile, CouncilSettings,
  DashState, EnrichedSession, EnvSetting, FileContent, FlowSettings, GitBadge, GitCommit, GitLedger, GitStatus,
  GraphInstall, GraphState, GrepHit, HostStats, Integration, Lesson, McpInfo, MoveFile, MoveJob, MovePlan, MoveRead,
  NextBoard, Notice, NoticePrefs, Place, PluginsInfo, PrStatus, ProjectSettings, ProjectsListing, QueueSnapshot,
  RepoImages, RivendellInstance, RunningInfo, Saver, SessionBrief, SkillsInfo, SlashCommand, StartupState,
  StorageScan, TermInfo, Transcript, UpdateInfo, UsageInfo, VideoTools, WorkspaceSet, Worktree,
} from "../api.ts";
import type { AgentDetail, Team } from "./agentteam.ts";
import type { BranchPr, BranchStatus } from "./branchrows.ts";
import type { Flow, FlowSet, PastFlow } from "./flowview.ts";
import type { AgentRow, ChannelView, HelperConfig } from "./multi.ts";
import type { HandoffPreview, SkillShareRow } from "./multistore.ts";
import type { ProfilesInfo } from "./profiles.ts";
import type { CriticProblem, DesignBoard, DesignComment } from "./designframe.ts";
import type {
  CouncilBrief, InspectorState, LiveInfo, Meter, RivendellDevice, RivendellQueueItem, RivendellTaskDetail, RivendellTasks,
  RivendellTodolist, StyleCandidates, StyleRun, TaskState, TeamOverview, TodayWins, Weather, WeeklyReport,
} from "../api.ts";

export type Params = Record<string, string | number | boolean | null | undefined>;
export type Key = readonly [string, Params];
/** `ms`: how often it polls while someone shows it; `hidden`: it polls while the page is hidden too;
 *  `delta`: each fetch asks from the last answer's cursor (meta.extra), so one is never answered from the cache. */
export interface Poll { ms: number; hidden?: true; delta?: true }

export const keyOf = (route: string, params: Params = {}): Key => [route, params];

/** The URL a key reads: `:name` segments filled from the parameters, the rest as the query.
 *  undefined and null are left out (the bridge's "not given"). */
export function urlOf(route: string, params: Params = {}): string {
  const q = new URLSearchParams();
  const used = new Set<string>();
  const path = route.replace(/:(\w+)/g, (_, k: string) => { used.add(k); return encodeURIComponent(String(params[k] ?? "")); });
  for (const [k, v] of Object.entries(params)) if (!used.has(k) && v !== undefined && v !== null) q.set(k, String(v));
  const s = q.toString();
  return s ? `${path}?${s}` : path;
}

const POLLS = new Map<string, Poll | null>();
/** Reads the bridge answers on POST (the chat's design routes): their parameters are the body. */
const BY_POST = new Set<string>();

/** One read: call it with its parameters for the query's options. `extra` rides in the URL
 *  but not the key (what changes every call and must not split the cache). */
function read<T, P extends Params = Params>(route: string, poll: Poll | null = null, extra?: () => Params) {
  // One poll per route: the half-interval skip reads it by route, so a second rate would bend the first.
  if (POLLS.has(route) && JSON.stringify(POLLS.get(route)) !== JSON.stringify(poll)) throw new Error(`${route} is listed with two polls`);
  POLLS.set(route, poll);
  return Object.assign((params?: P) => queryOptions<T, Error, T, Key>({
    queryKey: keyOf(route, params),
    refetchInterval: poll?.ms ?? false,
    refetchIntervalInBackground: !!poll?.hidden,
    meta: extra ? { extra } : undefined,
  }), { route, poll });
}

function readByPost<T, P extends Params = Params>(route: string, poll: Poll | null = null) {
  BY_POST.add(route);
  return read<T, P>(route, poll);
}

/** What the running poll tells the bridge about this page, read at each fetch (App sets them):
 *  it raises its own OS alerts (the tray companion stays quiet), and its last input (Telegram's "away"). */
export const runningHints: { alerts?: 1; seen?: number } = {};

/** Which session the PR chip is on: rides with every PR read for the Telegram ping's button
 *  (bridge prstatus), but not in the key, so GIT and the chip share one read (PrChip sets it). */
export const prHints: { session?: string } = {};

export type NoticesAnswer = { notices: Notice[]; prefs: NoticePrefs; quiet: boolean; telegram: boolean };
export type DesignRead = DesignBoard & { comments: DesignComment[]; page?: string; url?: string; html?: string; hash?: string; version?: number; versions?: number[]; missing?: boolean };
export type DesignCritique = { state: string; error?: string; verdict?: string; fixes?: CriticProblem[] };
export type FlowAnswer = { flow: Flow | null; past?: PastFlow[]; set: FlowSet | null; pack?: boolean };   // pack: DESIGN PACK open for it

/** The main column: the session list, the open session, its prompt box and what rides beside it. */
export const main = {
  state: read<DashState>("/local/state", { ms: 5000 }),
  projects: read<ProjectsListing, { dir?: string }>("/local/projects", { ms: 10000 }),
  sessions: read<{ sessions: SessionBrief[] }, { project?: string }>("/local/sessions", { ms: 5000 }),
  // The open session's transcript. The live read is keyed by the session alone: its cursor (and
  // the first read's tail) ride in meta.extra, and meta.take merges each delta once, in order
  // (App). Polled while a turn runs. An older page is a one-off read with `before`.
  session: read<Transcript, { id: string; cursor?: number; tail?: number; before?: number }>("/local/sessions/:id", { ms: 1500, delta: true }),
  running: read<RunningInfo>("/local/running", { ms: 4000, hidden: true }, () => runningHints),
  // Polled only while the session runs or an agent does (AgentsPill).
  agents: read<AgentsInfo, { session: string }>("/local/agents", { ms: 1500 }),
  // Polled only while a turn runs or its tickets move (useFlow, SessionPanel, TicketMap); the
  // ticket map also every 15 s while its set rests.
  flow: read<FlowAnswer, { session: string }>("/local/flow", { ms: 4000 }),
  // Listed at 2.5 s so readWith's half-interval skip never eats WORK's 1.5 s refine poll; readers set their own rate.
  worklist: read<unknown, { session: string; project: string }>("/local/worklist", { ms: 2500 }),
  commands: read<{ commands: SlashCommand[] }, { project?: string }>("/local/commands"),
  accounts: read<AccountsInfo, { fresh?: number }>("/local/accounts", { ms: 60000 }),
  usage: read<UsageInfo>("/local/usage", { ms: 60000 }),
  acpAgents: read<AcpAgentsInfo>("/local/acp/agents", { ms: 60000 }),
  profiles: read<ProfilesInfo>("/local/profiles"),
  projectSettings: read<ProjectSettings, { cwd?: string; cwd_rel?: string; project?: string; branch?: string }>("/local/project/settings"),
  queue: read<QueueSnapshot, { session: string }>("/local/queue"),   // then its stream
  prompts: read<{ prompts: string[] }>("/local/prompts"),
  filesTree: read<{ files: string[]; ignored?: string[]; root?: string }, { project: string; branch?: string; ignored?: 0 }>("/local/files/tree"),
  paths: read<{ paths: { text: string; name: string; dir: boolean }[] }, { project: string; prefix: string }>("/local/complete/paths"),
  symbols: read<{ symbols: { name: string; file: string }[] }, { project: string }>("/local/complete/symbols"),
  chatSearch: read<{ hits: { turn: string; kind: string; seq: number | null; snippet: string; at?: number }[] }, { session: string; q: string }>("/local/chat-search"),
  chatReport: read<{ text: string }, { session: string; path: string }>("/local/chat-report"),
  history: read<{ sessions: EnrichedSession[] }, { archived?: 1 }>("/local/history", { ms: 5000 }),
  // The fresh screen's NEXT UP: polled only while a REFRESH's scouts run.
  next: read<NextBoard, { project?: string; kind?: string }>("/local/next", { ms: 3000 }),
  // The sidebar's unseen-picture tags: each session's tool pictures from the last day, as
  // [path, at] pairs (lib/seenshots), `since` riding in the URL. A bridge without it 404s: no tags.
  shots: read<Record<string, [string, number][]>>("/local/shots", { ms: 15000 }, () => ({ since: Math.floor(Date.now() / 1000 - 86400) })),
  // The agents views: the chat's Claude sub-agents as a team, one up close (while it works),
  // and an agent's run by cursor (while it runs).
  team: read<Team, { session: string }>("/local/team", { ms: 2000 }),
  teamAgent: read<AgentDetail, { session: string; agent: string }>("/local/team/agent", { ms: 2500 }),
  agentActivity: read<AgentActivity, { session: string; agent: string; workflow?: string }>("/local/agents/activity", { ms: 1000, delta: true }),
  // Multi-agent chats (lib/multistore): the switch, every wanted chat's agents in one read
  // (only while the switch is on), a chat's channel, and a helper's brief by id.
  experimental: read<{ enabled: boolean; defaults: HelperConfig }>("/local/experimental", { ms: 60000 }),
  tree: read<{ trees: Record<string, AgentRow[]> }, { ids: string }>("/local/tree", { ms: 5000 }),
  channel: read<ChannelView, { session: string }>("/local/channel", { ms: 2000 }),
  brief: read<{ session: SessionBrief }, { session: string }>("/local/session/brief", { ms: 3000 }),
  // What a PROFILE switch would carry over, and the shared skills an agent's / list offers.
  handoff: read<HandoffPreview, { session: string; profile: string }>("/local/session/handoff"),
  skillShare: read<{ skills: SkillShareRow[] }, { cwd?: string }>("/local/skill-share"),
  // Results in the chat (bridge/multi_api.py _post_design): a design board, kept current by the
  // hash of what the page holds (meta.extra `have`), its critic while it runs, and open_site's
  // browser card.
  designBoard: readByPost<DesignRead, { session_id: string; board: string; page?: string }>("/local/chat/design", { ms: 1500, delta: true }),
  designCritique: readByPost<DesignCritique, { session_id: string; board: string; page: string; fresh: false }>("/local/chat/design-critique", { ms: 3000 }),
  browser: readByPost<{ running: boolean; pinned: number; to: string | null }, { session_id: string; op: "state"; url: string }>("/local/chat/browser", { ms: 4000 }),
};

/** Settings and its pages, and the switches they own that the rest of the page reads (AI
 *  features, integrations, the FLOWS sheet). Its accounts, notices, update and projects are the
 *  other parts' reads. */
export const settings = {
  flows: read<FlowSettings>("/local/flows"),
  aiFeatures: read<{ features: AiFeature[] }>("/local/aifeatures"),
  integrations: read<{ plugins: Integration[] }>("/local/integrations"),
  // Polled only while an install runs (lib/ai useGraphify).
  graphInstall: read<GraphInstall>("/local/graph/install", { ms: 1500 }),
  startup: read<StartupState>("/local/startup"),
  env: read<{ settings: EnvSetting[] }>("/local/envsettings"),
  // Polled while INTEGRATIONS ▸ Rivendell is open: the socket goes up and down on its own.
  rivendell: read<{ instances: RivendellInstance[]; video?: VideoTools }>("/local/rivendell", { ms: 4000 }),
  // Polled only while an MCP sign-in waits for the CLI's own callback.
  mcp: read<McpInfo>("/local/mcp", { ms: 2500 }),
  // A POST (`action: status`), polled only while that sign-in runs (AgentRow passes its queryFn).
  acpLogin: read<AcpLogin, { agent: string; account: string }>("/local/acp/login", { ms: 2000 }),
  savers: read<{ savers: Saver[] }>("/local/savers"),
  council: read<CouncilSettings>("/local/council/settings"),
  movePlan: read<MovePlan>("/local/move/plan"),
  moveFiles: read<{ files: MoveFile[] }>("/local/move/files"),
  moveRead: read<{ read: MoveRead | null }>("/local/move/read"),
  // Listed at its fastest: every second while a move runs. MOVE asks every 5 s at rest, the dock not at all.
  moveJobs: read<{ jobs: MoveJob[] }>("/local/move/jobs", { ms: 1000 }),
  weatherSearch: read<{ results?: Place[]; error?: string }, { q: string }>("/local/weather/search"),
  workspaces: read<WorkspaceSet>("/local/workspaces"),
  skills: read<SkillsInfo, { project?: string }>("/local/skills"),
  storage: read<StorageScan>("/local/storage"),
  usageSharing: read<{ share: boolean | null }>("/local/usage-sharing"),
  projectSettings: read<ProjectSettings, { project: string }>("/local/project/settings"),
  plugins: read<PluginsInfo>("/local/plugins"),
  repoImages: read<RepoImages, { project: string }>("/local/project-mark/repo"),
  // SYSTEM ▸ Send images: another surface can change it, so the 60 s.
  chatImages: read<{ mode?: string; shown?: string }>("/local/chat-images", { ms: 60_000 }),
};

type Tree = { project: string; branch?: string };
/** `at`: the heads it was asked about (ahead|behind|upstream), so a move asks again. */
type Heads = Tree & { at: string };

/** The rail's code tabs: GIT, FILES, BRANCHES, MAP, the editor and its terminal drawer. */
export const code = {
  git: read<GitStatus, Tree>("/local/git", { ms: 10000 }),
  gitAll: read<{ repos: Record<string, GitBadge> }>("/local/git/all", { ms: 10000 }),
  // BRANCHES polls every 30 s while it's open, else every minute (useBranches).
  branchStatus: read<BranchStatus, { project: string }>("/local/git/branchstatus", { ms: 30000 }),
  branchPrs: read<{ prs: Record<string, BranchPr> }, { project: string }>("/local/github/prs", { ms: 30000 }),
  graphState: read<GraphState, { project: string }>("/local/graph/state"),
  // The sidebar's NEW WORKTREE and relocate.
  branches: read<{ branches: string[]; current: string; default: string }, { project: string }>("/local/git/branches"),
  worktrees: read<{ worktrees: Worktree[]; merged: string[] }, { project: string }>("/local/git/worktrees"),
  ledger: read<GitLedger, Heads>("/local/git/ledger"),
  incoming: read<{ commits: { sha: string; subject: string; ts: number }[]; clash: string[] | null }, Heads>("/local/git/incoming"),
  log: read<{ commits: GitCommit[] }, Tree & { limit: number }>("/local/git/log", { ms: 15000 }),
  // One commit's files, or with `path` one file's diff in it: a sha never changes, so never polled.
  show: read<{ ok?: boolean; files?: CompareFile[]; add?: number; del?: number; diff?: string }, { project: string; sha: string; path?: string }>("/local/git/show"),
  pr: read<PrStatus, { project: string; branch: string }>("/local/github/pr/status", { ms: 60000 }, () => prHints),
  tree: read<{ files: string[]; ignored?: string[]; root?: string }, Tree>("/local/files/tree"),
  file: read<FileContent, Tree & { path: string }>("/local/files/read"),
  head: read<{ ok: boolean; exists?: boolean; content?: string; error?: string }, Tree & { path: string }>("/local/files/head"),
  grep: read<{ hits: GrepHit[] }, Tree & { q: string; mode?: "word" | "def" }>("/local/files/grep"),
  terminals: read<{ terminals: TermInfo[] }, { project: string }>("/local/terminals"),
};

/** The rest of the rail and the caps: the bell, HOME's vitals, UPDATE and the changelog. */
export const rail = {
  notices: read<NoticesAnswer>("/local/notices", { ms: 4000, hidden: true }),
  sysinfo: read<HostStats>("/local/sysinfo", { ms: 5000 }),
  update: read<UpdateInfo>("/local/update", { ms: 5 * 60_000 }),
  // -- rail A: Rivendell, TEAM, device runs
  // 1 s only while a share is coming in, else 30 s (App).
  team: read<TeamOverview>("/local/rivendell/team", { ms: 1000 }),
  queue: read<{ queue: RivendellQueueItem[] }>("/local/rivendell/queue", { ms: 4000 }),
  // RIVENDELL polls it at 10 s (30 s in the everywhere view), TEAM at 60 s: one key.
  rivendellTasks: read<RivendellTasks, { project: string }>("/local/rivendell/tasks", { ms: 10000 }),
  rivendellTask: read<RivendellTaskDetail, { instance_id: string; task_id: string }>("/local/rivendell/task"),
  rivendellTodolist: read<{ todolist: RivendellTodolist | null }, { instance_id: string; project_id: string }>("/local/rivendell/todolist"),
  devices: read<{ instances: RivendellDevice[] }>("/local/rivendell/devices", { ms: 4000 }),
  taskState: read<{ task: TaskState | null }, { project: string; branch: string }>("/local/rivendell/taskstate", { ms: 60000 }),
  // -- end rail A
  // -- rail B: update, changelog, go-live, restart, notices' actions
  changelog: read<{ notices: Notice[]; project?: string }>("/local/changelog", { ms: 60_000 }),
  // 30 s at rest; the 4 s listed is its rate while AFTER N TURNS waits (ChangelogButton picks).
  live: read<LiveInfo>("/local/live", { ms: 4000 }),
  // -- end rail B
  // -- rail C: HOME, SESSION, COUNCIL, LEARN, the ticket map
  wins: read<TodayWins>("/local/wins", { ms: 60_000 }),
  weather: read<Weather>("/local/weather", { ms: 600_000 }),
  // {} when the session has no transcript yet. Polled only while the SESSION tab's flow is busy.
  meter: read<Meter | Record<string, never>, { id: string }>("/local/sessions/:id/meter", { ms: 4000 }),
  // Light (no git) for App's tile; `full: 1` while the COUNCIL tab shows a resting run. 3 s while
  // a run moves, else 15 s (CouncilPanel councilRead).
  council: read<CouncilBrief, { sid: string; full?: 1 }>("/local/council/:sid", { ms: 3000 }),
  // The LEARN list (App polls `*` for the badge) and one lesson's body share the route, so one poll entry.
  lessons: read<{ lessons: Lesson[]; repo_enabled: boolean }, { project: string }>("/local/learn", { ms: 60_000 }),
  lesson: read<{ file: string; body: string }, { project: string; file: string }>("/local/learn", { ms: 60_000 }),
  // -- end rail C
  // -- rail D: Analyze, the inspector, USAGE, MAP, style runs, WORK, DOCS, AUTO, NEXT
  inspector: read<InspectorState>("/local/inspector", { ms: 2000 }),
  report: read<WeeklyReport, { back?: 1 }>("/local/report", { ms: 60_000 }),
  // Polled only while a style run runs (lib/stylerun follows it).
  styleRun: read<StyleRun>("/local/project-mark/style", { ms: 500 }),
  styleCandidates: read<StyleCandidates>("/local/project-mark/style/candidates"),
  // A POST the bridge answers with the listing (readapi's queryFn); the agent writes pages as you watch.
  docs: read<unknown, { session: string }>("/local/chat/docs", { ms: 6000 }),
  automations: read<unknown>("/local/automations", { ms: 5000 }),
  // -- end rail D
};

const GIT = [code.git.route, code.gitAll.route, code.branchStatus.route, code.branches.route, code.ledger.route,
  code.incoming.route, code.log.route, code.worktrees.route];
const LISTS = [main.sessions.route, main.running.route, main.history.route];
/** What a working tree's files read: a save, a file op, and every git move that rewrites files or HEAD. */
const FILES = [code.tree.route, code.file.route, code.head.route, code.git.route, code.gitAll.route, code.branchStatus.route];
/** A POST's route (as `req` is called with it, `:x` for one segment, a trailing `*` for the
 *  rest) and the reads it changes. */
export const CHANGES: Record<string, string[]> = {
  "/local/run": LISTS,
  "/local/run/:id/interrupt": LISTS,
  "/local/run/:id/respond": [main.running.route, rail.notices.route, main.session.route],   // session: a ticket map row's tail
  "/local/sessions": LISTS,
  "/local/sessions/:id/*": LISTS,
  "/local/session/profile": [main.sessions.route],
  "/local/session/settings": [main.sessions.route],
  "/local/profiles": [main.profiles.route],
  "/local/project/profile": [main.profiles.route, main.projects.route],
  "/local/next": [main.next.route],
  "/local/experimental": [main.experimental.route],
  "/local/channel/*": [main.channel.route, main.tree.route],
  "/local/chat/config": [main.channel.route, main.tree.route],
  "/local/select": [main.state.route],
  "/local/notices": [rail.notices.route, main.running.route, rail.changelog.route],   // a dismiss, a read, a limit hand-off (parked session moves)
  "/local/accounts": [main.accounts.route],
  "/local/flow/*": [main.flow.route],
  // FLOWS, AUTO PICKS and SMART ZONE are AI switches too.
  "/local/flows": [settings.flows.route, settings.aiFeatures.route],
  "/local/aifeatures": [settings.aiFeatures.route],
  "/local/integrations": [settings.integrations.route],
  "/local/startup": [settings.startup.route],
  "/local/envsettings": [settings.env.route],
  "/local/rivendell": [settings.rivendell.route, settings.integrations.route],
  "/local/mcp": [settings.mcp.route],
  "/local/acp/accounts": [main.acpAgents.route],
  "/local/acp/test": [main.acpAgents.route],
  "/local/policy/default": [main.accounts.route],
  "/local/savers": [settings.savers.route],
  "/local/council/settings": [settings.council.route],
  // Not the plan: it runs git over every repo (seconds), and only an import changes what it lists.
  "/local/move/*": [settings.moveFiles.route, settings.moveRead.route, settings.moveJobs.route],
  "/local/move/import": [settings.movePlan.route],
  "/local/workspaces": [settings.workspaces.route],
  "/local/workspaces/*": [settings.workspaces.route],
  "/local/skills/install": [settings.skills.route],
  "/local/skills/remove": [settings.skills.route],
  "/local/plugins/*": [settings.plugins.route],
  "/local/storage/clear": [settings.storage.route],
  "/local/usage-sharing": [settings.usageSharing.route],
  "/local/learn/toggle": [rail.lessons.route],
  "/local/project-mark/pick": [main.projects.route],
  "/local/roots/remove": [main.projects.route],
  "/local/worklist/*": [main.worklist.route],
  "/local/graph/*": [code.graphState.route, settings.graphInstall.route],
  "/local/git/*": GIT,
  "/local/git/checkout": FILES,
  "/local/git/commit": FILES,
  "/local/git/op": FILES,
  "/local/git/pull": FILES,
  "/local/git/merge": FILES,
  "/local/git/merge-upstream": FILES,
  "/local/git/update-base": FILES,
  "/local/git/undo-commit": FILES,
  "/local/files/write": FILES,
  "/local/files/op": FILES,
  "/local/github/pr": [code.pr.route, code.branchPrs.route],
  "/local/terminals": [code.terminals.route],
  "/local/terminals/:id/close": [code.terminals.route],
  "/local/server": [main.state.route],
  "/local/update": [rail.update.route],
  "/local/project/settings": [main.projects.route, main.projectSettings.route, code.graphState.route, settings.projectSettings.route],
  // -- rail A
  "/local/rivendell/test": [settings.rivendell.route, rail.rivendellTasks.route],
  "/local/rivendell/queue": [rail.queue.route, rail.notices.route, rail.rivendellTasks.route],
  "/local/rivendell/implement": [rail.rivendellTasks.route],
  "/local/rivendell/again": [rail.rivendellTasks.route],
  "/local/rivendell/devices": [rail.devices.route],
  "/local/rivendell/devices/*": [rail.devices.route],
  "/local/rivendell/taskstate": [rail.taskState.route],
  "/local/rivendell/team/*": [rail.team.route],
  // -- end rail A
  // -- rail B
  "/local/live/*": [rail.live.route],
  // -- end rail B
  // -- rail C
  "/local/weather/*": [rail.weather.route],
  "/local/council/:sid": [rail.council.route],
  "/local/git/push": [rail.council.route],
  "/local/tickets/*": [main.flow.route],
  // -- end rail C
  // -- rail D
  "/local/inspector": [rail.inspector.route],
  "/local/project-mark/style": [rail.styleRun.route],
  "/local/automations/*": [rail.automations.route],
  // -- end rail D
};

const matchers = Object.entries(CHANGES).map(([pat, routes]) => {
  const re = pat.replace(/[.]/g, "\\.").replace(/:\w+/g, "[^/]+").replace(/\/\*$/, "/.+");
  return [new RegExp(`^${re}$`), routes] as const;
});

/** The reads a POST to `path` changes ([] for none). */
export function changedBy(path: string): string[] {
  const p = path.split("?")[0];
  return [...new Set(matchers.flatMap(([re, routes]) => (re.test(p) ? routes : [])))];
}

/** Every read the key module lists, with its poll (null = it doesn't poll). */
export const reads = (): ReadonlyMap<string, Poll | null> => POLLS;

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      retry: false,              // as before: a failed read waits for the next poll
      staleTime: 15_000,         // a panel opening inside a poll's window reads the cache
    },
  },
});

const lastFetch = new Map<string, number>();

/** Hands the request function in as every read's query function (api.ts does it once). */
export function readWith(get: (url: string, body?: Params) => Promise<unknown>): void {
  queryClient.setDefaultOptions({
    queries: {
      ...queryClient.getDefaultOptions().queries,
      queryFn: ({ queryKey, meta }) => {
        const queryHash = hashKey(queryKey);
        const [route, params] = queryKey as unknown as Key;
        const poll = POLLS.get(route);
        const st = queryClient.getQueryState(queryKey);
        const last = lastFetch.get(queryHash) ?? 0;
        // Another panel's interval on the same key, out of phase with the first: the answer is fresh.
        if (poll && !poll.delta && st?.status === "success" && !st.isInvalidated && Date.now() - last < poll.ms / 2)
          return Promise.resolve(st.data);
        if (poll) lastFetch.set(queryHash, Date.now());
        const extra = (meta?.extra as (() => Params) | undefined)?.();
        const take = meta?.take as ((d: unknown) => void) | undefined;
        const out = BY_POST.has(route) ? get(route, { ...params, ...extra }) : get(urlOf(route, { ...params, ...extra }));
        return take ? out.then((d) => { take(d); return d; }) : out;
      },
    },
  });
}

/** Read a key (or every key under a route) again now. A read already on its way is the
 *  answer: it started after whatever changed. */
export const reread = (queryKey: readonly unknown[]) =>
  queryClient.invalidateQueries({ queryKey }, { cancelRefetch: false });

/** A one-off read through the client: always asks the bridge, but joins a read of the same
 *  key already on its way, and lands in the cache the polls and panels read. */
export const fetchFresh = <T>(o: FetchQueryOptions<T, Error, T, Key>) => queryClient.fetchQuery({ ...o, staleTime: 0 });

/** A successful POST to `path`: its reads go stale and refetch where they're shown. */
export function posted(path: string): void {
  for (const route of changedBy(path)) void queryClient.invalidateQueries({ queryKey: [route] });
}
