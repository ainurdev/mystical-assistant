/** The page's still state. Scenes (HOME's sky and emblem ring, the fresh-session scene, the
 *  caption's ring, the rune spirit, the CRT sweep) pause under `:root[data-still]` (index.css);
 *  indicators keep running. The page goes still after 20 s with no pointer, key or
 *  wheel input, or at once when the window loses focus or the page is hidden, and wakes on the
 *  next input or focus. A smooth loop that repaints makes WebKit redraw 60 times a second, so a
 *  scene nobody is looking at is pure cost (2026-11-23 study). tools/loops.mjs keeps new loops honest.
 *
 *  Why not hasFocus() at start: headless and some app shells report false while in front, which
 *  would freeze the scenes until the first move; a page that opens behind gets `blur` soon enough. */
export const STILL_AFTER_MS = 20_000;

const INPUT = ["pointermove", "pointerdown", "keydown", "wheel"] as const;

type Win = Pick<Window, "addEventListener" | "removeEventListener">;
type Doc = { hidden: boolean; documentElement: Pick<Element, "setAttribute" | "removeAttribute">;
             addEventListener: Document["addEventListener"]; removeEventListener: Document["removeEventListener"] };

/** Start keeping the still state; returns the stop. `now` and the timers are the platform's. */
export function watchStill(win: Win = window, doc: Doc = document, ms = STILL_AFTER_MS, now = () => Date.now()): () => void {
  const root = doc.documentElement;
  let last = now(), still = false, timer: ReturnType<typeof setTimeout> | undefined;
  const rest = () => {
    clearTimeout(timer);
    if (!still) { still = true; root.setAttribute("data-still", ""); }
  };
  const check = () => {
    const left = last + ms - now();
    if (left <= 0) rest(); else timer = setTimeout(check, left);
  };
  // input only stamps the time; the one timer re-arms itself, so a mousemove costs nothing
  const wake = () => {
    last = now();
    if (!still) return;
    still = false; root.removeAttribute("data-still");
    timer = setTimeout(check, ms);
  };
  const vis = () => (doc.hidden ? rest() : wake());
  const opts = { capture: true, passive: true };
  for (const e of INPUT) win.addEventListener(e, wake, opts);
  win.addEventListener("focus", wake);
  win.addEventListener("blur", rest);
  doc.addEventListener("visibilitychange", vis);
  if (doc.hidden) rest(); else timer = setTimeout(check, ms);
  return () => {
    clearTimeout(timer);
    for (const e of INPUT) win.removeEventListener(e, wake, opts);
    win.removeEventListener("focus", wake);
    win.removeEventListener("blur", rest);
    doc.removeEventListener("visibilitychange", vis);
    root.removeAttribute("data-still");
  };
}
