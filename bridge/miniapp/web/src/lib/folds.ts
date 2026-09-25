// Whether the THINKING and STEPS folds mount open. The dashboard carries this
// in HudSettings and threads it down as a prop; the Mini App has no settings
// blob, so the transcript reads it here (the same story as useToolStyle).
// False by default: between two things the agent says, the work sits under one
// row each until you open it, and the words stay the thing you see.
import { usePersistentState } from "./persistentState.ts";

const KEY = "ma-folds-open";

export function useFoldsOpen(): readonly [boolean, (v: boolean) => void] {
  const [v, set] = usePersistentState<boolean>(KEY, false);
  return [v === true, set] as const;
}
