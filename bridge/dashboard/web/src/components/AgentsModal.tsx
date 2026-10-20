import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { api, type AgentInfo, type StoreEvent, type StoreTurn, type WorkflowInfo } from "../api";
import type { HudSettings } from "../lib/theme";
import { hhmm } from "../lib/surfaces";
import { agentMeta, fmtClock, fmtSpan, modelName, rosterSections, type Sub } from "../lib/subagents";
import { RunStream } from "./RunStream";

export const SPIN = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/** Elapsed since an epoch-seconds stamp, as a roster span. */
export const fmtSince = (epochSec: number) =>
  !epochSec ? "" : fmtSpan(Date.now() / 1000 - epochSec);

/** How long an agent has been at it (a clock while it runs) or took. */
const span = (a: Sub, now: number) =>
  a.status === "running" ? fmtClock(now - a.started_at) : fmtSpan(a.updated_at - a.started_at);

/** Status glyph: the braille spinner while it runs, a hollow ring once it's
 *  done — the HUD's working vocabulary. A ring, not a tick: a parent that died
 *  leaves its agents done without their having finished. */
function Glyph({ running, frame }: { running: boolean; frame: number }) {
  return <span className="agm-g">{running ? SPIN[frame % SPIN.length] : <i className="agm-ring" />}</span>;
}

/** What the main agent asked, in the AGENT plate's oracle italic — three lines
 *  shut, all of it on a click. A later turn is a message it sent the agent. */
function Brief({ text, first, at }: { text: string; first: boolean; at: number }) {
  const [open, setOpen] = useState(false);
  const lines = text.split("\n").length;
  return (
    <div className="agm-brief" data-open={open || undefined}>
      <div className="agm-bl">{first ? "Brief" : "Message"}<em>from the main agent{at ? ` · ${hhmm(at)}` : ""}</em></div>
      <div className="agm-bt">{text.replace(/\n{2,}/g, "\n")}</div>
      {(lines > 3 || text.length > 280) && (
        <button type="button" className="agm-more" onClick={() => setOpen((o) => !o)}>
          {open ? "clip the brief ↑" : `the whole brief · ${lines} lines ↓`}
        </button>
      )}
    </div>
  );
}

/** One agent's run, drawn the way the chat draws a turn — RunStream over its
 *  own transcript (bridge/agents.agent_activity): the brief, the WORK zone (open
 *  while it runs, hosting the working indicator), the ANSWER. */
function Run({ sessionId, agentId, run, hud }: {
  sessionId: string; agentId: string; run?: string; hud?: HudSettings;
}) {
  const [turns, setTurns] = useState<StoreTurn[]>([]);
  const [events, setEvents] = useState<StoreEvent[]>([]);
  const [running, setRunning] = useState(false);
  const feedRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);           // following the tail until you scroll up

  useEffect(() => {
    let live = true, cursor = 0;
    const poll = async () => {
      try {
        const a = await api.agentActivity(sessionId, agentId, cursor, run);
        if (!live) return;
        cursor = a.next_cursor;
        // `?? []`: a bundle copied live ahead of a restart meets the old backend's shape.
        setTurns(a.turns ?? []);
        if (a.events.length) setEvents((prev) => [...prev, ...a.events]);
        setRunning(a.status === "running");
        if (a.status === "running") setTimeout(poll, 1000);
      } catch { /* ignore */ }
    };
    void poll();
    return () => { live = false; };
  }, [sessionId, agentId, run]);

  useEffect(() => {
    // A frame later: RunStream settles its zones in a commit after this one.
    const id = requestAnimationFrame(() => {
      const el = feedRef.current;
      if (el && running && stick.current) el.scrollTop = el.scrollHeight;
    });
    return () => cancelAnimationFrame(id);
  }, [events, running]);

  const byTurn = useMemo(() => {
    const m = new Map<string, StoreEvent[]>();
    for (const e of events) m.set(e.turn_id, [...(m.get(e.turn_id) ?? []), e]);
    return m;
  }, [events]);

  return (
    <div ref={feedRef} className="mscroll agm-scroll" data-style="dossier"
         onScroll={(e) => { const el = e.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80; }}
         style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: "var(--t13)", lineHeight: 1.6, overflowWrap: "break-word" }}>
      {turns.map((t, i) => {
        const last = i === turns.length - 1;
        const live = running && last;
        const evs = byTurn.get(t.id) ?? [];
        return (
          <div key={t.id} className="dturn flex flex-col gap-2" data-last={last || undefined}>
            {t.prompt ? <Brief text={t.prompt} first={i === 0} at={t.started} /> : null}
            {evs.length > 0 || live ? (
              <div className="dreply relative space-y-1.5">
                <RunStream events={evs} turnId={t.id} turnStarted={t.started} ended={!live} working={live}
                  readOnly hud={hud} openResults={hud?.openResults ?? false}
                  foldsOpen={live || (hud?.foldsOpen ?? false)} compact={hud?.layout === "compact"} />
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

export function AgentsModal({
  sessionId,
  agents,
  workflows,
  initial,
  hud,
  onClose,
}: {
  sessionId: string;
  agents: AgentInfo[];
  workflows: WorkflowInfo[];
  /** Open on this agent (an AGENT plate's open ↗) rather than the first one. */
  initial?: string | null;
  hud?: HudSettings;
  onClose: () => void;
}) {
  const [filter, setFilter] = useState("");
  const filterRef = useRef<HTMLInputElement>(null);
  const all = useMemo(() => rosterSections(agents, workflows, "").flatMap((s) => s.items), [agents, workflows]);
  const sections = useMemo(() => rosterSections(agents, workflows, filter), [agents, workflows, filter]);
  const shown = sections.flatMap((s) => s.items);
  // Open on what's working — WORKING sorts first — else the newest.
  const [selected, setSelected] = useState<string | null>(() => initial ?? all[0]?.key ?? null);
  const sel = all.find((i) => i.key === selected);
  const [tick, setTick] = useState(0);
  const selRowRef = useRef<HTMLButtonElement>(null);

  const nLive = all.filter((i) => i.a.status === "running").length;
  const tools = all.reduce((t, i) => t + (i.a.tools ?? 0), 0);
  const first = all.reduce((m, i) => Math.min(m, i.a.started_at || m), Infinity);
  const now = Date.now() / 1000;

  useEffect(() => {
    if (!nLive) return;                        // no spinner, no clocks, when idle
    const id = setInterval(() => setTick((t) => t + 1), 110);
    return () => clearInterval(id);
  }, [nLive]);

  // The modal owns these keys while it's open: capture, so the sessions
  // panel's "/" (its search box) doesn't fire behind it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = (e.target as HTMLElement | null)?.tagName === "INPUT";
      if (e.key === "Escape") onClose();
      else if (e.key === "/" && !typing && !e.metaKey && !e.ctrlKey) { e.preventDefault(); filterRef.current?.focus(); }
      else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const i = shown.findIndex((x) => x.key === selected);
        const next = shown[Math.max(0, Math.min(shown.length - 1, i + (e.key === "ArrowDown" ? 1 : -1)))];
        if (next) setSelected(next.key);
      } else return;
      e.stopPropagation();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [shown, selected, onClose]);

  useEffect(() => { selRowRef.current?.scrollIntoView({ block: "nearest" }); }, [selected]);

  const day = (t: number) => new Date(t * 1000).toDateString() === new Date().toDateString()
    ? "" : `${new Date(t * 1000).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}, `;

  // Portalled into the themed container: the chat column's entrance animation
  // makes it a containing block for position:fixed, which squeezed the modal
  // between the sidebars. role="dialog" sits on the panel, not the scrim: the
  // families draw every [role=dialog] as a card, which made the scrim opaque.
  return createPortal(
    <div className="agm-scrim" onClick={onClose}>
      <div className="agm" role="dialog" aria-modal="true" aria-labelledby="agm-title" onClick={(e) => e.stopPropagation()}>
        <div className="agm-head">
          <span className="agm-title" id="agm-title">Agents</span>
          {nLive > 0 && (
            <span className="agm-chip" data-live="">
              <span className="agm-spin">{SPIN[tick % SPIN.length]}</span>{nLive} working
            </span>
          )}
          <span className="agm-chip">{all.length - nLive} done</span>
          {/* done / total, so a long fan-out reads as progress, not a number */}
          <span className="agm-bar"><i style={{ width: `${Math.round(((all.length - nLive) / Math.max(1, all.length)) * 100)}%` }} /></span>
          {Number.isFinite(first) && (
            <span className="agm-span">since {day(first)}{hhmm(first)} · {tools.toLocaleString("en")} tool calls</span>
          )}
          <span style={{ flex: 1 }} />
          <button type="button" className="agm-esc" onClick={onClose}>Esc ✕</button>
        </div>
        <div className="agm-body">
          <nav className="agm-roster" aria-label="agents">
            {all.length > 8 && (
              <label className="agm-filter">
                <input ref={filterRef} value={filter} onChange={(e) => setFilter(e.target.value)}
                  placeholder={`Filter ${all.length} agents`} aria-label="filter agents" spellCheck={false} />
                <kbd className="agm-kbd">/</kbd>
              </label>
            )}
            <div className="agm-list mscroll" role="listbox" aria-label="agents">
              {sections.map((s) => (
                <div key={s.name}>
                  <div className="agm-sec"><span>{s.name}</span><span>{filter ? `${s.items.length} of ${s.total}` : s.total}</span></div>
                  {s.items.map(({ key, a }) => {
                    const on = key === selected, running = a.status === "running";
                    return (
                      <button key={key} type="button" role="option" aria-selected={on} className="agm-row"
                        data-live={running || undefined} ref={on ? selRowRef : undefined}
                        onClick={() => setSelected(key)} title={a.description || a.agent_type}>
                        <Glyph running={running} frame={tick} />
                        <span className="agm-t">{a.description || a.agent_type}</span>
                        <span className="agm-dur">{span(a, now)}</span>
                        <span className="agm-m">{agentMeta(a)}</span>
                      </button>
                    );
                  })}
                </div>
              ))}
              {!sections.length && <div className="agm-none">no agent answers to “{filter}”.</div>}
            </div>
            <div className="agm-keys"><span><kbd>↑↓</kbd>agents</span><span><kbd>/</kbd>filter</span><span><kbd>esc</kbd>close</span></div>
          </nav>
          <section className="agm-run">
            {sel && (
              <div className="agm-rhead">
                <Glyph running={sel.a.status === "running"} frame={tick} />
                <span className="agm-rt">{sel.a.description || sel.a.agent_type}</span>
                <span style={{ flex: 1 }} />
                <span className="agm-facts">
                  {[sel.a.agent_type.split(":").pop(), modelName(sel.a.model),
                    sel.a.status === "running" ? fmtClock(now - sel.a.started_at) : fmtLong(sel.a.updated_at - sel.a.started_at),
                    sel.a.tools ? `${sel.a.tools} tools` : ""].filter(Boolean).join(" · ")}
                </span>
                <span className="agm-chip" data-live={sel.a.status === "running" || undefined}>
                  {sel.a.status === "running" ? "working" : "done"}
                </span>
              </div>
            )}
            {sel && <Run key={sel.key} sessionId={sessionId} agentId={sel.a.agent_id} run={sel.run} hud={hud} />}
          </section>
        </div>
      </div>
    </div>,
    document.querySelector("[data-theme]") ?? document.body,
  );
}

/** The run header's span, to the second: 14m 02s, 1h 12m. */
function fmtLong(s: number): string {
  s = Math.max(0, Math.round(s));
  return s >= 3600 ? fmtSpan(s) : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
}
