import { useQuery } from "@tanstack/react-query";
import { api } from "../../lib/api";
import type { HookRow, ToolScope } from "../../lib/agenttools";
import { providerName } from "../../lib/multi";
import { Empty, Fail, Loading } from "./parts";

/* HOOKS: read only, by design. A hook is a shell command that runs on every matching tool
   call, so POST /api/hooks answers 403 on this server. Nothing here would be able to write,
   and nothing pretends it can. Rules are the phone's way to change what agents may do. */

function Hook({ h }: { h: HookRow }) {
  return (
    <div className="px-3 py-2.5">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
        <span className="atv-agent break-all">{h.event}</span>
        {h.can_block && <span className="atv-tag" data-state="login">can block</span>}
      </div>
      <div className="atv-sub">
        {providerName(h.agent)} · {h.scope === "project" ? "this project" : "all projects"}
        {h.matcher ? ` · matches ${h.matcher}` : ""}
        {h.timeout ? ` · ${h.timeout}s` : ""}
        {h.type !== "command" ? ` · ${h.type}` : ""}
      </div>
      <pre className="atv-cmd"><code>{h.command}</code></pre>
    </div>
  );
}

export function HooksPane({ scope }: { scope: ToolScope }) {
  const q = useQuery({ queryKey: ["at-hooks", scope.session, scope.project], queryFn: () => api.hooks(scope) });
  return (
    <div className="space-y-4">
      <div className="atv-banner">
        <div className="atv-agent">Change hooks on the dashboard</div>
        <div className="atv-sub">A hook is a shell command that runs on the machine, so this screen only shows them. To change what agents may do from here, use Rules.</div>
      </div>
      {q.isLoading ? <Loading what="hooks" />
        : !q.data ? <Fail error={q.error} onRetry={() => void q.refetch()} />
        : (
          <>
            <div className="space-y-1.5">
              <div className="sset-head">Yours</div>
              {q.data.hooks.length
                ? <div className="sset">{q.data.hooks.map((h) => <Hook key={h.id} h={h} />)}</div>
                : <Empty>you have no hooks of your own here.</Empty>}
            </div>
            <div className="space-y-1.5">
              <div className="sset-head">Mystical's own</div>
              <div className="sset">
                {q.data.own.map((o) => (
                  <div key={`${o.name}|${o.event}`} className="px-3 py-2.5">
                    <div className="atv-agent break-words">{o.name}</div>
                    <div className="atv-sub">{o.event} · {o.agent === "claude" ? "Claude" : o.agent}</div>
                    <div className="atv-sub mt-0.5">{o.about}</div>
                  </div>
                ))}
              </div>
            </div>
          </>
        )}
    </div>
  );
}
