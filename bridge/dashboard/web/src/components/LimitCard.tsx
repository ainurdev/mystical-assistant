import { useEffect, useState, type CSSProperties } from "react";
import { CornerDownRight, Gauge, Pause, RefreshCw } from "lucide-react";
import { api, type AccountInfo, type SessionStatus } from "../api";
import type { Turn } from "../chat";
import { DEFAULT_SLOT } from "../models";
import { limitNudge, limitResets, limitWindow, loginName, otherLogin, span } from "../lib/limit";
import { hhmm, useClock12, wall } from "../lib/surfaces";
import { Card } from "./ui";
import { notify } from "./hud/Notifications";

/** The open session, parked on a usage limit: its last turn draws the live card. */
export interface LimitLive {
  session: string;
  status: SessionStatus;
}

/** A turn the usage limit cut off, where its answer would be (design:
 *  .mystical/design-drafts/limit-chat, B · CARD). While the session is parked
 *  it is a card: when it resumes, how far along the wait is, and the two ways
 *  out (another login, or no resume). An open ASK draws the question card's
 *  frame instead. Settled, it is a receipt in DOSSIER's no-body answer tier,
 *  saying what the limit did to the work: continued on another login, resumed
 *  at the reset, or just stopped. The CLI's own sentence ("resets 12:30am
 *  (Asia/Yerevan)") and the old red badge are never drawn; the continuation's
 *  nudge plate is dropped by the turn (lib/limit limitNudge). */
export function LimitBlock({ turn, next, live, logins }: {
  turn: Turn;
  /** The turn after it: a nudge there says how the work went on. */
  next?: Turn;
  live?: LimitLive | null;
  logins: AccountInfo[];
}) {
  const said = limitText(turn);
  const dry = live?.status.slot ?? slotOf(turn.runtime, logins);
  const ctx = { who: loginName(logins.find((a) => a.slot === dry), dry), win: limitWindow(said) || "usage", said };
  if (live && !next) {
    return live.status.offer?.length
      ? <LimitAsk live={live} logins={logins} {...ctx} />
      : <LimitPaused live={live} logins={logins} dry={dry} {...ctx} />;
  }
  return <LimitReceipt turn={turn} next={next} logins={logins} {...ctx} />;
}

type Ctx = { who: string; win: string; said: string };

/** The sentence the turn died with: its error result, or the error event's
 *  message when that is where it came (outcomes.py puts it in the detail). */
function limitText(turn: Turn): string {
  for (let i = turn.events.length - 1; i >= 0; i--) {
    const e = turn.events[i];
    if (e.type === "result" && e.is_error) return e.result;
  }
  return turn.outcome?.detail ?? "";
}

/** The login a turn ran on: its `claude:<slot>`, else the default one. */
function slotOf(runtime: string | null | undefined, logins: AccountInfo[]): number {
  const m = /^claude:(\d+)$/.exec(runtime ?? "");
  return m ? Number(m[1]) : logins.find((a) => a.default)?.slot ?? DEFAULT_SLOT;
}

/** "refills 00:30", in the app's clock — or nothing when the sentence doesn't say. */
function refills(said: string, h12: boolean): string {
  const r = limitResets(said);
  if (!r) return "";
  const d = new Date();
  d.setHours(r.h, r.m, 0, 0);
  return `${r.day ? `${r.day} ` : ""}${hhmm(d.getTime() / 1000, h12)}`;
}

function useNow(ms = 30_000): number {
  const [now, setNow] = useState(() => Date.now() / 1000);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now() / 1000), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

/** One of the live card's answers, its failure said where it happened. An older
 *  bridge answers DON'T RESUME's op with a 400: the restart is the fix. */
function useAct() {
  const [busy, setBusy] = useState(false);
  const act = (p: Promise<{ ok: boolean }>, fail: string) => {
    setBusy(true);
    p.then((r) => { if (!r.ok) notify("error", fail); },
      (e: Error) => notify("error", /op must/.test(e.message) ? "Restart the bridge to use this." : e.message))
      .finally(() => setBusy(false));
  };
  return [busy, act] as const;
}

const HANDOVER_FAILED = "Couldn't hand the work over — still parked until the reset.";

function LimitReceipt({ turn, next, logins, who, win, said }: Ctx & { turn: Turn; next?: Turn; logins: AccountInfo[] }) {
  const h12 = useClock12();
  const res = [...turn.events].reverse().find((e) => e.type === "result");
  const elapsed = res?.type === "result" ? res.elapsed : 0;
  const end = res?.at ?? (turn.started !== undefined ? turn.started + elapsed : undefined);
  const carried = next ? limitNudge(next.prompt) : null;
  const refill = refills(said, h12);
  const to = next ? slotOf(next.runtime, logins) : null;
  const [Icon, what] =
    carried === "account" ? [CornerDownRight, `Usage limit · continued on ${loginName(logins.find((a) => a.slot === to), to)}`] as const
    : carried === "reset" && next?.started ? [RefreshCw, `Usage limit · resumed at ${hhmm(next.started, h12)}`] as const
    : [Gauge, "Usage limit"] as const;
  const why = carried === "reset" && next?.started && end
    ? ` hit its ${win} limit · paused ${span(next.started - end)}, then picked up where it stopped`
    : ` hit its ${win} limit${refill ? ` (refills ${refill})` : ""}${carried === "account" ? " · same session, nothing lost" : ""}`;
  const tokens = turn.tokens;
  return (
    <div className="resblk relative my-2 pl-[var(--rail)]" data-limit={carried ?? ""}>
      <div className="res">
        <div className="res-head">
          <span className="res-lab"><Icon size={13} strokeWidth={2} aria-hidden />{what}</span>
          <span className="res-meta">
            {end !== undefined && <span title="when the limit hit">{hhmm(end, h12)}</span>}
            {elapsed > 0 && <span title="wall time">{wall(elapsed)}</span>}
            {typeof tokens === "number" && tokens > 0 && (
              <span title="tokens this turn spent">
                {tokens < 1000 ? tokens : `${(tokens / 1000).toFixed(tokens < 10_000 ? 1 : 0)}K`} TOK
              </span>
            )}
          </span>
        </div>
        <div className="dlimit-why"><b>{who}</b>{why}</div>
      </div>
    </div>
  );
}

function LimitPaused({ live, logins, dry, who, win }: Ctx & { live: LimitLive; logins: AccountInfo[]; dry: number }) {
  const h12 = useClock12();
  const now = useNow();
  const [busy, act] = useAct();
  const { session, status: st } = live;
  const other = otherLogin(logins, dry);
  const { at, since } = st;
  const f = at && since && at > since ? Math.min(1, Math.max(0, (now - since) / (at - since))) : null;
  return (
    <div className="dlimit" data-k="paused">
      <div className="dlimit-head">
        <Pause size={14} strokeWidth={2} aria-hidden />
        <span>Paused · usage limit</span>
        {since && <span className="dlimit-dim">{hhmm(since, h12)}</span>}
      </div>
      <p className="dlimit-lead"><b>{who}</b> hit its {win} limit. This chat picks up where it stopped when the limit resets.</p>
      {at ? (
        <div className="dlimit-clock">
          <span className="dlimit-big">{hhmm(at, h12)}</span>
          <span className="dlimit-sub">resumes on its own · <b>in {span(at - now)}</b></span>
        </div>
      ) : (
        // A bridge older than `at` sends only its label ("usage limit — resuming ~00:31").
        <p className="dlimit-sub">{st.label}</p>
      )}
      {f !== null && (
        <>
          <div className="dlimit-bar" style={{ "--f": f } as CSSProperties}><i /></div>
          <div className="dlimit-ends">
            <span>stopped {hhmm(since!, h12)}</span><span>now {hhmm(now, h12)}</span><span>resumes {hhmm(at!, h12)}</span>
          </div>
        </>
      )}
      <div className="dlimit-acts">
        {other && (
          <button type="button" className="dlimit-btn" data-strong disabled={busy}
            onClick={() => act(api.noticeLimit(session, other.slot), HANDOVER_FAILED)}>
            <CornerDownRight size={13} strokeWidth={2} aria-hidden />
            Run now on {loginName(other, other.slot)}
            {other.left !== null && <span className="dlimit-dim">{other.left}% left</span>}
          </button>
        )}
        <button type="button" className="dlimit-btn" disabled={busy}
          title="Drop the resume: the session goes idle, and nothing runs at the reset"
          onClick={() => act(api.unpark(session), "It wasn't parked any more.")}>
          Don't resume
        </button>
      </div>
    </div>
  );
}

function LimitAsk({ live, logins, who, win }: Ctx & { live: LimitLive; logins: AccountInfo[] }) {
  const h12 = useClock12();
  const now = useNow();
  const [busy, act] = useAct();
  const { session, status: st } = live;
  return (
    <Card className="chatcard qcard qcard-live dlimit-ask space-y-3">
      <div className="dlimit-q">
        <b>{who}</b> hit its {win} limit{st.since ? ` at ${hhmm(st.since, h12)}` : ""}. Where should the rest of this turn run?
      </div>
      <div className="flex flex-col gap-1.5">
        {st.offer!.map((r, i) => {
          const a = logins.find((x) => x.slot === r.slot);
          return (
            <button key={r.slot} type="button" disabled={busy} className="qopt rounded-lg px-3 py-2 text-left text-sm active:opacity-70"
              onClick={() => act(api.noticeLimit(session, r.slot), HANDOVER_FAILED)}>
              <div className="dlimit-opt">
                <CornerDownRight size={13} strokeWidth={2} aria-hidden />Continue on {loginName(a, r.slot)}
                {i === 0 && <span className="qsug rounded-full">SUGGESTED</span>}
              </div>
              <div className="dlimit-desc">
                {a?.left != null ? `${a.left}% of its ${win === "usage" ? "" : `${win} `}window left · ` : ""}same session, nothing is lost
              </div>
            </button>
          );
        })}
        <button type="button" disabled={busy} className="qopt rounded-lg px-3 py-2 text-left text-sm active:opacity-70"
          onClick={() => act(api.noticeLimit(session), "Couldn't record the wait.")}>
          <div className="dlimit-opt"><Pause size={13} strokeWidth={2} aria-hidden />Wait for the reset</div>
          <div className="dlimit-desc">
            {st.at ? `Picks up on its own at ${hhmm(st.at, h12)} · in ${span(st.at - now)}` : st.label}
          </div>
        </button>
      </div>
    </Card>
  );
}
