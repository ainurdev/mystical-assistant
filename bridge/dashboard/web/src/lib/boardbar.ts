/* The Rivendell hero's board bar. Tasks carry only a free-form board `column`,
   so the four lanes come from what the tab already knows per task (groupTasks):
   TODO idle, DOING queued/running, REVIEW held on a question for you, DONE a
   finished run. Widths are proportional with a floor so a lane of 1 stays legible. */
export type Lane = { key: "todo" | "doing" | "review" | "done"; name: string; n: number; flex: number; color: string };

export function boardLanes(g: { needs: unknown[]; running: unknown[]; done: unknown[]; mine: unknown[]; team: unknown[]; later: unknown[] }): Lane[] {
  const l = (key: Lane["key"], name: string, n: number, color: string): Lane => ({ key, name, n, flex: Math.max(n, 5), color });
  return [
    l("todo", "TODO", g.mine.length + g.team.length + g.later.length, "var(--txl)"),
    l("doing", "DOING", g.running.length, "var(--ok)"),
    l("review", "REVIEW", g.needs.length, "var(--acc)"),
    l("done", "DONE", g.done.length, "var(--purple)"),
  ];
}
