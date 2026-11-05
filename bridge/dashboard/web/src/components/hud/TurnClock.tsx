import type { ReactNode } from "react";
import type { TurnRow } from "../../lib/checkpoints";
import { turnClock } from "../../lib/turnclock";
import { dur } from "../../lib/week";
import { RailHero } from "./RailHero";

/* The Turns tab's hero: the session on one time strip, each turn a block where
   it ran, its asks as dots above, hour ticks under. Green is a turn at work,
   amber one that waits on you; the pill on the top line says which. The numbers
   the old three readout cards held are the caption. */
export function TurnClock({ rows, now, range, pill, say }: {
  rows: TurnRow[]; now: number;
  /** the top line's left: when the session ran, as the panel words it */
  range: string;
  /** the top line's right: the live status, as a pill */
  pill: ReactNode;
  /** the same status in words, for the box's aria-label */
  say: string;
}) {
  const kept = rows.filter((r) => r.started != null);
  const asksOf = (r: TurnRow) => r.subs.filter((s) => s.kind === "question").length;
  const c = turnClock(kept.map((r) => ({ started: r.started!, secs: r.secs ?? 0, asks: asksOf(r), running: r.status === "running" })), now);
  const span = Math.max(c.to - c.from, 60);
  const work = rows.reduce((s, r) => s + (r.secs ?? 0), 0);
  const asks = rows.reduce((s, r) => s + asksOf(r), 0);
  const label = rows.length
    ? `${rows.length} ${rows.length === 1 ? "turn" : "turns"}, ${dur(work)} working, ${asks} ${asks === 1 ? "ask" : "asks"}. ${say}`
    : "No turns yet";
  return (
    <RailHero label={label} top={<><span className="tc-range">{range}</span><span className="tc-right">{pill}</span></>}>
      <div className="tc">
        <div className="tc-strip">
          {c.blocks.map((b, i) => {
            const r = kept[i];
            const cls = r.waiting ? "ask" : b.running ? "run" : "";
            return (
              <span key={r.id} className="tc-blk-w" style={{ left: `${b.x * 100}%`, width: `${b.w * 100}%` }}>
                <span className="tc-dots" aria-hidden>{Array.from({ length: Math.min(b.asks, 4) }, (_, k) => <i key={k} className={r.waiting ? "ask" : ""} />)}</span>
                <span className={`tc-blk ${cls}`} aria-hidden>{b.w > 0.04 ? r.n : ""}</span>
              </span>
            );
          })}
          <span className="tc-axis" aria-hidden />
          {c.ticks.map((t) => (
            <span key={t.at} className="tc-tick" style={{ left: `${((t.at - c.from) / span) * 100}%` }} aria-hidden><i />{t.label}</span>
          ))}
        </div>
        <div className="tc-cap">
          {rows.length ? <><b>{rows.length}</b> {rows.length === 1 ? "turn" : "turns"}<span>·</span><b>{dur(work)}</b> working<span>·</span><b>{asks}</b> {asks === 1 ? "ask" : "asks"}</> : "no turns yet"}
        </div>
      </div>
    </RailHero>
  );
}
