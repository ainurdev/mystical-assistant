import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createPortal } from "react-dom";
import { ArrowUp, ChevronRight, X } from "lucide-react";
import { api, ApiError, needsYou, type ChannelMessage, type ChannelView, type MergeAction, type TreeRow } from "../lib/api";
import { elapsedOf, fmtElapsed, isRunning, sortRows } from "../lib/agentrows";
import { useChat } from "../lib/chat";
import { providerName, useChannel } from "../lib/multi";
import { hhmm } from "../lib/utils";
import { agentDot } from "./AgentTree";
import { SubagentModal } from "./SubagentModal";
import { Banner, Skeleton } from "./ui";
import type { AgentTab } from "./AgentSwitch";

/* The grid, as a phone holds it: one column of agents, and the channel on a tab of
   its own (plan, section 6). The actions sit in a dock over the tab bar, where a
   thumb already is, and it stays put when you change tab, so what you typed does too.
   Stop and drop-the-work are two taps: a first one arms them. */

const ARM_MS = 3000;

/** A button that needs a second tap. */
function useArm() {
  const [armed, setArmed] = useState<string | null>(null);
  const t = useRef(0);
  useEffect(() => () => window.clearTimeout(t.current), []);
  return {
    armed,
    /** True when this tap is the second. */
    tap(key: string): boolean {
      window.clearTimeout(t.current);
      if (armed === key) { setArmed(null); return true; }
      setArmed(key);
      t.current = window.setTimeout(() => setArmed(null), ARM_MS);
      return false;
    },
  };
}

const errText = (e: unknown) => (e instanceof ApiError || e instanceof Error ? e.message : "That didn't go through.");

/** What a writer's REVIEW or MERGE came back with. Portalled: the dock and the sticky
 *  bar each hold a stacking context of their own. */
function TextSheet({ title, text, onClose }: { title: string; text: string; onClose: () => void }) {
  return createPortal(
    <div className="fixed inset-0 z-50 flex flex-col justify-end bg-black/50" onClick={onClose}>
      <div className="flex max-h-[78%] flex-col border-t border-border-bright bg-[var(--tg-bg)] shadow-[0_-16px_44px_rgba(0,0,0,0.6)]"
        onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2 px-3.5 py-2">
          <span className="min-w-0 truncate text-[9.5px] tracking-[2px] text-[var(--brand-soft)]">{title}</span>
          <button onClick={onClose} aria-label="Close" className="ml-auto flex h-10 w-10 flex-none items-center justify-center"><X size={16} /></button>
        </div>
        <pre className="min-h-0 flex-1 overflow-y-auto whitespace-pre-wrap break-words border-t border-border px-3.5 py-3 pb-[calc(env(safe-area-inset-bottom,0px)+0.75rem)] font-mono text-[11.5px] leading-relaxed text-[var(--foreground)]">{text}</pre>
      </div>
    </div>,
    document.body,
  );
}

/** A member's name as the channel takes it, which is its title. */
const targetName = (r: TreeRow) => r.name;

function WriterButtons({ r, chatId, onDone, onError }: {
  r: TreeRow; chatId: string;
  onDone: (title: string, text: string) => void;
  onError: (msg: string) => void;
}) {
  const arm = useArm();
  const [busy, setBusy] = useState(false);
  const qc = useQueryClient();
  async function act(action: MergeAction, needsTwo: boolean) {
    if (needsTwo && !arm.tap(action)) return;
    setBusy(true);
    try {
      const { text } = await api.channelMerge(chatId, targetName(r), action);
      onDone(`${action.toUpperCase()} // ${r.name}`, text);
      void qc.invalidateQueries({ queryKey: ["channel"] });
    } catch (e) { onError(errText(e)); }
    finally { setBusy(false); }
  }
  const live = isRunning(r);
  const hasCopy = !!r.has_copy && r.status !== "discarded";
  if (!r.merged && !hasCopy) return null;
  return (
    <div className="ag-btns">
      {r.merged ? (
        <button type="button" disabled={busy} onClick={() => void act("undo", false)}>UNDO</button>
      ) : (
        <>
          <button type="button" disabled={busy} onClick={() => void act("review", false)}>REVIEW</button>
          <button type="button" disabled={busy || live} data-arm={arm.armed === "merge" ? "" : undefined}
            title={live ? "It's still working." : undefined} onClick={() => void act("merge", true)}>
            {arm.armed === "merge" ? "MERGE?" : "MERGE"}
          </button>
          <button type="button" disabled={busy || live} data-tone="err" data-arm={arm.armed === "discard" ? "" : undefined}
            title={live ? "It's still working." : undefined} onClick={() => void act("discard", true)}>
            {arm.armed === "discard" ? "DISCARD?" : "DISCARD"}
          </button>
        </>
      )}
    </div>
  );
}

function AgentCard({ r, chatId, onOpen, onMessage, onSheet, onError }: {
  r: TreeRow; chatId: string;
  onOpen: (r: TreeRow) => void;
  onMessage: (name: string) => void;
  onSheet: (title: string, text: string) => void;
  onError: (msg: string) => void;
}) {
  const d = agentDot(r);
  const sub = [r.provider, r.account && `A${r.account}`, r.model?.replace(/^claude-/, ""),
    r.kind === "subagent" && r.owner ? `under ${r.owner}` : ""].filter(Boolean).join(" · ");
  const said = !r.detail ? "no details available" : r.activity || r.brief || "";
  const inner = (
    <>
      <div className="ag-who">
        <span className="sb-dot" style={{ background: d.fill ? d.c : "transparent", borderColor: d.c, marginTop: 0 }}
          data-work={isRunning(r) ? "" : undefined} />
        <b>{r.name}</b>
        {r.write && <span className="ag-tag">WRITER</span>}
        {r.conflict && <span className="ag-tag" style={{ color: "var(--err)" }}>CONFLICT</span>}
        {r.needs && <span className="at-needs" style={{ marginTop: 0 }}>NEEDS YOU</span>}
        <span className="sb-ago ml-auto" style={{ marginTop: 0 }}>{fmtElapsed(elapsedOf(r, Date.now() / 1000))}</span>
      </div>
      <div className="ag-sub">{sub} · {r.detail ? r.status : "status unknown"}</div>
      {said && <div className="ag-act" style={r.detail ? undefined : { fontStyle: "italic", color: "var(--txd)" }}>{said}</div>}
    </>
  );
  return (
    <div className="ag-card" data-needs={r.needs ? "" : undefined} style={{ "--ag": d.c } as React.CSSProperties}>
      {r.detail
        ? <button type="button" className="ag-open" onClick={() => onOpen(r)}>{inner}</button>
        : <div className="ag-open">{inner}</div>}
      {r.kind === "member" && (
        <>
          <div className="ag-btns">
            <button type="button" onClick={() => onMessage(targetName(r))}>MESSAGE</button>
            <button type="button" onClick={() => onOpen(r)}>OPEN <ChevronRight size={11} className="inline" aria-hidden /></button>
          </div>
          {r.write && <WriterButtons r={r} chatId={chatId} onDone={onSheet} onError={onError} />}
        </>
      )}
    </div>
  );
}

/** The chat's own agent, which the tree doesn't list: it isn't under anything. */
function MainCard({ chatId, onMessage }: { chatId: string; onMessage: (name: string) => void }) {
  const { sessions, openBrief, sessionId, selectSession } = useChat();
  const { data: running } = useQuery({ queryKey: ["running"], queryFn: () => api.getRunning(), refetchInterval: 4000 });
  const brief = sessions.find((s) => s.id === chatId) ?? (openBrief?.id === chatId ? openBrief : undefined);
  const st = running?.status?.[chatId];
  const job = running?.jobs?.find((j) => j.session_id === chatId);
  const needs = needsYou(st?.state);
  const live = st?.state === "working" || st?.state === "checking";
  const c = needs ? "var(--warn)" : live ? "var(--ok)" : "var(--txl)";
  const started = job?.started ?? null;
  const sub = [providerName(brief?.agent), brief?.account && `A${brief.account}`, brief?.model?.replace(/^claude-/, ""),
    st?.state && st.state !== "idle" ? st.state : "idle"].filter(Boolean).join(" · ");
  return (
    <div className="ag-card" data-needs={needs ? "" : undefined} style={{ "--ag": c } as React.CSSProperties}>
      <button type="button" className="ag-open" disabled={sessionId === chatId} onClick={() => selectSession(chatId)}>
        <div className="ag-who">
          <span className="sb-dot" data-work={live ? "" : undefined}
            style={{ background: live || needs ? c : "transparent", borderColor: c, marginTop: 0 }} />
          <b>{brief?.title || "main"}</b>
          <span className="ag-tag">MAIN</span>
          {needs && <span className="at-needs" style={{ marginTop: 0 }}>NEEDS YOU</span>}
          {started ? <span className="sb-ago ml-auto" style={{ marginTop: 0 }}>{fmtElapsed(Date.now() / 1000 - started)}</span> : null}
        </div>
        <div className="ag-sub">{sub}</div>
        {(st?.label || job?.activity?.label) && <div className="ag-act">{st?.label || job?.activity?.label}</div>}
      </button>
      <div className="ag-btns">
        <button type="button" onClick={() => onMessage("main")}>MESSAGE</button>
        {sessionId !== chatId && (
          <button type="button" onClick={() => selectSession(chatId)}>OPEN <ChevronRight size={11} className="inline" aria-hidden /></button>
        )}
      </div>
    </div>
  );
}

const STATE_INK: Record<string, string> = {
  held: "var(--warn)", queued: "var(--info)", delivered: "var(--txd)", read: "var(--ok)", dropped: "var(--err)",
};

function MessageRow({ m, chatId, onError }: { m: ChannelMessage; chatId: string; onError: (msg: string) => void }) {
  const qc = useQueryClient();
  const arm = useArm();
  const [edit, setEdit] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const held = m.state === "held";
  async function send(change: { body?: string; drop?: boolean }) {
    setBusy(true);
    try {
      await api.channelEdit(chatId, m.id, change);
      setEdit(null);
      void qc.invalidateQueries({ queryKey: ["channel"] });
    } catch (e) { onError(errText(e)); }
    finally { setBusy(false); }
  }
  return (
    <div className="ag-msg" data-state={m.state}>
      <div className="ag-route">
        <b>{m.sender}</b><span aria-hidden>{"→"}</span><b>{m.recipient}</b>
        {m.kind !== "message" && m.kind !== "human" && <span className="ag-tag">{m.kind.toUpperCase()}</span>}
        <span className="ag-state" style={{ color: STATE_INK[m.state] ?? "var(--txd)" }}>
          {m.state.toUpperCase()} · {hhmm(m.at)}
        </span>
      </div>
      {edit === null ? (
        <div className="ag-body">{m.body}</div>
      ) : (
        <textarea value={edit} onChange={(e) => setEdit(e.target.value)} rows={4} aria-label="Edit this message"
          className="mt-2 w-full resize-y border border-border bg-[var(--panel3)] p-2 text-[13px] text-[var(--foreground)] outline-none" />
      )}
      {held && (
        <div className="ag-btns -mx-[11px] -mb-[9px] mt-2">
          {edit === null ? (
            <>
              <button type="button" disabled={busy} onClick={() => setEdit(m.body)}>EDIT</button>
              <button type="button" disabled={busy} data-tone="err" data-arm={arm.armed === "drop" ? "" : undefined}
                onClick={() => { if (arm.tap("drop")) void send({ drop: true }); }}>
                {arm.armed === "drop" ? "DROP?" : "DROP"}
              </button>
            </>
          ) : (
            <>
              <button type="button" disabled={busy || !edit.trim()} onClick={() => void send({ body: edit })}>SAVE</button>
              <button type="button" disabled={busy} onClick={() => setEdit(null)}>CANCEL</button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

/** Keeps the newest message in view while you're at the bottom of the log. */
function useFollow(count: number) {
  const end = useRef<HTMLDivElement>(null);
  const first = useRef(true);
  useEffect(() => {
    const main = end.current?.closest("main");
    if (!main || !count) return;
    const near = main.scrollHeight - main.scrollTop - main.clientHeight < 240;
    if (first.current || near) main.scrollTo({ top: main.scrollHeight });
    first.current = false;
  }, [count]);
  return end;
}

function ChannelLog({ view, onError }: { view: ChannelView; onError: (m: string) => void }) {
  const end = useFollow(view.messages.length);
  return (
    <div className="space-y-2">
      {view.config.held && (
        <Banner tone="info">The channel is held. Agents' messages wait here until you release it. Yours still go.</Banner>
      )}
      {view.messages.length === 0 && (
        <div className="sb-empty">
          Nothing on the channel yet. What agents say to each other, and what you send them, shows here.
        </div>
      )}
      {view.messages.map((m) => <MessageRow key={m.id} m={m} chatId={view.chat} onError={onError} />)}
      <div ref={end} />
    </div>
  );
}

/** Message an agent or all of them; hold the channel; stop everyone. */
function Dock({ view, target, onTarget, inputRef }: {
  view: ChannelView;
  target: string;
  onTarget: (t: string) => void;
  inputRef: React.RefObject<HTMLTextAreaElement | null>;
}) {
  const qc = useQueryClient();
  const arm = useArm();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [say, setSay] = useState<{ tone: "info" | "error"; text: string } | null>(null);
  const bar = useRef<HTMLDivElement>(null);
  const held = view.config.held;
  const names = view.rows.filter((r) => r.kind === "member").map(targetName);
  // A helper can go between your picking it and the send.
  const to = target === "all" || target === "main" || names.includes(target) ? target : "main";

  // Fixed, so the page can't see its height. As the composer does (--composer-h).
  useEffect(() => {
    const el = bar.current;
    if (!el) return;
    const ro = new ResizeObserver(() => document.documentElement.style.setProperty("--dock-h", `${el.offsetHeight}px`));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  async function run(fn: () => Promise<string | null>) {
    setBusy(true);
    setSay(null);
    try {
      const said = await fn();
      if (said) setSay({ tone: "info", text: said });
      void qc.invalidateQueries({ queryKey: ["channel"] });
    } catch (e) { setSay({ tone: "error", text: errText(e) }); }
    finally { setBusy(false); }
  }
  const send = () => {
    const body = text.trim();
    if (body) void run(async () => { await api.channelSend(view.chat, to, body); setText(""); return null; });
  };

  return (
    <div ref={bar} className="ag-dock">
      {say && <div className="mb-1.5"><Banner tone={say.tone}>{say.text}</Banner></div>}
      <div className="ag-chips" role="radiogroup" aria-label="Send to">
        {["all", "main", ...names].map((n) => (
          <button key={n} type="button" role="radio" aria-checked={to === n} onClick={() => onTarget(n)}>
            {n === "all" ? "ALL" : n === "main" ? "MAIN" : n}
          </button>
        ))}
      </div>
      <div className="flex items-end gap-1.5">
        <textarea ref={inputRef} value={text} onChange={(e) => setText(e.target.value)} rows={1}
          placeholder={to === "all" ? "Message every agent…" : `Message ${to}…`}
          aria-label={`Message ${to}`}
          className="max-h-24 min-h-[42px] min-w-0 flex-1 resize-none border border-border bg-[var(--panel3)] px-2.5 py-2.5 text-sm text-[var(--foreground)] outline-none placeholder:text-[var(--tg-hint)]" />
        <button type="button" aria-label="Send" disabled={busy || !text.trim()} onClick={send}
          className="flex h-[42px] w-[42px] flex-none items-center justify-center bg-primary text-primary-foreground active:opacity-70 disabled:opacity-40">
          <ArrowUp size={18} aria-hidden />
        </button>
      </div>
      <div className="ag-actions">
        <button type="button" disabled={busy} data-on={held ? "" : undefined}
          onClick={() => void run(async () => { await api.channelHold(view.chat, !held); return null; })}>
          {held ? "RELEASE" : "HOLD"}
        </button>
        <button type="button" disabled={busy} data-tone="err" data-arm={arm.armed === "stop" ? "" : undefined}
          onClick={() => {
            if (!arm.tap("stop")) return;
            void run(async () => {
              const { stopped } = await api.channelStop(view.chat);
              return stopped ? `Stopped ${stopped} agent${stopped === 1 ? "" : "s"}.` : "Nothing was running.";
            });
          }}>
          {arm.armed === "stop" ? "TAP TO STOP ALL" : "STOP ALL"}
        </button>
      </div>
    </div>
  );
}

export function AgentGrid({ tab }: { tab: Exclude<AgentTab, "chat"> }) {
  const { sessionId, openHelper, experimental } = useChat();
  const q = useChannel(sessionId, experimental, true);
  const view = q.data;
  const [target, setTarget] = useState("main");
  const [sheet, setSheet] = useState<{ title: string; text: string } | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [sub, setSub] = useState<TreeRow | null>(null);
  const input = useRef<HTMLTextAreaElement>(null);

  const open = (r: TreeRow) => {
    if (r.kind === "subagent") setSub(r);
    else if (r.session_id) openHelper(r.session_id);
  };
  const message = (name: string) => { setTarget(name); input.current?.focus(); };

  return (
    <div className="space-y-2" style={{ paddingBottom: "calc(var(--dock-h, 11rem) + 0.75rem)" }}>
      {sheet && <TextSheet title={sheet.title} text={sheet.text} onClose={() => setSheet(null)} />}
      {sub && <SubagentModal row={sub} onClose={() => setSub(null)} />}
      {problem && (
        <button type="button" className="block w-full text-left" onClick={() => setProblem(null)}>
          <Banner tone="error">{problem}</Banner>
        </button>
      )}
      {!view && q.isError && (
        <div className="space-y-2">
          <Banner tone="error">{errText(q.error)}</Banner>
          <button type="button" className="min-h-[42px] w-full border border-border-bright text-[11px] tracking-[.12em] text-[var(--brand-soft)] active:opacity-70"
            onClick={() => void q.refetch()}>
            TRY AGAIN
          </button>
        </div>
      )}
      {view && q.isError && <Banner tone="info">Can't reach the bridge right now. This may be out of date.</Banner>}
      {!view && !q.isError && [0, 1, 2].map((i) => <Skeleton key={i} className="h-20 w-full" />)}
      {view && tab === "agents" && (
        <>
          <MainCard chatId={view.chat} onMessage={message} />
          {sortRows(view.rows, "attention").map((r) => (
            <AgentCard key={r.key} r={r} chatId={view.chat} onOpen={open} onMessage={message}
              onSheet={(title, text) => setSheet({ title, text })} onError={setProblem} />
          ))}
          {view.rows.length === 0 && (
            <div className="sb-empty">Only the main agent is here. Ask it for a helper, or @ a profile.</div>
          )}
        </>
      )}
      {view && tab === "channel" && <ChannelLog view={view} onError={setProblem} />}
      {view && <Dock view={view} target={target} onTarget={setTarget} inputRef={input} />}
    </div>
  );
}
