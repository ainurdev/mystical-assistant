import { ListChecks } from "lucide-react";
import { planHead, planSay, type PlanEv } from "../lib/planline";

// The chat's plan changing (bridge/chatplan.py event), as its own line in the transcript rather than a
// tool row folded into the work: a plan beside the list was easy to miss. Same file in both apps;
// onOpen shows the whole plan where the app has a place for it.
export function PlanLine({ ev, onOpen }: { ev: PlanEv; onOpen?: () => void }) {
  return (
    <div role="note" className="pl-line" data-first={ev.first || undefined}>
      <div className="pl-line-h">
        <ListChecks size={13} strokeWidth={1.8} aria-hidden />
        <b>{planHead(ev)}</b>
        {onOpen ? <button type="button" className="pl-line-open" onClick={onOpen}>Open the plan</button> : null}
      </div>
      {ev.first && ev.steps.length ? (
        <ol className="pl-line-steps">{ev.steps.map((s, i) => <li key={i}>{s}</li>)}</ol>
      ) : null}
      {!ev.first ? (
        <ul className="pl-line-rows">
          {ev.changes.map((c, i) => <li key={i} data-kind={c.kind} title={c.kind === "renamed" && c.was ? `Was: ${c.was}` : undefined}>{planSay(c)}</li>)}
          {ev.more ? <li data-kind="more">and {ev.more} more</li> : null}
        </ul>
      ) : null}
    </div>
  );
}
