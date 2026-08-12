import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";

// The HUD's own explanation box, in its type instead of the browser's yellow
// one: hover settles for a beat before it opens (so sweeping across a row
// doesn't strobe), Escape and blur close it. Touch has no hover at all, which
// is the other half of why `title` had to go.
const DELAY = 400;

function Bubble({ text, inner }: { text: string; inner?: React.Ref<HTMLSpanElement> }) {
  return (
    <span ref={inner} style={{ display: "block", width: "max-content", maxWidth: 300, whiteSpace: "pre-line",
                   border: "1px solid color-mix(in srgb, var(--acc) 35%, transparent)",
                   background: "color-mix(in srgb, var(--panel2) 98%, transparent)",
                   boxShadow: "0 -8px 26px var(--shadow-pop)", animation: "mpop .12s ease",
                   color: "var(--txm)", fontSize: "var(--t105)", lineHeight: 1.65, letterSpacing: ".2px", padding: "9px 11px" }}>
      {text}
    </span>
  );
}

// Explicit wrapper — for triggers that exist only to explain something (the ⓘ
// buttons), where the tip is the point and click should pin it open.
// ponytail: one absolutely-positioned span, no floating-ui, no portal.
export function Tip({ text, anchor = "center", pin = true, children }: {
  text: string;
  anchor?: "center" | "right"; // "right" for the last cluster — a centred box would hang off the edge
  pin?: boolean; // off when the trigger does something of its own — the click closes the tip instead
  children: ReactNode;
}) {
  const [hover, setHover] = useState(false);
  const [pinned, setPinned] = useState(false);
  const timer = useRef(0);
  const open = () => { window.clearTimeout(timer.current); timer.current = window.setTimeout(() => setHover(true), DELAY); };
  const close = () => { window.clearTimeout(timer.current); setHover(false); };
  useEffect(() => () => window.clearTimeout(timer.current), []);
  return (
    <span
      style={{ position: "relative", display: "inline-flex", flex: "none" }}
      onMouseEnter={open}
      onMouseLeave={close}
      onFocus={() => setHover(true)}
      onBlur={() => { close(); setPinned(false); }}
      onClick={() => { close(); setPinned((p) => pin && !p); }}
      onKeyDown={(e) => { if (e.key === "Escape") { close(); setPinned(false); } }}
    >
      {children}
      {(hover || pinned) && (
        <span role="tooltip"
          style={{ position: "absolute", bottom: "100%", paddingBottom: 7, zIndex: 40, pointerEvents: "none",
                   ...(anchor === "right" ? { right: 0 } : { left: "50%", transform: "translateX(-50%)" }) }}>
          <Bubble text={text} />
        </span>
      )}
    </span>
  );
}

// Elements whose `title` is an accessible name, not a hover hint — the browser
// never shows a box for these, so leave them alone.
const KEEP = new Set(["IFRAME", "SVG", "TITLE", "LINK", "OPTION", "OPTGROUP"]);

type Live = { text: string; x: number; y: number; below: boolean };

const TIP_ID = "hud-tip";

// Everything else in the HUD says what it does through a plain `title=""`.
// One delegated listener repaints all of them in the HUD's type, so a title
// added anywhere later is styled with no wiring.
// ponytail: the title moves to data-tip on first hover instead of rewriting a
// hundred call sites; React only re-sets it when the string itself changes,
// and that fresh string is picked up on the next hover.
export function NativeTips() {
  const [tip, setTip] = useState<Live | null>(null);
  const bub = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    let el: HTMLElement | null = null;
    let timer = 0;
    const hide = () => {
      window.clearTimeout(timer);
      el?.removeAttribute("aria-describedby");
      el = null;
      setTip(null);
    };

    const over = (e: PointerEvent) => {
      const t = (e.target as Element | null)?.closest?.("[title],[data-tip]") as HTMLElement | null;
      if (t === el) return;
      window.clearTimeout(timer);
      el?.removeAttribute("aria-describedby");
      setTip(null);
      el = t;
      if (!t || KEEP.has(t.tagName)) return;
      const raw = t.getAttribute("title");
      if (raw) {
        t.dataset.tip = raw;
        t.removeAttribute("title");
        // the title was the only accessible name on icon-only buttons — keep it
        if (!t.getAttribute("aria-label") && !t.textContent?.trim()) t.setAttribute("aria-label", raw);
      }
      const text = t.dataset.tip;
      if (!text) return;
      timer = window.setTimeout(() => {
        t.setAttribute("aria-describedby", TIP_ID); // native `title` was a description too
        const r = t.getBoundingClientRect();
        // the themed wrapper carries a CSS filter, so it — not the viewport —
        // is what `position: fixed` inside it resolves against
        const host = t.closest("[data-theme]")?.getBoundingClientRect();
        const below = r.top < 130;
        setTip({
          text,
          x: r.left + r.width / 2 - (host?.left ?? 0),
          y: (below ? r.bottom : r.top) - (host?.top ?? 0),
          below,
        });
      }, DELAY);
    };
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") hide(); };

    document.addEventListener("pointerover", over, true);
    document.addEventListener("pointerdown", hide, true);
    document.addEventListener("keydown", key, true);
    window.addEventListener("scroll", hide, true);
    window.addEventListener("blur", hide);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("pointerover", over, true);
      document.removeEventListener("pointerdown", hide, true);
      document.removeEventListener("keydown", key, true);
      window.removeEventListener("scroll", hide, true);
      window.removeEventListener("blur", hide);
    };
  }, []);

  // centred on the trigger until that would run off an edge, then nudged back in
  useLayoutEffect(() => {
    const b = bub.current;
    if (!b) return;
    b.style.transform = "";
    const r = b.getBoundingClientRect();
    const dx = r.left < 8 ? 8 - r.left : r.right > window.innerWidth - 8 ? window.innerWidth - 8 - r.right : 0;
    if (dx) b.style.transform = `translateX(${dx}px)`;
  }, [tip]);

  if (!tip) return null;
  return (
    <span role="tooltip" id={TIP_ID}
      style={{ position: "fixed", left: tip.x, top: tip.y, zIndex: 98, pointerEvents: "none",
               transform: `translateX(-50%)${tip.below ? "" : " translateY(-100%)"}`,
               [tip.below ? "paddingTop" : "paddingBottom"]: 7 }}>
      <Bubble text={tip.text} inner={bub} />
    </span>
  );
}
