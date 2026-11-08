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
