import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Hand, OctagonX, Play, Send } from "lucide-react";
import { hhmm } from "../lib/surfaces";
import { canOpen, isLongMessage, isRunning, MAIN, mergeActions, rowTags, sortRows, statusWord, type AgentRow, type ChannelMessage } from "../lib/multi";
import { multi, useChannel } from "../lib/multistore";
import { openAgentRow } from "../lib/multiopen";
import { openSession } from "../lib/devicerun";
import { fmtClock } from "../lib/subagents";
import { SPIN } from "./AgentsModal";
import { AgentGlyph, rowClock } from "./hud/AgentTree";
import { RowTag } from "./MultiRows";
import { askConfirm } from "./ui/Ask";
import { notify } from "./hud/Notifications";
import { Markdown } from "./Markdown";

/* A multi-agent chat at a glance (plan §6): one card per agent, the channel beside
   them. Mystical carries every message, so everything here can be read, held,
   edited or stopped. A card opens its agent in the main pane; this view only ever
   steps in, it doesn't replace talking to one of them. */

/** What the main agent's card reads: it isn't in the tree, it's the chat itself. */
export interface MainCard {
  id: string;
  title: string;
  provider: string;
  account?: string;
  state: "running" | "idle";
  needs: boolean;
  since?: number;
  activity: string;
}

const STATE_WORD: Record<string, string> = {
  queued: "queued", held: "held", delivered: "delivered", read: "read", dropped: "dropped",
};

function Busy({ children }: { children: ReactNode }) {
  return <div className="ma-grid-state" role="status">{children}</div>;
}

function useFrame(live: boolean) {
  const [t, setT] = useState(0);
  useEffect(() => {
    if (!live) return;
    const id = window.setInterval(() => setT((n) => n + 1), 110);
    return () => window.clearInterval(id);
  }, [live]);
  return t;
}

function MainAgentCard({ main, frame }: { main: MainCard; frame: number }) {
  const running = main.state === "running";
  const now = Date.now() / 1000;
  return (
    <div className="ma-card" data-live={running || undefined} data-needs={main.needs || undefined}>
      <button type="button" className="ma-card-open" onClick={() => openSession(main.id)} title="Open the main agent's chat">
        <span className="ma-card-head">
          <span className="ma-g" data-live={running && !main.needs ? "" : undefined} data-needs={main.needs ? "" : undefined} aria-hidden>
            {main.needs ? "!" : running ? SPIN[frame % SPIN.length] : <i className="agm-ring" />}
          </span>
          <span className="ma-card-name">main</span>
          <span className="ma-card-time">{running && main.since ? fmtClock(now - main.since) : ""}</span>
        </span>
        <span className="ma-card-who">{[main.provider, main.account && `account ${main.account}`].filter(Boolean).join(" · ")}</span>
        <span className="ma-card-state">{main.needs ? "needs you" : running ? "working" : "idle"}</span>
        <span className="ma-card-act">{main.activity || main.title}</span>
        {main.needs && <span className="ma-card-wait">Waiting on your answer. Open it to reply.</span>}
      </button>
    </div>
  );
}

function AgentCard({ row, frame, chat, onDone }: { row: AgentRow; frame: number; chat: string; onDone: () => void }) {
  const open = canOpen(row);
  const now = Date.now() / 1000;
  const actions = mergeActions(row);
  const [busy, setBusy] = useState<string | null>(null);
  const [out, setOut] = useState<{ text: string; error: boolean } | null>(null);
  const act = async (action: string) => {
    if (action === "discard" && !await askConfirm(`Throw away ${row.name}'s copy of the code and everything in it?`, { ok: "Discard", danger: true })) return;
    if (action === "undo" && !await askConfirm(`Take ${row.name}'s merge back out of your folder?`, { ok: "Undo merge", danger: true })) return;
    setBusy(action);
    try {
      const r = await multi.merge(chat, row.name, action);
      setOut({ text: r.text, error: false });
      onDone();
    } catch (e) {
      setOut({ text: (e as Error).message, error: true });
    } finally {
      setBusy(null);
    }
  };
  const body = (
    <>
      <span className="ma-card-head">
        <AgentGlyph row={row} frame={frame} />
        <span className="ma-card-name">{row.name}</span>
        <span className="ma-card-time">{rowClock(row, now)}</span>
      </span>
      <span className="ma-card-who">{[row.provider, row.account && `account ${row.account}`, row.model].filter(Boolean).join(" · ")}</span>
      <span className="ma-card-state">
        {row.needs ? "needs you" : statusWord(row.status)}
        {rowTags(row).map((t) => <RowTag key={t.text} {...t} />)}
      </span>
      {open
        ? <span className="ma-card-act">{row.activity || row.brief || (isRunning(row) ? "Starting…" : "Nothing recent to show.")}</span>
        : <span className="ma-card-act" data-dim>No details available. This agent keeps its work in its own private format.</span>}
      {row.needs && <span className="ma-card-wait">Waiting on your answer. Open it to reply.</span>}
    </>
  );
  return (
    <div className="ma-card" data-live={isRunning(row) || undefined} data-needs={row.needs || undefined}>
      {open
        ? <button type="button" className="ma-card-open" onClick={() => openAgentRow(row)} title={row.brief || `Open ${row.name}`}>{body}</button>
        : <div className="ma-card-open" data-flat>{body}</div>}
      {actions.length > 0 && (
        <div className="ma-card-acts">
          {actions.map((a) => (
            <button key={a} type="button" className="ma-btn" disabled={!!busy} data-danger={a === "discard" || undefined} onClick={() => void act(a)}>
              {busy === a ? "…" : a.toUpperCase()}
            </button>
          ))}
        </div>
      )}
      {out && (
        <div className="ma-card-out" data-err={out.error || undefined}>
          <pre>{out.text}</pre>
          <button type="button" className="ma-link" onClick={() => setOut(null)}>close</button>
        </div>
      )}
    </div>
  );
}

function RailMessage({ m, chat, onDone }: { m: ChannelMessage; chat: string; onDone: () => void }) {
  const long = isLongMessage(m.body);
  const [open, setOpen] = useState(false);
  const [edit, setEdit] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const held = m.state === "held";
  const run = async (patch: { body?: string; drop?: boolean }) => {
    setBusy(true);
    try {
      await multi.edit(chat, m.id, patch);
      setEdit(null);
      onDone();
    } catch (e) {
      notify("error", (e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <li className="ma-msg" data-state={m.state}>
      <div className="ma-msg-head">
        <span className="ma-msg-route">{m.sender} <span aria-hidden>→</span><span className="sr-only">to</span> {m.recipient}</span>
        <span className="ma-msg-kind">{m.kind}</span>
        <span className="ma-msg-state" data-state={m.state}>{STATE_WORD[m.state] ?? m.state}</span>
        <span className="ma-msg-at">{hhmm(m.at)}</span>
      </div>
      {edit !== null ? (
        <>
          <textarea className="ma-input ma-msg-edit" value={edit} aria-label="Edit the held message" rows={4}
            onChange={(e) => setEdit(e.target.value)} />
          <div className="ma-msg-acts">
            <button type="button" className="ma-btn" disabled={busy || !edit.trim()} onClick={() => void run({ body: edit })}>SAVE</button>
            <button type="button" className="ma-btn" disabled={busy} onClick={() => setEdit(null)}>CANCEL</button>
          </div>
        </>
      ) : (
        <>
          <div className="ma-msg-body" data-clip={long && !open ? "" : undefined}><Markdown className="leading-relaxed">{m.body}</Markdown></div>
          <div className="ma-msg-acts">
            {long && <button type="button" className="ma-link" aria-expanded={open} onClick={() => setOpen((o) => !o)}>{open ? "show less" : "show all"}</button>}
            {held && <button type="button" className="ma-link" disabled={busy} onClick={() => setEdit(m.body)}>edit</button>}
            {held && <button type="button" className="ma-link" data-danger disabled={busy} onClick={() => void run({ drop: true })}>drop</button>}
          </div>
        </>
      )}
    </li>
  );
}

export function AgentGrid({ sessionId, main, top }: { sessionId: string; main: MainCard | null; top: number }) {
  const { data, error, loading, refresh, patch } = useChannel(sessionId);
  const rows = useMemo(() => sortRows(data?.rows ?? [], "attention"), [data?.rows]);
  const messages = data?.messages ?? [];
  const chat = data?.chat ?? sessionId;
  const held = !!data?.config.held;
  const [to, setTo] = useState(MAIN);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [actErr, setActErr] = useState<string | null>(null);
  const live = rows.some(isRunning) || main?.state === "running";
  const frame = useFrame(live);
  const members = rows.filter((r) => r.kind === "member");
  // A helper that's gone leaves its name picked: back to the main agent.
  useEffect(() => {
    if (to !== MAIN && to !== "all" && data && !members.some((m) => m.name === to)) setTo(MAIN);
  }, [data, members, to]);

  const railRef = useRef<HTMLUListElement>(null);
  const stick = useRef(true);
  useEffect(() => {
    const el = railRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [messages.length]);

  const run = async (p: Promise<unknown>) => {
    setActErr(null);
    try {
      await p;
      await refresh();
    } catch (e) {
      setActErr((e as Error).message);
    }
  };
  const send = async () => {
    const t = text.trim();
    if (!t || sending) return;
    setSending(true);
    setActErr(null);
    try {
      await multi.send(chat, to, t);
      setText("");
      stick.current = true;
      await refresh();
    } catch (e) {
      setActErr((e as Error).message);
    } finally {
      setSending(false);
    }
  };
  const stopAll = async () => {
    if (!await askConfirm("Stop every agent in this chat, the main one too?", { ok: "Stop all", danger: true })) return;
    void run(multi.stopAll(chat));
  };
  const toggleHold = () => {
    if (data) patch({ ...data, config: { ...data.config, held: !held } });
    void run(multi.hold(chat, !held));
  };

  const nHeld = messages.filter((m) => m.state === "held").length;
  const working = rows.filter(isRunning).length + (main?.state === "running" ? 1 : 0);

  return (
    <div className="ma-grid" style={{ paddingTop: top }}>
      <div className="ma-grid-bar">
        <span className="ma-grid-count">{rows.length + 1} agent{rows.length ? "s" : ""}{working > 0 ? ` · ${working} working` : ""}</span>
        <span style={{ flex: 1 }} />
        <button type="button" className="ma-btn" data-on={held || undefined} disabled={!data} aria-pressed={held}
          title={held ? "Deliver what's waiting" : "Agents' messages wait here until you release them. Yours still go through."}
          onClick={toggleHold}>
          {held ? <Play size={11} aria-hidden /> : <Hand size={11} aria-hidden />}{held ? `RELEASE${nHeld ? ` ${nHeld}` : ""}` : "HOLD"}
        </button>
        <button type="button" className="ma-btn" data-danger disabled={!data} onClick={() => void stopAll()}>
          <OctagonX size={11} aria-hidden />STOP ALL
        </button>
      </div>
      {actErr && <div className="ma-grid-err" role="alert">{actErr}<button type="button" className="ma-link" onClick={() => setActErr(null)}>dismiss</button></div>}
      {error && <div className="ma-grid-err" role="alert">
        {data ? `Lost the channel, showing what it last said: ${error}` : `Couldn't read the channel: ${error}`}
        <button type="button" className="ma-link" onClick={() => void refresh()}>try again</button>
      </div>}
      {held && <div className="ma-grid-held" role="status">The channel is held. Agents' messages wait here until you release them{nHeld ? `: ${nHeld} waiting` : ""}.</div>}
      <div className="ma-grid-body">
        <div className="ma-cards mscroll">
          {main && <MainAgentCard main={main} frame={frame} />}
          {loading && !data && <Busy>Reading the channel…</Busy>}
          {!loading && !error && data && rows.length === 0 && <Busy>No helpers in this chat yet. Ask for one, or @ a profile in the box below.</Busy>}
          {rows.map((r) => <AgentCard key={r.key} row={r} frame={frame} chat={chat} onDone={() => void refresh()} />)}
        </div>
        <aside className="ma-rail" aria-label="Channel">
          <div className="ma-rail-head">CHANNEL</div>
          {loading && !data ? <Busy>Reading…</Busy>
            : messages.length === 0 ? <Busy>Nothing on the channel yet.</Busy>
            : (
              <ul ref={railRef} className="ma-rail-list mscroll"
                onScroll={(e) => { const el = e.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60; }}>
                {messages.map((m) => <RailMessage key={m.id} m={m} chat={chat} onDone={() => void refresh()} />)}
              </ul>
            )}
          <form className="ma-send" onSubmit={(e) => { e.preventDefault(); void send(); }}>
            <select className="ma-input ma-send-to" value={to} aria-label="Send to" onChange={(e) => setTo(e.target.value)}>
              <option value={MAIN}>main</option>
              {members.map((m) => <option key={m.key} value={m.name}>{m.name}</option>)}
              {members.length > 0 && <option value="all">all</option>}
            </select>
            <input className="ma-input ma-send-text" value={text} placeholder={to === "all" ? "message every agent…" : `message ${to}…`}
              aria-label="Message" onChange={(e) => setText(e.target.value)} />
            <button type="submit" className="ma-btn" disabled={!text.trim() || sending || !data} aria-label="Send">
              <Send size={11} aria-hidden />{sending ? "…" : "SEND"}
            </button>
          </form>
        </aside>
      </div>
    </div>
  );
}

