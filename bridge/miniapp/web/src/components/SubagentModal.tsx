import { useQuery } from "@tanstack/react-query";
import { api, type TreeRow } from "../lib/api";
import { Banner, Skeleton } from "./ui";
import { AgentsModal } from "./AgentsModal";

/** AgentsModal opened on one row of the agent tree. The modal wants the session's
 *  whole list, which the tree doesn't carry, and a workflow's agents need their run
 *  named to be read. The owner may be a helper, so the row says whose it is. */
export function SubagentModal({ row, onClose }: { row: TreeRow; onClose: () => void }) {
  const sid = row.session_id as string;
  const q = useQuery({ queryKey: ["agents", sid], queryFn: () => api.agents(sid) });
  if (!q.data) {
    return (
      <div className="fixed inset-0 z-50 space-y-2 bg-[var(--tg-bg)] p-4" onClick={onClose}>
        {q.isError ? <Banner tone="error">Couldn't read this agent. Tap to go back.</Banner>
          : <><Skeleton className="h-10 w-full" /><Skeleton className="h-10 w-2/3" /></>}
      </div>
    );
  }
  const flows = q.data.workflows ?? [];
  const workflowOf: Record<string, string> = {};
  for (const w of flows) for (const a of w.agents) workflowOf[a.agent_id] = w.run_id;
  return (
    <AgentsModal
      sessionId={sid}
      agents={[...q.data.agents, ...flows.flatMap((w) => w.agents)]}
      initial={row.agent_id}
      workflowOf={workflowOf}
      onClose={onClose}
    />
  );
}
