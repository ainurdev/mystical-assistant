import { useState } from "react";
import { createRoute, useNavigate } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, RefreshCw, X } from "lucide-react";
import { rootRoute } from "./root";
import { api, type Issue, type NextUpItem, type QueueSnapshot } from "../lib/api";
import { useChat } from "../lib/chat";
import { Skeleton } from "../components/ui";

/* WORK — everything you could hand Claude next, in one tab: prompts already
   queued, the ranked next steps the scout found, and the repo's open issues.
   All three end the same way — text in a chat — so they share a screen. */

type Tab = "queue" | "next" | "issues";

function ago(sec: number | null | undefined): string {
  if (!sec) return "";
  const s = Math.max(0, Date.now() / 1000 - sec);
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

const btnGhost =
  "flex items-center justify-center border border-border-bright/70 px-2.5 py-2 text-[9px] tracking-[1.5px] text-[var(--brand-soft)] active:opacity-70 disabled:opacity-40";

function WorkPage() {
  const [tab, setTab] = useState<Tab>("queue");
  const queues = useQuery({
    queryKey: ["queues"],
    queryFn: () => api.getQueues(),
    refetchInterval: 5000,
  });
  const issues = useQuery({
    queryKey: ["issues"],
    queryFn: () => api.getIssues(),
    refetchInterval: 60000,
  });
  const queued = (queues.data?.queues ?? []).reduce(
    (n, q) => n + q.items.filter((i) => i.status === "queued").length,
    0,
  );

  const TABS: { id: Tab; label: string }[] = [
    { id: "queue", label: `QUEUE${queued ? ` · ${queued}` : ""}` },
    { id: "next", label: "NEXT UP" },
    { id: "issues", label: `ISSUES${issues.data?.open_count ? ` · ${issues.data.open_count}` : ""}` },
  ];

  return (
    <div className="space-y-3 pb-6">
      <div className="flex items-baseline gap-2.5">
        <span className="text-[13px] tracking-[3px] text-foreground-bright">WORK</span>
        <span className="text-[10px] tracking-wider text-[var(--tg-hint)]">
          FEED CLAUDE FROM ANYWHERE
        </span>
      </div>

      <div className="flex">
        {TABS.map((t, i) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`flex-1 border py-2.5 text-center text-[10px] tracking-[2px] active:opacity-70 ${
              i > 0 ? "border-l-0" : ""
            } ${
              tab === t.id
                ? "border-border-bright bg-[var(--ac-06)] text-foreground-bright"
                : "border-border text-[var(--tg-hint)]"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === "queue" && <QueueTab queues={queues.data?.queues ?? []} loading={queues.isLoading} />}
      {tab === "next" && <NextUpTab />}
      {tab === "issues" && <IssuesTab />}
    </div>
  );
}

/* ---------------------------------- QUEUE --------------------------------- */

function QueueTab({ queues, loading }: { queues: QueueSnapshot[]; loading: boolean }) {
  const qc = useQueryClient();
  const { sessionId, sessions, model, effort, perm } = useChat();
  const [text, setText] = useState("");
  const target = sessions.find((s) => s.id === sessionId);

  const refresh = () => qc.invalidateQueries({ queryKey: ["queues"] });

  async function add() {
    const prompt = text.trim();
    if (!prompt || !sessionId) return;
    setText("");
    try {
      await api.queueOp({
        op: "enqueue",
        session_id: sessionId,
        prompt,
        model,
        effort: effort || undefined,
        permission_mode: perm || undefined,
      });
    } catch {
      setText(prompt); // put it back rather than lose it
    }
    void refresh();
  }

  async function op(
    o: "remove" | "bump" | "resume" | "clear_done",
    session_id: string,
    item_id?: string,
  ) {
    try {
      await api.queueOp({ op: o, session_id, item_id });
    } catch {
      /* the poll reconciles */
    }
    void refresh();
  }

  // Flat list across chats — the queue is per session, but you think about it as
  // one pile of prompts waiting their turn.
  const rows = queues.flatMap((q) => q.items.map((it) => ({ q, it })));
  const pending = rows.filter((r) => r.it.status === "queued");

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 border border-input py-1 pl-3 pr-1">
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void add();
            }
          }}
          placeholder="Queue a task…"
          className="min-w-0 flex-1 bg-transparent py-1.5 text-sm outline-none placeholder:text-[var(--tg-hint)]"
        />
        <span className="shrink-0 truncate border border-border px-2 py-1 text-[9px] tracking-wider text-[var(--brand-soft)]">
          {(target?.title || target?.project || "NO CHAT").toUpperCase()}
        </span>
        <button
          onClick={() => void add()}
          disabled={!text.trim() || !sessionId}
          aria-label="Queue"
          className="flex h-9 w-9 shrink-0 items-center justify-center bg-[var(--tg-button)] text-lg text-[var(--tg-button-text)] active:opacity-70 disabled:opacity-40"
        >
          +
        </button>
      </div>
      <div className="px-0.5 text-[10px] tracking-wide text-[var(--muted-2)]">
        QUEUED PROMPTS SEND WHEN THEIR CHAT FREES UP
      </div>

      {loading ? (
        <Skeleton className="h-16 w-full" />
      ) : rows.length === 0 ? (
        <div className="pt-8 text-center text-sm text-[var(--tg-hint)]">
          Nothing queued. Type above while a run is going.
        </div>
      ) : (
        rows.map(({ q, it }) => {
          const done = it.status === "done" || it.status === "failed";
          return (
            <div
              key={it.id}
              className={`flex items-center gap-2.5 border px-3 py-2.5 ${
                done ? "border-border/50 bg-[var(--card)] opacity-60" : "border-border bg-[var(--tg-secondary-bg)]"
              }`}
            >
              <span className="flex h-4 w-4 shrink-0 items-center justify-center border border-border-bright">
                {done && <Check size={10} className="text-[var(--brand-soft)]" aria-hidden />}
              </span>
              <span className="min-w-0 flex-1">
                <span className={`block text-[13px] leading-snug ${done ? "line-through text-[var(--tg-hint)]" : ""}`}>
                  {it.text}
                </span>
                <span className="mt-0.5 block truncate text-[9.5px] tracking-wider text-[var(--brand-soft)]">
                  {(q.title || q.project || "CHAT").toUpperCase()}
                  {it.status === "running" && <span className="text-amber-400"> · RUNNING</span>}
                  {it.status === "queued" && q.paused && <span className="text-amber-400"> · PAUSED</span>}
                  {it.status === "queued" && !q.paused && (
                    <span className="text-amber-400"> · WAITING FOR RUN TO END</span>
                  )}
                  {done && (
                    <span className="text-[var(--muted-2)]">
                      {" "}
                      · {it.status === "failed" ? "FAILED" : "SENT"} {ago(it.started).toUpperCase()}
                    </span>
                  )}
                </span>
              </span>
              {it.status === "queued" && (
                <button onClick={() => void op("bump", q.session_id, it.id)} className={btnGhost}>
                  SEND NOW
                </button>
              )}
              {it.status !== "running" && (
                <button
                  onClick={() => void op("remove", q.session_id, it.id)}
                  aria-label="Remove"
                  className="shrink-0 p-1 text-[var(--tg-hint)] active:opacity-70"
                >
                  <X size={14} aria-hidden />
                </button>
              )}
            </div>
          );
        })
      )}

      {pending.length > 0 && (
        <button
          onClick={() => {
            for (const sid of new Set(pending.map((r) => r.q.session_id))) void op("resume", sid);
          }}
          className="flex w-full items-center justify-center bg-[var(--tg-button)] py-3 text-[11px] font-medium tracking-[2px] text-[var(--tg-button-text)] shadow-[0_0_18px_var(--brand-glow)] active:opacity-70"
        >
          FEED ALL · {pending.length}
        </button>
      )}
    </div>
  );
}

/* --------------------------------- NEXT UP -------------------------------- */

const EFFORT_DOTS: Record<string, string> = { small: "·", medium: "··", large: "···" };

function NextUpTab() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { setDraft } = useChat();
  const { data, isLoading } = useQuery({
    queryKey: ["nextup"],
    queryFn: () => api.getNextUp(),
    refetchInterval: (q) => (q.state.data?.refreshing ? 4000 : false),
  });

  function start(item: NextUpItem) {
    setDraft(item.prompt);
    void navigate({ to: "/" });
  }

  if (isLoading) return <Skeleton className="h-24 w-full" />;
  if (data && !data.enabled)
    return (
      <div className="pt-8 text-center text-sm text-[var(--tg-hint)]">
        NEXT UP is off. Turn it on in the dashboard's AI features.
      </div>
    );

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 px-0.5">
        <span className="text-[9px] tracking-wider text-[var(--muted-2)]">
          {data?.repos.length ?? 0} REPOS
          {data?.generated ? ` · SCOUTED ${ago(data.generated).toUpperCase()}` : ""}
        </span>
        <button
          onClick={async () => {
            await api.refreshNextUp().catch(() => {});
            void qc.invalidateQueries({ queryKey: ["nextup"] });
          }}
          disabled={data?.refreshing}
          className="ml-auto flex items-center gap-1.5 border border-border px-2.5 py-1.5 text-[9px] tracking-[1.5px] text-[var(--tg-hint)] active:opacity-70 disabled:opacity-40"
        >
          <RefreshCw size={11} className={data?.refreshing ? "animate-spin" : ""} aria-hidden />
          {data?.refreshing ? "SCOUTING" : "REFRESH"}
        </button>
      </div>

      {(data?.items ?? []).length === 0 ? (
        <div className="pt-8 text-center text-sm text-[var(--tg-hint)]">
          Nothing scouted yet — hit refresh.
        </div>
      ) : (
        data?.items.map((item, i) => (
          <button
            key={item.id}
            onClick={() => start(item)}
            className={`block w-full p-3 text-left active:opacity-70 ${
              i === 0
                ? "panel border border-border-bright/70 bg-[var(--card)]"
                : "border border-border bg-[var(--tg-secondary-bg)]"
            }`}
          >
            <div className="flex items-center gap-2">
              <span className={`text-[9.5px] tracking-wider ${i === 0 ? "text-[var(--brand-soft)]" : "text-[var(--tg-hint)]"}`}>
                {String(i + 1).padStart(2, "0")}
              </span>
              <span className="truncate border border-border px-1.5 py-px text-[9px] tracking-wider text-[var(--brand-soft)]">
                {item.repo.toUpperCase()}
              </span>
              <span
                className="ml-auto text-[11px] tracking-[2px] text-[var(--tg-hint)]"
                title={`${item.effort} effort`}
              >
                {EFFORT_DOTS[item.effort] ?? "··"}
              </span>
            </div>
            <div className="mt-2 text-[13.5px] leading-snug text-foreground-bright">{item.title}</div>
            {item.why && (
              <div className="mt-1 text-[11px] leading-relaxed text-[var(--tg-hint)]">{item.why}</div>
            )}
            {i === 0 && (
              <div className="mt-2.5 flex items-center justify-center border border-border-bright py-2.5 text-[10px] tracking-[2px] text-[var(--brand-soft)]">
                START →
              </div>
            )}
          </button>
        ))
      )}
    </div>
  );
}

/* --------------------------------- ISSUES --------------------------------- */

/** Compose a prompt that hands a GitHub issue to Claude. */
function issuePrompt(i: Issue): string {
  return `Work on GitHub issue #${i.number}: ${i.title}\n\n${
    i.body?.trim() || "(no description provided)"
  }\n\n${i.url}`;
}

function IssuesTab() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { setDraft, sessionId, model, effort, perm } = useChat();
  const { data, isLoading } = useQuery({
    queryKey: ["issues"],
    queryFn: () => api.getIssues(),
    refetchInterval: 60000,
  });

  // Prefill the composer with the issue and jump to the chat to review/send.
  function feed(i: Issue) {
    setDraft(issuePrompt(i));
    void navigate({ to: "/" });
  }

  async function queue(i: Issue) {
    if (!sessionId) return;
    try {
      await api.queueOp({
        op: "enqueue",
        session_id: sessionId,
        prompt: issuePrompt(i),
        model,
        effort: effort || undefined,
        permission_mode: perm || undefined,
      });
      void qc.invalidateQueries({ queryKey: ["queues"] });
    } catch {
      /* nothing queued — the tab still shows the issue */
    }
  }

  if (isLoading) return <Skeleton className="h-24 w-full" />;
  if (data && !data.has_remote)
    return <div className="pt-8 text-center text-sm text-[var(--tg-hint)]">No GitHub remote.</div>;
  if (data && !data.gh_ok)
    return (
      <div className="pt-8 text-center text-sm text-[var(--tg-hint)]">
        GitHub CLI unavailable.
        {data.error ? <div className="mt-1 font-mono text-[11px]">{data.error}</div> : null}
      </div>
    );

  return (
    <div className="space-y-2">
      <div className="flex gap-3 px-0.5 text-[11px]">
        <span className="text-[var(--brand-soft)]">● {data?.open_count ?? 0} OPEN</span>
        <span className="text-[var(--tg-hint)]">✓ {data?.closed_count ?? 0} CLOSED</span>
        <span className="ml-auto truncate text-[var(--muted-2)]">{data?.slug}</span>
      </div>

      {data?.issues.map((i) => (
        <div key={i.number} className="border border-border bg-[var(--tg-secondary-bg)] p-3">
          <a href={i.url} target="_blank" rel="noreferrer" className="block text-[13.5px] leading-snug">
            {i.title}
          </a>
          <div className="mt-1.5 flex flex-wrap items-center gap-2">
            <span className="text-[10.5px] text-[var(--tg-hint)]">#{i.number}</span>
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
          <div className="mt-2.5 flex gap-2">
            <button
              onClick={() => feed(i)}
              className="flex flex-1 items-center justify-center gap-1.5 bg-[var(--tg-button)] py-2.5 text-[10px] tracking-[1.5px] text-[var(--tg-button-text)] active:opacity-70"
            >
              FEED TO CLAUDE →
            </button>
            <button onClick={() => void queue(i)} disabled={!sessionId} className={btnGhost}>
              ↥ QUEUE
            </button>
          </div>
        </div>
      ))}

      {data && data.issues.length === 0 && (
        <div className="pt-8 text-center text-sm text-[var(--tg-hint)]">No open issues.</div>
      )}
    </div>
  );
}

export const workRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/work",
  component: WorkPage,
});
