import { createRoute, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { ArrowRight } from "lucide-react";
import { rootRoute } from "./root";
import { api, type Issue } from "../lib/api";
import { useChat } from "../lib/chat";

/** Compose a prompt that hands a GitHub issue to Claude. */
function issuePrompt(i: Issue): string {
  return `Work on GitHub issue #${i.number}: ${i.title}\n\n${
    i.body?.trim() || "(no description provided)"
  }\n\n${i.url}`;
}

function IssuesPage() {
  const navigate = useNavigate();
  const { setDraft } = useChat();
  const { data } = useQuery({
    queryKey: ["issues"],
    queryFn: () => api.getIssues(),
    refetchInterval: 60000,
  });

  // Prefill the composer with the issue and jump to the Run tab to review/send.
  function feed(i: Issue) {
    setDraft(issuePrompt(i));
    void navigate({ to: "/" });
  }

  if (data && !data.has_remote)
    return (
      <div className="pt-10 text-center text-sm text-[var(--tg-hint)]">No GitHub remote.</div>
    );
  if (data && !data.gh_ok)
    return (
      <div className="pt-10 text-center text-sm text-[var(--tg-hint)]">
        GitHub CLI unavailable.
        {data.error ? (
          <div className="mt-1 font-mono text-[11px] text-[var(--tg-hint)]">{data.error}</div>
        ) : null}
      </div>
    );

  return (
    <div className="space-y-3 pb-24">
      <div className="flex gap-3 px-1 font-mono text-xs">
        <span className="text-[var(--brand-soft)]">● {data?.open_count ?? 0} open</span>
        <span className="text-[var(--tg-hint)]">✓ {data?.closed_count ?? 0} closed</span>
      </div>

      {data?.issues.map((i) => (
        <div
          key={i.number}
          className="rounded-2xl border border-[var(--border)] bg-[var(--tg-secondary-bg)] p-3"
        >
          <a
            href={i.url}
            target="_blank"
            rel="noreferrer"
            className="block text-sm leading-snug"
          >
            {i.title}
          </a>
          <div className="mt-1.5 flex flex-wrap items-center gap-2">
            <span className="font-mono text-[10.5px] text-[var(--tg-hint)]">#{i.number}</span>
            {i.labels.map((l) => (
              <span
                key={l.name}
                className="rounded-full px-2 text-[10px]"
                style={{
                  color: `#${l.color}`,
                  background: `#${l.color}22`,
                  border: `1px solid #${l.color}55`,
                }}
              >
                {l.name}
              </span>
            ))}
          </div>
          <button
            onClick={() => feed(i)}
            className="mt-2.5 flex items-center gap-1.5 rounded-lg bg-[var(--tg-button)] px-3 py-1.5 text-xs text-[var(--tg-button-text)] active:opacity-70"
          >
            <ArrowRight size={13} aria-hidden />
            Feed to Claude
          </button>
        </div>
      ))}

      {data && data.issues.length === 0 && (
        <div className="pt-10 text-center text-sm text-[var(--tg-hint)]">No open issues.</div>
      )}
    </div>
  );
}

export const issuesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/issues",
  component: IssuesPage,
});
