// Agent Tools' calls: every route multi_api.py gives this page, through multistore's call,
// so a 409 or a stale bridge reads the way everything multi-agent reads. lib/agenttools
// holds the shapes and the logic.
import { multiCall as call } from "./multistore";
import { queryClient, settings, type Key } from "./queries";
import { hookBody, hookQuery, scopeBody, scopeQuery, type HookListing, type RuleFields, type RuleLogRow, type RuleRow, type Scope, type ToolGrid } from "./agenttools";
import { dirBody, dirQuery, type DirListing, type DirScope } from "./mysticaldir";

export type PolicySection = "mcp" | "tool" | "mystical";
export interface HookWrite {
  action: "add" | "edit" | "remove" | "copy";
  agent?: string; scope?: string; event?: string; matcher?: string; command?: string; timeout?: number | null; id?: string;
}

/** A read through the query client: panels asking the same thing at once share one request.
 *  Each caller re-reads after its own writes, so a read is never answered from the cache. */
const read = <T>(o: { queryKey: Key }, path: string) =>
  queryClient.fetchQuery({ queryKey: o.queryKey, queryFn: () => call<T>(path), staleTime: 0 }) as Promise<T>;

export const at = {
  grid: (s: Scope) => read<ToolGrid>(settings.agentTools(s), `agent-tools${scopeQuery(s)}`),
  pick: (s: Scope, section: PolicySection, name: string, agent: string, on: boolean | null) =>
    call<{ ok: boolean }>("tool-policy", { ...scopeBody(s), section, name, agent, on }),
  patterns: (s: Scope, patterns: string[]) => call<{ patterns: string[] }>("tool-policy/patterns", { ...scopeBody(s), patterns }),
  rules: (s: Scope) => read<{ rules: RuleRow[] }>(settings.rules(s), `rules${scopeQuery(s)}`),
  rule: (s: Scope, id: string, on: boolean | null, fields?: RuleFields) =>
    call<{ ok: boolean; rules: RuleRow[] }>("rules", { ...scopeBody(s), id, on, fields }),
  ruleLog: (session?: string | null) => read<{ rows: RuleLogRow[] }>(settings.ruleLog({ session: session || undefined }),
    `rules/log${session ? `?session=${encodeURIComponent(session)}` : ""}`),
  hooks: (s: Scope) => read<HookListing>(settings.hooks(s), `hooks${hookQuery(s)}`),
  hook: (s: Scope, w: HookWrite) => call<HookListing>("hooks", { ...hookBody(s), ...w }),
  dir: (scope: DirScope, sub = "") =>
    read<DirListing>(settings.mysticalDir({ ...scope, sub }), `mystical-dir${dirQuery(scope, sub ? { sub } : {})}`),
  dirRead: (scope: DirScope, path: string) =>
    read<{ text: string }>(settings.mysticalFile({ ...scope, path }), `mystical-dir/read${dirQuery(scope, { path })}`),
  dirDelete: (scope: DirScope, path: string, confirm: boolean) => call<{ ok: boolean }>("mystical-dir/delete", { ...dirBody(scope), path, confirm }),
  dirKeep: (scope: DirScope, path: string, on: boolean) => call<{ ok: boolean }>("mystical-dir/keep", { ...dirBody(scope), path, on }),
  dirClear: (scope: DirScope, days: number) => call<{ removed: number; freed: number }>("mystical-dir/clear", { ...dirBody(scope), days }),
};

/** "not found" and "HTTP 404" here mean this page is newer than the running bridge. */
export const isStaleBridge = (e: string | null | undefined) => !!e && /^(not found|HTTP 404)$/i.test(e);
