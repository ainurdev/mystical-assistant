import { RailHero } from "./RailHero";
import { trunk, type TrunkState } from "../../lib/trunk";

/* The Branches tab's hero: main as a trunk across the top, each worktree forking
   down from it to a tip coloured by state. Fed the panel's own rows. */
const COLOR: Record<TrunkState, string> = {
  waits: "var(--warn)", working: "var(--ok)", pr: "var(--acc)", clean: "var(--txl)", local: "var(--txl)", base: "var(--txl)",
};
const WORD: Record<TrunkState, string> = { waits: "waiting on you", working: "working", pr: "PR", clean: "to clean", local: "local", base: "base" };
const W = 260, Y = 14;

export function BranchTrunk({ rows, base, loading }: { rows: { name: string; state: TrunkState }[]; base: string; loading?: boolean }) {
  const t = trunk(rows);
  if (loading) return <RailHero label="reading…" top={<span className="rh-k">reading…</span>} />;
  const label = t.legend.length
    ? `${rows.length} ${rows.length === 1 ? "worktree" : "worktrees"} off ${base || "main"}: ${t.legend.map((l) => `${l.count} ${WORD[l.state]}`).join(", ")}`
    : `${rows.length ? "Only" : "No"} ${base || "main"}, no other worktrees`;
  return (
    <RailHero label={label} top={<>
      <span className="rh-k">{base || "main"}</span>
      {t.more > 0 && <span className="bt-n">+{t.more}</span>}
    </>}>
      <svg className="bt-svg" viewBox={`0 0 ${W} 62`} aria-hidden>
        <line x1="4" y1={Y} x2={W - 4} y2={Y} stroke="var(--txd)" strokeWidth="2.5" strokeLinecap="round" />
        {t.tips.map((p) => {
          const x = p.x * W, ty = 40 + (p.low ? 14 : 0), c = COLOR[p.state];
          return (
            <g key={p.name}>
              <path d={`M${x - 10} ${Y} C ${x - 4} ${Y}, ${x} ${Y + 8}, ${x} ${ty - 7}`} stroke={c} strokeOpacity=".8" strokeWidth="1.8" fill="none" />
              <circle cx={x} cy={ty} r="5.5" fill={c} fillOpacity={c === "var(--txl)" ? 0.5 : 1} className={p.state === "working" ? "bt-live" : undefined} />
            </g>
          );
        })}
      </svg>
      <div className="bt-leg" aria-hidden>
        {t.legend.length ? t.legend.map((l) => <span key={l.state} style={{ color: COLOR[l.state] }}>● {l.count} {WORD[l.state]}</span>)
          : <span>{rows.length ? "no other worktrees" : "nothing checked out"}</span>}
      </div>
    </RailHero>
  );
}
