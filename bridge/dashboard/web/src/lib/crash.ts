/* The page's crashes before anyone knows whether to send them. main.tsx
 * imports this first, so its listeners are up before any other module runs:
 * an error from the page's first moments is kept here, and lib/reports.ts
 * hands it to Sentry once the SDK has loaded (settle(capture)), or drops it
 * when this install doesn't report (settle(null)). React's root callbacks
 * (main.tsx) come through crash() too, before and after.
 *
 * Kept free of imports: it has to run before everything else. */

type Sink = (err: unknown) => void;

const early: unknown[] = [];
let sink: Sink | null | undefined;     // undefined: not decided yet; null: this install doesn't report

/** A crash from anywhere on the page: sent, kept until the SDK loads, or dropped. */
export function crash(err: unknown): void {
  if (sink) sink(err);
  else if (sink === undefined && early.length < 20) early.push(err);
}

const onError = (e: ErrorEvent) => crash(e.error ?? new Error(e.message));
const onRejection = (e: PromiseRejectionEvent) => crash(e.reason);
addEventListener("error", onError);
addEventListener("unhandledrejection", onRejection);

/** The answer is in: from now on crashes go to `next` (the SDK's own handlers
 *  take over window errors), or nowhere. What was kept goes first. */
export function settle(next: Sink | null): void {
  removeEventListener("error", onError);
  removeEventListener("unhandledrejection", onRejection);
  sink = next;
  for (const err of early.splice(0)) next?.(err);
}
