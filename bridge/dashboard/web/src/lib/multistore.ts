// Multi-agent chats, the half that talks to the bridge (lib/multi is the pure half).
// One read of the EXPERIMENTAL switch and one tree poll, however many readers: the
// shape of lib/integrations. Off means off: with the switch off, or on a bridge
// too old to know it (these routes 404, and that reads as off plus a "restart
// the bridge" in Settings), the only request this file ever makes is the switch's
// own, and nothing it feeds draws.
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { req, type SessionBrief } from "../api";
import { DEFAULT_CONFIG, treeIds, type AgentRow, type ChannelMessage, type ChannelView, type HelperConfig } from "./multi";

export interface Experimental {
  loaded: boolean;
  enabled: boolean;
  defaults: HelperConfig;
  /** This bridge has no such route: older code, so a restart is the fix. */
  stale: boolean;
}

const isGone = (e: unknown) => e instanceof Error && /^(not found|HTTP 404)$/i.test(e.message);
const isOff = (e: unknown) => e instanceof Error && /experimental features are off/i.test(e.message);

let exp: Experimental = { loaded: false, enabled: false, defaults: DEFAULT_CONFIG, stale: false };
let expStarted = false;
const expSubs = new Set<() => void>();

function publishExp(next: Experimental): void {
  const was = exp;
  exp = next;
  expSubs.forEach((fn) => fn());
  if (was.enabled !== next.enabled) wakeTree();
}

export async function refreshExperimental(): Promise<void> {
  try {
    const d = await req<{ enabled: boolean; defaults: HelperConfig }>("/local/experimental");
    publishExp({ loaded: true, enabled: d.enabled === true, defaults: { ...DEFAULT_CONFIG, ...d.defaults }, stale: false });
  } catch (e) {
    if (isGone(e)) publishExp({ ...exp, loaded: true, enabled: false, stale: true });
    else if (!exp.loaded) publishExp({ ...exp, loaded: true });
    /* any other failure keeps the last answer: a blip shouldn't redraw the app */
  }
}

/** POST /local/experimental: the switch, the defaults, or both. Throws so the row can say why. */
export async function setExperimental(patch: { enabled?: boolean; defaults?: Partial<HelperConfig> }): Promise<void> {
  const d = await req<{ enabled: boolean; defaults: HelperConfig }>("/local/experimental", { method: "POST", body: patch });
  publishExp({ loaded: true, enabled: d.enabled === true, defaults: { ...DEFAULT_CONFIG, ...d.defaults }, stale: false });
}

function subscribeExp(fn: () => void): () => void {
  expSubs.add(fn);
  if (!expStarted) {
    expStarted = true;
    void refreshExperimental();
    // Another surface can flip it; the 60 s and the return to the tab catch that.
    window.setInterval(() => { if (!document.hidden) void refreshExperimental(); }, 60_000);
    window.addEventListener("focus", () => void refreshExperimental());
  }
  return () => { expSubs.delete(fn); };
}

export const useExperimental = (): Experimental => useSyncExternalStore(subscribeExp, () => exp);
export const useMultiOn = (): boolean => useExperimental().enabled;

/** A multi-agent call. A 409 "they're off" means another surface turned them off
 *  since this page last looked: re-read, so the UI goes away with the error. */
async function call<T>(path: string, body?: unknown): Promise<T> {
  try {
    return await req<T>(`/local/${path}`, body === undefined ? {} : { method: "POST", body });
  } catch (e) {
    if (isOff(e) || isGone(e)) void refreshExperimental();
    throw e;
  }
}

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
  channel: (session: string) => call<ChannelView>(`channel?session=${q(session)}`),
  brief: (session: string) => call<{ session: SessionBrief }>(`session/brief?session=${q(session)}`),
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
  handoff: (session: string, profile: string) => call<HandoffPreview>(`session/handoff?session=${q(session)}&profile=${q(profile)}`),
  mcpShare: (cwd?: string | null) =>
    call<{ servers: McpShareRow[]; agents: string[] }>(`mcp-share${cwd ? `?cwd=${q(cwd)}` : ""}`),
  mcpSet: (body: { name: string; agent?: string; tool?: string; on: boolean; cwd?: string | null }) =>
    call<{ ok: boolean }>("mcp-share", body),
  mcpTools: (name: string, cwd?: string | null) => call<{ tools: McpTool[] }>("mcp-share/tools", { name, cwd }),
  mcpLogin: (name: string, cwd?: string | null) => call<{ url: string }>("mcp-share/login", { name, cwd }),
  mcpLogout: (name: string, cwd?: string | null) => call<{ ok: boolean }>("mcp-share/logout", { name, cwd }),
  skillShare: (cwd?: string | null) => call<{ skills: SkillShareRow[] }>(`skill-share${cwd ? `?cwd=${q(cwd)}` : ""}`),
  skillSet: (key: string, on: boolean, cwd?: string | null) =>
    call<{ ok: boolean; skills: SkillShareRow[] }>("skill-share", { key, on, cwd }),
  projectHelper: (project: string, profile_id: string) => call<{ ok: boolean }>("project/helper", { project, profile_id }),
};

// ---- the tree ----------------------------------------------------------------
// Everyone who wants a chat's agents says so under their own key; one 3 s poll asks
// for the union while the switch is on and the tab is showing. The open chat goes
// first, so the 40-chat ceiling (bridge/agent_tree.py MAX_IDS) never cuts it.

const TREE_MS = 3000;
const EMPTY: AgentRow[] = [];
let rowsByChat = new Map<string, AgentRow[]>();
let rawByChat = new Map<string, string>();
const memberRows = new Map<string, AgentRow>();
const treeSubs = new Set<() => void>();
const wants = new Map<string, { first: boolean; ids: string[] }>();
let treeTimer = 0;
let treeBusy = false;

async function pollTree(): Promise<void> {
  if (treeBusy || !exp.enabled || document.hidden) return;
  const all = [...wants.values()];
  const ids = treeIds(all.filter((w) => w.first).flatMap((w) => w.ids), all.filter((w) => !w.first).flatMap((w) => w.ids));
  if (!ids.length) return;
  treeBusy = true;
  try {
    const { trees } = await call<{ trees: Record<string, AgentRow[]> }>(`tree?ids=${ids.map(q).join(",")}`);
    let changed = false;
    const next = new Map(rowsByChat);
    for (const id of ids) {
      const rows = trees[id] ?? EMPTY;
      const raw = JSON.stringify(rows);
      if (rawByChat.get(id) === raw) continue;
      rawByChat.set(id, raw);
      next.set(id, rows);
      for (const r of rows) if (r.kind === "member" && r.session_id) memberRows.set(r.session_id, r);
      changed = true;
    }
    if (changed) { rowsByChat = next; treeSubs.forEach((fn) => fn()); }
  } catch { /* keep the last rows: a blip shouldn't empty the sidebar */ }
  finally { treeBusy = false; }
}

function wakeTree(): void {
  const live = exp.enabled && wants.size > 0;
  if (live && !treeTimer) {
    treeTimer = window.setInterval(() => void pollTree(), TREE_MS);
    void pollTree();
  } else if (!live && treeTimer) {
    window.clearInterval(treeTimer);
    treeTimer = 0;
  }
}

/** Ask for these chats' agents while mounted. `first`: the open chat's, never cut. */
export function useTreeWant(key: string, ids: string[], first = false): void {
  const joined = ids.join(",");
  useEffect(() => {
    if (!joined) { wants.delete(key); wakeTree(); return; }
    wants.set(key, { first, ids: joined.split(",") });
    wakeTree();
    void pollTree();
    return () => { wants.delete(key); wakeTree(); };
  }, [key, joined, first]);
}

const subscribeTree = (fn: () => void) => { treeSubs.add(fn); return () => { treeSubs.delete(fn); }; };

export function useTreeRows(chatId: string | null | undefined): AgentRow[] {
  return useSyncExternalStore(subscribeTree, () => (chatId ? rowsByChat.get(chatId) ?? EMPTY : EMPTY));
}

/** A helper's live row, wherever its chat is: a transcript's delegation row reads it. */
export function useMemberRow(sessionId: string | undefined): AgentRow | undefined {
  return useSyncExternalStore(subscribeTree, () => (sessionId ? memberRows.get(sessionId) : undefined));
}

// ---- the channel -------------------------------------------------------------

const CHANNEL_MS = 2000;

/** The grid's feed: polled while mounted. An error keeps the last good view on
 *  screen and says so, and a chat you've left drops its answer. */
export function useChannel(sessionId: string | null | undefined) {
  const [data, setData] = useState<ChannelView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const seq = useRef(0);
  const refresh = useCallback(async () => {
    if (!sessionId) return;
    const mine = ++seq.current;
    try {
      const d = await multi.channel(sessionId);
      if (mine !== seq.current) return;
      setData(d);
      setError(null);
    } catch (e) {
      if (mine === seq.current) setError((e as Error).message);
    } finally {
      if (mine === seq.current) setLoading(false);
    }
  }, [sessionId]);
  useEffect(() => {
    setData(null);
    setError(null);
    setLoading(true);
    void refresh();
    const id = window.setInterval(() => { if (!document.hidden) void refresh(); }, CHANNEL_MS);
    return () => { window.clearInterval(id); seq.current++; };
  }, [refresh]);
  return { data, error, loading, refresh, patch: setData };
}

// ---- an open helper ----------------------------------------------------------

/** The brief of a session the list left out because it's a helper, by id alone (a
 *  notification, a delegation row). A session the list misses for any other reason
 *  (old, archived) has no parent and gets no more requests. */
export function useHelperBrief(sessionId: string | null, sessions: SessionBrief[], on: boolean): SessionBrief | null {
  const [brief, setBrief] = useState<SessionBrief | null>(null);
  const listed = !sessionId || sessions.some((s) => s.id === sessionId);
  useEffect(() => {
    setBrief(null);
    if (!on || listed || !sessionId) return;
    let live = true, t = 0;
    const read = async () => {
      try {
        const d = await multi.brief(sessionId);
        if (!live) return;
        if (!d.session.parent_session) return;   // its own chat: no helper, nothing to follow
        setBrief(d.session);
      } catch { /* the next read, or nothing to show */ }
      if (live) t = window.setTimeout(read, TREE_MS);
    };
    void read();
    return () => { live = false; window.clearTimeout(t); };
  }, [sessionId, listed, on]);
  return listed ? null : brief;
}
