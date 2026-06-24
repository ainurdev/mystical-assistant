import type { AnswerSelection } from "../api";
import type { PendingRequest, Turn } from "../chat";
import { RunStream } from "./RunStream";
import { WorkingIndicator } from "./hud/WorkingIndicator";

type Respond = (
  requestId: string,
  opts: { behavior?: "allow" | "deny"; answers?: AnswerSelection[] },
) => void;

export function Transcript({
  turns,
  activeId,
  onRespond,
  liveTurns,
  trailingWorking,
}: {
  turns: Turn[];
  activeId: string | null;
  onRespond: Respond;
  liveTurns?: Set<string>;
  trailingWorking?: boolean;
}) {
  if (!turns.length) {
    return (
      <div className="py-6 text-[12px] tracking-[1px] text-muted-2">
        // no messages in this session yet
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-3">
      {turns.map((turn) => {
        const isActive = turn.id === activeId;
        const working = isActive && turn.status === "running" && turn.pending.length === 0;
        return (
          <div key={turn.id} className="flex flex-col gap-1.5">
            {turn.prompt && (
              <div className="flex gap-[9px]">
                <span className="flex-none text-violet">~ ❯</span>
                <span className="min-w-0 whitespace-pre-wrap break-words text-foreground-bright">
                  {turn.prompt}
                </span>
              </div>
            )}
            {(turn.events.length > 0 || turn.status === "running") && (
              <RunStream
                events={turn.events}
                pending={turn.pending as PendingRequest[]}
                onRespond={isActive ? onRespond : undefined}
                animate={liveTurns?.has(turn.id) ?? false}
                turnId={turn.id}
              />
            )}
            {working && <WorkingIndicator />}
          </div>
        );
      })}
      {/* Native (VS Code) live session: no turn is ever "running", so the working
          state comes from the unified status map instead of turn.status. */}
      {trailingWorking && <WorkingIndicator />}
    </div>
  );
}
