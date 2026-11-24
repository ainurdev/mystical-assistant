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
  AccountsInfo, AgentsInfo, DashState, FlowSettings, GitBadge, GitStatus, GraphState, HostStats,
  Notice, NoticePrefs, ProjectsListing, RunningInfo, SessionBrief, SlashCommand, Transcript, UpdateInfo,
} from "../api.ts";
import type { BranchStatus } from "./branchrows.ts";
import type { Flow, FlowSet, PastFlow } from "./flowview.ts";

export type Params = Record<string, string | number | boolean | null | undefined>;
export type Key = readonly [string, Params];
/** `ms`: how often it polls while someone shows it; `hidden`: it polls while the page is hidden too. */
export interface Poll { ms: number; hidden?: true }

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

/** Settings. */
export const settings = {
  flows: read<FlowSettings>("/local/flows"),
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
  "/local/flows": [settings.flows.route],
  "/local/worklist/*": [main.worklist.route],
  "/local/graph/*": [code.graphState.route],
  "/local/git/*": GIT,
  "/local/update": [rail.update.route],
  "/local/project/settings": [main.projects.route, code.graphState.route],
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
