// Multi-agent chats, the half that talks to the bridge (lib/multi is the pure half).
// Every read here is a lib/queries read (main.experimental, tree, channel, brief), so one
// request answers every reader. Off means off: with the switch off, or on a bridge too old to
// know it (these routes 404, and that reads as off plus a "restart the bridge" in Settings),
// the only request this file ever makes is the switch's own, and nothing it feeds draws.
import { useEffect, useMemo, useSyncExternalStore } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { req, type SessionBrief } from "../api";
import { DEFAULT_CONFIG, treeIds, type AgentRow, type ChannelView, type ChannelMessage, type HelperConfig } from "./multi";
import { fetchFresh, main, queryClient, reread } from "./queries";

export interface Experimental {
  loaded: boolean;
  enabled: boolean;
  defaults: HelperConfig;
  /** This bridge has no such route: older code, so a restart is the fix. */
  stale: boolean;
}

const isGone = (e: unknown) => e instanceof Error && /^(not found|HTTP 404)$/i.test(e.message);
const isOff = (e: unknown) => e instanceof Error && /experimental features are off/i.test(e.message);

const refreshExperimental = () => reread(main.experimental().queryKey);

/** POST /local/experimental: the switch, the defaults, or both. Throws so the row can say why;
 *  the switch's read refetches on its success (lib/queries CHANGES). */
export async function setExperimental(patch: { enabled?: boolean; defaults?: Partial<HelperConfig> }): Promise<void> {
  await req("/local/experimental", { method: "POST", body: patch });
}

/** The switch, polled once a minute (another surface can flip it). A failed read keeps the
 *  last answer: a blip shouldn't redraw the app. */
export function useExperimental(): Experimental {
  const { data, error, isError } = useQuery(main.experimental());
  return useMemo(() => {
    const defaults = { ...DEFAULT_CONFIG, ...data?.defaults };
    if (isGone(error)) return { loaded: true, enabled: false, defaults, stale: true };
    return { loaded: !!data || isError, enabled: data?.enabled === true, defaults, stale: false };
  }, [data, error, isError]);
}

/** The switch alone, for the many readers (every Markdown block): they read the one answer
 *  useExperimental polls (App holds it), and add no timer and no read on mount. */
export const useMultiOn = (): boolean =>
  useQuery({ ...main.experimental(), refetchInterval: false, staleTime: Infinity }).data?.enabled === true;

/** A failed multi-agent read that says they're off (409) or gone (404): re-read the switch, so
 *  the UI goes away with the error. */
function useOffCheck(e: Error | null): void {
  useEffect(() => { if (isOff(e) || isGone(e)) void refreshExperimental(); }, [e]);
}

/** A multi-agent call. A 409 "they're off" means another surface turned them off
 *  since this page last looked: re-read, so the UI goes away with the error. */
export async function multiCall<T>(path: string, body?: unknown): Promise<T> {
  try {
    return await req<T>(`/local/${path}`, body === undefined ? {} : { method: "POST", body });
  } catch (e) {
    if (isOff(e) || isGone(e)) void refreshExperimental();
    throw e;
  }
}

const call = multiCall;
/** A multi-agent read through the client (lib/queries), with multiCall's off check. */
const read = <T>(p: Promise<T>): Promise<T> =>
  p.catch((e) => { if (isOff(e) || isGone(e)) void refreshExperimental(); throw e; });
const q = (v: string) => encodeURIComponent(v);

export interface McpTool { name: string; sensitive: boolean; on: boolean }
export interface McpShareRow {
  name: string; home: string; transport: string; known: boolean; holds_key: boolean;
  needs_login: boolean; logged_in: boolean; agents: Record<string, boolean>; tools: McpTool[] | null;
}
export interface SkillShareRow {
  key: string; name: string; scope: string; home: string; claude_only: boolean; conflict: boolean; on: boolean;
}
export interface HandoffPreview {
  needs_dialog: boolean; from: string; to: string; resumes: boolean; turns: number; tokens: number;
  with_tools: number; budget: number; fits: boolean; recent: number; refusal: string | null;
}

export const multi = {
  brief: (session: string) => read(fetchFresh(main.brief({ session }))),
  projectHelperOf: (project: string) => call<{ profile_id: string }>(`project/helper?project=${q(project)}`),
  send: (session_id: string, to: string, text: string) =>
    call<{ ok: boolean; message: ChannelMessage }>("channel/send", { session_id, to, text }),
  hold: (session_id: string, held: boolean) => call<{ ok: boolean; config: HelperConfig }>("channel/hold", { session_id, held }),
  edit: (session_id: string, id: string, patch: { body?: string; drop?: boolean }) =>
    call<{ ok: boolean }>("channel/edit", { session_id, id, ...patch }),
  stopAll: (session_id: string) => call<{ ok: boolean; stopped: number }>("channel/stop", { session_id }),
  merge: (session_id: string, name: string, action: string) =>
    call<{ ok: boolean; text: string }>("channel/merge", { session_id, name, action }),
  chatConfig: (session_id: string, config: Partial<HelperConfig>) =>
    call<{ ok: boolean; config: HelperConfig }>("chat/config", { session_id, config }),
  handoff: (session: string, profile: string) => read(fetchFresh(main.handoff({ session, profile }))),
  mcpShare: (cwd?: string | null) =>
    call<{ servers: McpShareRow[]; agents: string[] }>(`mcp-share${cwd ? `?cwd=${q(cwd)}` : ""}`),
  mcpSet: (body: { name: string; agent?: string; tool?: string; on: boolean; cwd?: string | null }) =>
    call<{ ok: boolean }>("mcp-share", body),
  mcpTools: (name: string, cwd?: string | null) => call<{ tools: McpTool[] }>("mcp-share/tools", { name, cwd }),
  mcpLogin: (name: string, cwd?: string | null) => call<{ url: string }>("mcp-share/login", { name, cwd }),
  mcpLogout: (name: string, cwd?: string | null) => call<{ ok: boolean }>("mcp-share/logout", { name, cwd }),
  skillShare: (cwd?: string | null) => read(fetchFresh(main.skillShare({ cwd: cwd || undefined }))),
  skillSet: (key: string, on: boolean, cwd?: string | null) =>
    call<{ ok: boolean; skills: SkillShareRow[] }>("skill-share", { key, on, cwd }),
  projectHelper: (project: string, profile_id: string) => call<{ ok: boolean }>("project/helper", { project, profile_id }),
};

// ---- the tree ----------------------------------------------------------------
// Everyone who wants a chat's agents says so under their own key; one read asks for the union
// every 3 s while the switch is on and the tab is showing. The open chat goes first, so the
// 40-chat ceiling (bridge/agent_tree.py MAX_IDS) never cuts it. The registry holds only who
// wants what; the answer lives in the query cache.

const EMPTY: AgentRow[] = [];
const wants = new Map<string, { first: boolean; ids: string[] }>();
let wanted = "";
const wantSubs = new Set<() => void>();

function rewant(): void {
  const all = [...wants.values()];
  const next = treeIds(all.filter((w) => w.first).flatMap((w) => w.ids), all.filter((w) => !w.first).flatMap((w) => w.ids)).join(",");
  if (next !== wanted) { wanted = next; wantSubs.forEach((fn) => fn()); }
}

const subscribeWants = (fn: () => void) => { wantSubs.add(fn); return () => { wantSubs.delete(fn); }; };

/** Ask for these chats' agents while mounted. `first`: the open chat's, never cut. */
export function useTreeWant(key: string, ids: string[], first = false): void {
  const joined = ids.join(",");
  useEffect(() => {
    if (joined) wants.set(key, { first, ids: joined.split(",") }); else wants.delete(key);
    rewant();
    return () => { wants.delete(key); rewant(); };
  }, [key, joined, first]);
}

type Trees = { trees: Record<string, AgentRow[]> };

/** The union's answer, through `pick`. A new union keeps the last answer on screen while its
 *  read is on the way, and a failed read keeps it too: a blip shouldn't empty the sidebar. */
function useTree<T>(pick: (d: Trees) => T): T | undefined {
  const on = useMultiOn();
  const ids = useSyncExternalStore(subscribeWants, () => wanted);
  const q = useQuery({ ...main.tree({ ids }), enabled: on && !!ids, placeholderData: keepPreviousData, select: pick });
  useOffCheck(q.error);
  return on ? q.data : undefined;
}

export function useTreeRows(chatId: string | null | undefined): AgentRow[] {
  return useTree((d) => (chatId ? d.trees[chatId] ?? EMPTY : EMPTY)) ?? EMPTY;
}

/** A helper's live row, wherever its chat is: a transcript's delegation row reads it. */
export function useMemberRow(sessionId: string | undefined): AgentRow | undefined {
  return useTree((d) => {
    if (!sessionId) return undefined;
    for (const rows of Object.values(d.trees)) for (const r of rows) if (r.kind === "member" && r.session_id === sessionId) return r;
    return undefined;
  });
}

// ---- the channel -------------------------------------------------------------

/** The grid's feed: polled while mounted. An error keeps the last good view on
 *  screen and says so, and a chat you've left drops its answer (its own key). */
export function useChannel(sessionId: string | null | undefined) {
  const o = main.channel({ session: sessionId ?? "" });
  const q = useQuery({ ...o, enabled: !!sessionId });
  useOffCheck(q.error);
  return {
    data: q.data ?? null,
    error: q.error ? q.error.message : null,
    loading: q.isPending,
    refresh: () => reread(o.queryKey),
    patch: (v: ChannelView) => { queryClient.setQueryData(o.queryKey, v); },
  };
}

// ---- an open helper ----------------------------------------------------------

/** The brief of a session the list left out because it's a helper, by id alone (a
 *  notification, a delegation row), followed every 3 s. A session the list misses for any
 *  other reason (old, archived) has no parent and gets no more requests. */
export function useHelperBrief(sessionId: string | null, sessions: SessionBrief[], on: boolean): SessionBrief | null {
  const listed = !sessionId || sessions.some((s) => s.id === sessionId);
  const q = useQuery({
    ...main.brief({ session: sessionId ?? "" }), enabled: on && !listed,
    refetchInterval: (query) => (query.state.data && !query.state.data.session.parent_session ? false : main.brief.poll?.ms),
  });
  useOffCheck(q.error);
  const b = q.data?.session;
  return listed || !b?.parent_session ? null : b;
}
