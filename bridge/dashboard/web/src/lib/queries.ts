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
import { QueryClient, hashKey, queryOptions } from "@tanstack/react-query";
import type {
  AccountsInfo, AcpAgentsInfo, AcpLogin, AgentsInfo, AiFeature, CouncilSettings, DashState, EnvSetting,
  FlowSettings, GitBadge, GitStatus, GraphInstall, GraphState, HostStats, Integration, Lesson, McpInfo,
  MoveFile, MoveJob, MovePlan, MoveRead, Notice, NoticePrefs, Place, PluginsInfo, ProjectSettings, ProjectsListing,
  RepoImages, RivendellInstance, RunningInfo, Saver, SessionBrief, SkillsInfo, SlashCommand, StartupState, StorageScan,
  Transcript, UpdateInfo, VideoTools, WorkspaceSet,
} from "../api.ts";
import type { HookListing, RuleLogRow, RuleRow, Scope, ToolGrid } from "./agenttools.ts";
import type { BranchStatus } from "./branchrows.ts";
import type { DirListing } from "./mysticaldir.ts";
import type { Flow, FlowSet, PastFlow } from "./flowview.ts";

export type Params = Record<string, string | number | boolean | null | undefined>;
export type Key = readonly [string, Params];
/** `ms`: how often it polls while someone shows it; `hidden`: it polls while the page is hidden too. */
export interface Poll { ms: number; hidden?: true }

type ScopeP = Pick<Scope, keyof Scope>;   // an interface has no index signature

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

/** One read: call it with its parameters for the query's options. `extra` rides in the URL
 *  but not the key (what changes every call and must not split the cache). */
function read<T, P extends Params = Params>(route: string, poll: Poll | null = null, extra?: () => Params) {
  POLLS.set(route, poll);
  return Object.assign((params?: P) => queryOptions<T, Error, T, Key>({
    queryKey: keyOf(route, params),
    refetchInterval: poll?.ms ?? false,
    refetchIntervalInBackground: !!poll?.hidden,
    meta: extra ? { extra } : undefined,
  }), { route, poll });
}

/** What the running poll tells the bridge about this page, read at each fetch (App sets them):
 *  it raises its own OS alerts (the tray companion stays quiet), and its last input (Telegram's "away"). */
export const runningHints: { alerts?: 1; seen?: number } = {};

export type NoticesAnswer = { notices: Notice[]; prefs: NoticePrefs; quiet: boolean; telegram: boolean };
export type FlowAnswer = { flow: Flow | null; past?: PastFlow[]; set: FlowSet | null };

/** The main column: the session list, the open session, its prompt box and what rides beside it. */
export const main = {
  state: read<DashState>("/local/state", { ms: 3000 }),
  projects: read<ProjectsListing, { dir?: string }>("/local/projects", { ms: 10000 }),
  sessions: read<{ sessions: SessionBrief[] }, { project?: string }>("/local/sessions", { ms: 5000 }),
  // The open session's transcript, read by cursor. Its 1.5 s poll while a turn runs is still
  // App's own timer (it merges deltas), paused while hidden; ticket 12 moves it here.
  session: read<Transcript, { id: string; cursor: number; tail?: number; before?: number }>("/local/sessions/:id"),
  running: read<RunningInfo>("/local/running", { ms: 4000, hidden: true }, () => runningHints),
  // Polled only while the session runs or an agent does (AgentsPill).
  agents: read<AgentsInfo, { session: string }>("/local/agents", { ms: 1500 }),
  // Polled only while a turn runs or its tickets move (useFlow, SessionPanel, TicketMap); the
  // ticket map also every 15 s while its set rests.
  flow: read<FlowAnswer, { session: string }>("/local/flow", { ms: 4000 }),
  worklist: read<unknown, { session: string; project: string }>("/local/worklist", { ms: 4000 }),
  commands: read<{ commands: SlashCommand[] }, { project?: string }>("/local/commands"),
  accounts: read<AccountsInfo, { fresh?: number }>("/local/accounts", { ms: 60000 }),
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
  acpAgents: read<AcpAgentsInfo>("/local/acp/agents"),
  // A POST (`action: status`), polled only while that sign-in runs (AgentRow passes its queryFn).
  acpLogin: read<AcpLogin, { agent: string; account: string }>("/local/acp/login", { ms: 2000 }),
  savers: read<{ savers: Saver[] }>("/local/savers"),
  council: read<CouncilSettings>("/local/council/settings"),
  movePlan: read<MovePlan>("/local/move/plan"),
  moveFiles: read<{ files: MoveFile[] }>("/local/move/files"),
  moveRead: read<{ read: MoveRead | null }>("/local/move/read"),
  // Every 5 s while MOVE is open, every second while a move runs.
  moveJobs: read<{ jobs: MoveJob[] }>("/local/move/jobs", { ms: 5000 }),
  weatherSearch: read<{ results?: Place[]; error?: string }, { q: string }>("/local/weather/search"),
  workspaces: read<WorkspaceSet>("/local/workspaces"),
  skills: read<SkillsInfo, { project?: string }>("/local/skills"),
  storage: read<StorageScan>("/local/storage"),
  usageSharing: read<{ share: boolean | null }>("/local/usage-sharing"),
  projectSettings: read<ProjectSettings, { project: string }>("/local/project/settings"),
  plugins: read<PluginsInfo>("/local/plugins"),
  repoImages: read<RepoImages, { project: string }>("/local/project-mark/repo"),
  lessons: read<{ lessons: Lesson[]; repo_enabled: boolean }, { project: string }>("/local/learn"),
  // AGENT TOOLS: multi-agent routes, read through multistore's call (lib/agenttoolsapi).
  agentTools: read<ToolGrid, ScopeP>("/local/agent-tools"),
  rules: read<{ rules: RuleRow[] }, ScopeP>("/local/rules"),
  ruleLog: read<{ rows: RuleLogRow[] }, { session?: string }>("/local/rules/log"),
  hooks: read<HookListing, ScopeP>("/local/hooks"),
  mysticalDir: read<DirListing, { project?: string | null; session?: string | null; sub: string }>("/local/mystical-dir"),
  mysticalFile: read<{ text: string }, { project?: string | null; session?: string | null; path: string }>("/local/mystical-dir/read"),
};

/** The rail's code tabs: GIT, FILES, BRANCHES, MAP, the editor. */
export const code = {
  git: read<GitStatus, { project: string; branch?: string }>("/local/git", { ms: 10000 }),
  gitAll: read<{ repos: Record<string, GitBadge> }>("/local/git/all", { ms: 10000 }),
  branchStatus: read<BranchStatus, { project: string }>("/local/git/branchstatus"),
  graphState: read<GraphState, { project: string }>("/local/graph/state"),
};

/** The rest of the rail and the caps: the bell, HOME's vitals, UPDATE and the changelog. */
export const rail = {
  notices: read<NoticesAnswer>("/local/notices", { ms: 4000, hidden: true }),
  sysinfo: read<HostStats>("/local/sysinfo", { ms: 2000 }),
  update: read<UpdateInfo>("/local/update", { ms: 5 * 60_000 }),
};

const GIT = [code.git.route, code.gitAll.route, code.branchStatus.route];
/** A POST's route (as `req` is called with it, `:x` for one segment, a trailing `*` for the
 *  rest) and the reads it changes. */
export const CHANGES: Record<string, string[]> = {
  "/local/run": [main.sessions.route, main.running.route],
  "/local/run/:id/interrupt": [main.running.route, main.sessions.route],
  "/local/run/:id/respond": [main.running.route, rail.notices.route],
  "/local/sessions": [main.sessions.route],
  "/local/sessions/:id/*": [main.sessions.route, main.running.route],
  "/local/select": [main.state.route],
  "/local/notices": [rail.notices.route],
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
  "/local/acp/accounts": [settings.acpAgents.route],
  "/local/acp/test": [settings.acpAgents.route],
  "/local/policy/default": [main.accounts.route],
  "/local/savers": [settings.savers.route],
  "/local/council/settings": [settings.council.route],
  "/local/move/*": [settings.movePlan.route, settings.moveFiles.route, settings.moveRead.route, settings.moveJobs.route],
  "/local/workspaces": [settings.workspaces.route],
  "/local/workspaces/*": [settings.workspaces.route],
  "/local/skills/install": [settings.skills.route],
  "/local/skills/remove": [settings.skills.route],
  "/local/plugins/*": [settings.plugins.route],
  "/local/storage/clear": [settings.storage.route],
  "/local/usage-sharing": [settings.usageSharing.route],
  "/local/learn/toggle": [settings.lessons.route],
  "/local/project-mark/pick": [main.projects.route],
  "/local/roots/remove": [main.projects.route],
  "/local/worklist/*": [main.worklist.route],
  "/local/graph/*": [code.graphState.route, settings.graphInstall.route],
  "/local/git/*": GIT,
  "/local/update": [rail.update.route],
  "/local/project/settings": [main.projects.route, code.graphState.route, settings.projectSettings.route],
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
export function readWith(get: (url: string) => Promise<unknown>): void {
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
        if (poll && st?.status === "success" && !st.isInvalidated && Date.now() - last < poll.ms / 2)
          return Promise.resolve(st.data);
        if (poll) lastFetch.set(queryHash, Date.now());
        const extra = (meta?.extra as (() => Params) | undefined)?.();
        return get(urlOf(route, { ...params, ...extra }));
      },
    },
  });
}

/** Read a key (or every key under a route) again now. A read already on its way is the
 *  answer: it started after whatever changed. */
export const reread = (queryKey: readonly unknown[]) =>
  queryClient.invalidateQueries({ queryKey }, { cancelRefetch: false });

/** A successful POST to `path`: its reads go stale and refetch where they're shown. */
export function posted(path: string): void {
  for (const route of changedBy(path)) void queryClient.invalidateQueries({ queryKey: [route] });
}
