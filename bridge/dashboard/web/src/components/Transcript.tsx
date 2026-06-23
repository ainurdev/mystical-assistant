import type { AnswerSelection } from "../api";
import type { PendingRequest, Turn } from "../chat";
import { RunStream } from "./RunStream";

type Respond = (
  requestId: string,
  opts: { behavior?: "allow" | "deny"; answers?: AnswerSelection[] },
) => void;

export function Transcript({
  turns,
  activeId,
  onRespond,
}: {
  turns: Turn[];
  activeId: string | null;
  onRespond: Respond;
}) {
  if (!turns.length) {
    return (
      <div className="p-8 text-center text-sm text-muted-foreground">
        No messages in this session yet.
      </div>
    );
  }
  return (
    <div className="space-y-5">
      {turns.map((turn) => {
        const isActive = turn.id === activeId;
        const working = isActive && turn.status === "running" && turn.pending.length === 0;
        return (
          <div key={turn.id} className="space-y-2">
            {turn.prompt && (
              <div className="flex justify-end">
                <div className="max-w-[80%] whitespace-pre-wrap rounded-2xl rounded-br-sm bg-primary px-3 py-2 text-sm text-primary-foreground">
                  {turn.prompt}
                </div>
              </div>
            )}
            {(turn.events.length > 0 || turn.status === "running") && (
              <RunStream
                events={turn.events}
                pending={turn.pending as PendingRequest[]}
                onRespond={isActive ? onRespond : undefined}
              />
            )}
            {working && <div className="text-xs text-muted-foreground">Working…</div>}
          </div>
        );
      })}
    </div>
  );
}
