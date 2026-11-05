import { Play } from "lucide-react";
import { boardLanes } from "../../lib/boardbar";
import { RailHero } from "./RailHero";

/* The Rivendell tab's hero: the linked project, one box per lane sized by its
   count, and the first open task with the ▶ the task rows already use. */
export function BoardBar({ project, chip, tone, tasks, total, next, onStart }: {
  project: string; chip: string; tone: string;
  tasks: Parameters<typeof boardLanes>[0]; total: number;
  next: { id: string; title: string } | null;
  onStart: (id: string) => void;
}) {
  const lanes = boardLanes(tasks);
  const label = !project ? "no Rivendell project linked"
    : !total ? `${project}: no tasks yet`
    : `${project}, ${chip}. ${lanes.map((l) => `${l.n} ${l.name.toLowerCase()}`).join(", ")}.${next ? ` Next up: ${next.title}` : ""}`;
  return (
    <RailHero label={label} top={project ? <>
      <span className="bb-k">◆ {project}</span>
      <span className="bb-pill" style={{ color: tone }}>{chip}</span>
      <span className="bb-r">{total} task{total === 1 ? "" : "s"}</span>
    </> : <span className="bb-k">no Rivendell project linked</span>}>
      <div className="bb-bar">
        {lanes.map((l) => (
          <div key={l.key} className="bb-lane" style={{ flex: l.flex, ["--lc" as string]: l.color }}>
            <b>{l.n}</b><span title={l.name}>{l.name}</span>
          </div>
        ))}
      </div>
      <div className="bb-cap">
        {next ? <>
          <span className="bb-up">NEXT UP</span>
          <span className="bb-t">{next.title}</span>
          <button type="button" className="bb-go" aria-label={`Start ${next.title}`} onClick={() => onStart(next.id)}>
            <Play size={11} strokeWidth={2.6} aria-hidden />
          </button>
        </> : <span className="bb-t">{project ? "no tasks yet" : ""}</span>}
      </div>
    </RailHero>
  );
}
