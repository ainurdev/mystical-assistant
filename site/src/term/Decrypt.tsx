import { useEffect, useRef, useState } from "react";

/**
 * Resolves a line of text out of noise, left to right.
 *
 * The glyph set is deliberately the box-drawing and operator characters a
 * terminal is already full of, not the katakana every "matrix effect" reaches
 * for — the page is a terminal, not a film about one.
 *
 * Layout never moves: the string is always rendered at full length, only the
 * glyphs swap. The real text sits on the wrapper as `aria-label`, so a screen
 * reader gets the sentence and never the noise, and the noise itself is hidden.
 */
/**
 * ASCII only, and deliberately so: Martian Mono has no box-drawing glyphs, so
 * ▚▓░ and friends fall back to a different face with a different advance and
 * the headline visibly changes width while it resolves. Every character here
 * is one the display face actually ships, so the line never moves.
 */
const GLYPHS = "/\\|<>=+*#$%&@:;!?01";

export function Decrypt({
  text,
  delay = 0,
  className = "",
  as: Tag = "span",
}: {
  text: string;
  /** ms to wait before the line starts resolving */
  delay?: number;
  className?: string;
  as?: "span" | "div";
}) {
  // Static under reduced motion, and static if the effect never gets to run —
  // the readable text is the safe initial state on every path except the one
  // where we are definitely about to animate.
  const reduced =
    typeof window !== "undefined" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const [shown, setShown] = useState(() => (reduced ? text : scramble(text, 0)));
  const raf = useRef(0);

  useEffect(() => {
    if (reduced) {
      setShown(text);
      return;
    }

    const start = performance.now() + delay;
    const tick = (now: number) => {
      const elapsed = now - start;
      // Each character locks 26ms after the one before it; before it locks it
      // rerolls on a 60ms beat, slow enough to read as glyphs rather than fuzz.
      const settled = Math.floor(elapsed / 26);
      setShown(scramble(text, settled, Math.floor(elapsed / 60)));
      if (settled <= text.length) raf.current = requestAnimationFrame(tick);
      else setShown(text);
    };

    raf.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf.current);
  }, [text, delay, reduced]);

  // The real sentence is in the DOM, not just on an aria-label: this is the h1,
  // and a crawler that only sees the noise indexes the noise.
  return (
    <Tag className={className}>
      <span className="sr-only">{text}</span>
      <span aria-hidden>{shown}</span>
    </Tag>
  );
}

/**
 * Everything before `settled` is real text; the rest is noise. The noise is a
 * hash of position and beat rather than Math.random, so a glyph holds still
 * within a beat and only changes when the beat does — rerolling every frame
 * at 60fps reads as fuzz, not as characters.
 */
function scramble(text: string, settled: number, beat = 0) {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    if (i < settled || text[i] === " ") {
      out += text[i];
    } else {
      const h = (i * 2654435761 + beat * 40503) >>> 0;
      out += GLYPHS[h % GLYPHS.length];
    }
  }
  return out;
}
