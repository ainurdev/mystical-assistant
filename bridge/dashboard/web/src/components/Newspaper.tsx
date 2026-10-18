import { DynamicIcon } from "lucide-react/dynamic";
import type { Paper } from "../lib/jobs";
import { dayOf } from "../lib/jobs";

// Rivendell's illustration keys (news-prompt.template.ts NEWS_ILLUSTRATIONS) are
// lucide names, all but a few: those get the nearest glyph.
const ILLO: Record<string, string> = { fire: "flame", bicycle: "bike", lighthouse: "radio-tower", inkpot: "feather" };
const MOOD: Record<string, string> = { sunny: "sun", cloudy: "cloud", stormy: "cloud-lightning", foggy: "cloud-fog" };

function Illo({ name, size }: { name?: string | null; size: number }) {
  if (!name) return null;
  return <DynamicIcon name={(ILLO[name] ?? name) as never} size={size} strokeWidth={1.7} aria-hidden fallback={() => null} />;
}

const todayIso = () => {
  const t = new Date();
  return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, "0")}-${String(t.getDate()).padStart(2, "0")}`;
};

/** A newspaper job's answer drawn as the paper, not as its JSON: the masthead
 *  and ear, the forecast, the lead, the stories, the briefs, and the "ads",
 *  which are the reader's to-dos (NEEDS YOU), an overdue one in warn. The refs
 *  (P5, C4…) point into context only Rivendell holds, so they are left out. */
export function Newspaper({ paper, date }: { paper: Paper; date?: string }) {
  const lead = paper.lead;
  const stories = paper.stories ?? [];
  const ads = paper.ads ?? [];
  const today = todayIso();
  return (
    <div className="paper">
      <div className="paper-mast">
        <div>
          {date && <div className="paper-dt">{dayOf(date).toUpperCase()}</div>}
          <div className="paper-nm">The Daily <i>Rivendell</i></div>
        </div>
        {paper.ear && <div className="paper-ear">“{paper.ear}”</div>}
      </div>
      {paper.forecast?.summary && (
        <div className="paper-wx">
          <Illo name={MOOD[paper.forecast.mood ?? ""] ?? "cloud"} size={15} />
          <b>FORECAST</b><span>{paper.forecast.summary}</span>
        </div>
      )}
      {lead && (
        <div className="paper-lead">
          <div className="min-w-0">
            <h3>{lead.headline}</h3>
            {lead.deck && <p className="paper-deck">{lead.deck}</p>}
            {(lead.body ?? []).map((b, i) => <p key={i}>{b}</p>)}
          </div>
          {lead.illustration && <span className="paper-illo"><Illo name={lead.illustration} size={26} /></span>}
        </div>
      )}
      {stories.length > 0 && (
        <div className="paper-stories">
          {stories.map((s, i) => (
            <div key={i} className="paper-story">
              {s.illustration && <span className="paper-sicon"><Illo name={s.illustration} size={15} /></span>}
              <h4>{s.headline}</h4>
              {s.deck && <p className="paper-deck">{s.deck}</p>}
              {(s.body ?? []).map((b, j) => <p key={j}>{b}</p>)}
            </div>
          ))}
        </div>
      )}
      {((paper.briefs ?? []).length > 0 || ads.length > 0) && (
        <div className="paper-lower">
          {(paper.briefs ?? []).length > 0 && (
            <div>
              <div className="paper-sec">IN BRIEF</div>
              <ul className="paper-briefs">{(paper.briefs ?? []).map((b, i) => <li key={i}>{b.text}</li>)}</ul>
            </div>
          )}
          {ads.length > 0 && (
            <div>
              <div className="paper-sec" data-ny>NEEDS YOU · {ads.length}</div>
              {ads.map((a, i) => (
                <div key={i} className="paper-ad" data-big={a.size === "large" || undefined}>
                  <span className="paper-ai"><Illo name={a.illustration ?? "bell"} size={14} /></span>
                  <div className="min-w-0">
                    <h5>{a.title}</h5>
                    {a.text && <p>{a.text}</p>}
                    {a.due && (
                      <span className="paper-due" data-late={a.due < today || undefined}>
                        {a.due < today ? "OVERDUE · " : ""}DUE {dayOf(a.due).toUpperCase()}
                      </span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
