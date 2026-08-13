import { useEffect, useRef, useState } from "react";

/** A loading flag that ignores a fast load and refuses to blink on a slow one.
 *
 *  Most session switches land in a few milliseconds — the transcript endpoint is
 *  p90 ~7ms and a session you've already opened paints from cache with no fetch
 *  at all. Rendering a spinner for those is a flash of nothing, which reads as
 *  jank rather than progress. So nothing shows for `delay` after `active` goes
 *  true; a switch that finishes inside that window never draws a loading state.
 *
 *  A heavy session over the tunnel does cross it, and once the state is up it
 *  stays for at least `minShow` — otherwise a load finishing just past the delay
 *  strobes it on and off inside a single frame budget. */
export function useLoadingPhase(active: boolean, delay = 150, minShow = 300): boolean {
  const [shown, setShown] = useState(false);
  // Both refs mirror `shown` so the effect can read it without depending on it:
  // as a dep, flipping it re-runs the effect, which re-arms the delay timer and
  // pushes `since` forward — the min-show clock would never start.
  const on = useRef(false);
  const since = useRef(0);
  useEffect(() => {
    if (active) {
      if (on.current) return;                       // already up: leave it alone
      const t = setTimeout(() => {
        on.current = true;
        since.current = Date.now();
        setShown(true);
      }, delay);
      return () => clearTimeout(t);
    }
    if (!on.current) return;                        // never showed: nothing to hold
    const hide = () => { on.current = false; setShown(false); };
    const left = since.current + minShow - Date.now();
    if (left <= 0) { hide(); return; }
    const t = setTimeout(hide, left);
    return () => clearTimeout(t);
  }, [active, delay, minShow]);
  return shown;
}
