import { weekGrid } from "../../lib/weekgrid";

const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const heat = (shade: number) => `color-mix(in srgb, var(--acc) ${Math.round(18 + 82 * shade)}%, transparent)`;

/** YOUR WEEK: turns per weekday x hour, darker where more ran, this hour outlined.
 *  A report without `hours` draws the grid empty. */
export function WeekGrid({ hours, back }: { hours: number[][] | undefined; back: number }) {
  const { cells, busiest } = weekGrid(hours, new Date(), back);
  const today = (new Date().getDay() + 6) % 7;
  return (
    <>
      <div className="us-lbl">YOUR WEEK{busiest && <span className="r">busiest {DAYS[busiest.day]} {String(busiest.hour).padStart(2, "0")}:00</span>}</div>
      <div className="wg">
        <div className="wg-hrs">
          {["0", "6", "12", "18", "24"].map((h, i) => <span key={h} style={i === 4 ? { right: 0 } : { left: `${i * 25}%`, transform: i ? undefined : "none" }}>{h}</span>)}
        </div>
        {cells.map((row, d) => (
          <div key={d} className={`wg-row${!back && d === today ? " today" : ""}`}>
            <b>{DAYS[d][0]}</b>
            {row.map((c, h) => (
              <i key={h} className={c.now ? "now" : c.future ? "fut" : undefined}
                title={c.v ? `${DAYS[d]} ${String(h).padStart(2, "0")}:00 · ${c.v} turn${c.v === 1 ? "" : "s"}` : undefined}
                style={c.v ? { background: heat(c.shade) } : undefined} />
            ))}
          </div>
        ))}
      </div>
      <div className="wg-scale">fewer<i />{[0.1, 0.4, 0.7, 1].map((s) => <i key={s} style={{ background: heat(s) }} />)}more turns</div>
    </>
  );
}
