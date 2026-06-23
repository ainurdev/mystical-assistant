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
    <div className="mx-auto flex max-w-[760px] flex-col gap-[18px] px-6">
      {turns.map((turn) => {
        const isActive = turn.id === activeId;
        const working = isActive && turn.status === "running" && turn.pending.length === 0;
        return (
          <div key={turn.id} className="flex flex-col gap-2.5">
            {turn.prompt && (
              <div className="max-w-[78%] self-end whitespace-pre-wrap rounded-[14px] rounded-br-[4px] bg-primary px-[15px] py-[11px] text-[13.5px] leading-relaxed text-primary-foreground shadow-[0_4px_14px_rgba(116,88,255,.25)]">
                {turn.prompt}
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
