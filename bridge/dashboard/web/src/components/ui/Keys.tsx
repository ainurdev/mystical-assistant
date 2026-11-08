import { useEffect, useRef } from "react";
import { capsOf, isMac } from "../../lib/shortcuts";

/** A shortcut as keycaps: one small box per key, the ⌘K palette's ESC badge
 *  (.kc in index.css). `hover`: only where there's a keyboard and a pointer that
 *  hovers, for the Ask cards, which phones show too. */
export function Keys({ k, hover }: { k: string; hover?: boolean }) {
  return (
    <span className={hover ? "kc kc-hover" : "kc"}>
      {capsOf(k, isMac()).map((caps, i) => (
        <span key={i} className="kc-set">{caps.map((c, j) => <i key={j}>{c}</i>)}</span>
      ))}
    </span>
  );
}

/** ⌘1–9 and ⌘↵ for a live Ask (the dock, or a card in the stream). App sends
 *  them as "hud:ask-key" ("1"…"9" or "enter"), never from behind an overlay or
 *  over the project window. Only the topmost live Ask answers: the one whose
 *  mark comes first on the page. `take` says whether it used the key. Render
 *  the mark it returns: <span ref={mark} data-ask-keys hidden />. */
export function useAskKeys(take: (key: string) => boolean) {
  const mark = useRef<HTMLSpanElement>(null);
  const latest = useRef(take);
  latest.current = take;
  useEffect(() => {
    const on = (e: Event) => {
      if (e.defaultPrevented || document.querySelector("[data-ask-keys]") !== mark.current) return;
      if (latest.current((e as CustomEvent<string>).detail)) e.preventDefault();
    };
    window.addEventListener("hud:ask-key", on);
    return () => window.removeEventListener("hud:ask-key", on);
  }, []);
  return mark;
}
