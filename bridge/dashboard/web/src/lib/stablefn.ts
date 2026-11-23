import { useCallback, useRef } from "react";

/* A handler whose identity never changes but which always runs the newest closure
   (React's proposed useEffectEvent, done by hand).

   Why: App declares the transcript's handlers (runCommand, quote, respond,
   answerAsk) as plain functions, so every App render (each poll, every keystroke
   in the prompt box) handed each visible turn's RunStream new props. That defeated
   RunStream's memo and mergeDelta's turn-identity work: every visible turn
   re-rendered, a few times a second, for as long as the window was open.

   Why not useCallback with deps: the handlers read a dozen pieces of App state
   (draft, active, sessionId, lastTurnId…); listing them would re-create the
   function on exactly the renders we want to skip, and missing one is a stale bug.
   The ref is written during render, the pattern App's onOpenFile and Markdown's
   latestOpen already use: a render React throws away can leave it one closure
   ahead, which for an event handler is harmless. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function useStableFn<F extends (...args: any[]) => any>(fn: F): F {
  const latest = useRef(fn);
  latest.current = fn;
  return useCallback(((...args: Parameters<F>) => latest.current(...args)) as F, []);
}
