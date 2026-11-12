import type { FlowSettings, FlowStep } from "../api";

/** A flow's steps as the FLOWS sheet sets them (bridge/flowsettings.py), for the prompt box. */

/** A step that will run: switched on, and not PONYTAIL's own while PONYTAIL is off. A here build's
 *  REVIEW ("here") still runs after tickets merge, as the council's. */
export const runs = (st: FlowStep): boolean => st.on && st.ponytail_off !== true;

/** The steps the prompt will follow, which lead the facts beside the row ("grill › build › review ›
 *  retro"): the lit flow's, or the running flow's when the box only guessed during one (the guess
 *  shapes that prompt's run, and the prompt stays in the running flow). null: nothing lit, or the
 *  bridge hasn't answered yet. */
export function promptSteps(o: { kind: string | null; how: "auto" | "picked" | "plain" | "none"; running: string | null;
  cfg: FlowSettings | null }): string | null {
  if (!o.kind || !o.cfg) return null;
  const id = o.how === "auto" && o.running ? o.running : o.kind;
  const f = o.cfg.flows.find((x) => x.id === id);
  return f ? f.steps.filter(runs).map((st) => st.step).join(" › ") : null;
}
