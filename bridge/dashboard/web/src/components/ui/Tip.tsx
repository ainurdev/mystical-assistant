import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { chord } from "../../lib/chord";
import { inField, keyUsed, nudged, nudgeDue, type Nudges } from "../../lib/shortcuts";
import { Keys } from "./Keys";

// The HUD's own explanation box, in its type instead of the browser's yellow
// one: hover settles for a beat before it opens (so sweeping across a row
// doesn't strobe), Escape and blur close it. Touch has no hover at all, which
// is the other half of why `title` had to go.
const DELAY = 400;

// `keys`: the control's shortcut, drawn as keycaps after the text (a control's data-key).
function Bubble({ text, keys, inner }: { text: string; keys?: string; inner?: React.Ref<HTMLSpanElement> }) {
  return (
    <span ref={inner} style={{ display: keys ? "flex" : "block", alignItems: "center", gap: 12,
                   width: "max-content", maxWidth: 300, whiteSpace: "pre-line",
                   border: "1px solid color-mix(in srgb, var(--acc) 35%, transparent)",
                   background: "color-mix(in srgb, var(--panel2) 98%, transparent)",
                   boxShadow: "0 -8px 26px var(--shadow-pop)", animation: "mpop .12s ease",
                   color: "var(--txm)", fontSize: "var(--t105)", lineHeight: 1.65, letterSpacing: ".2px", padding: "9px 11px" }}>
      {keys ? <><span>{text}</span><Keys k={keys} /></> : text}
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

// `left`: beside the trigger, for a column of them (the right rail), where a box
// above would sit on the tile above it.
type Live = { text: string; keys?: string; x: number; y: number; below: boolean; left?: boolean };

const TIP_ID = "hud-tip";

// The nudge: a click on a control that has a shortcut shows its key beside it,
// in this box, three times at most, never once you've pressed that key
// (lib/shortcuts). Counted in this browser, so a second window learns on its own.
const NUDGE_KEY = "hud-nudges";
const NUDGE_MS = 2500;
function loadNudges(): Nudges {
  try { return JSON.parse(localStorage.getItem(NUDGE_KEY) ?? "{}") as Nudges; } catch { return {}; }
}
function saveNudges(n: Nudges) {
  try { localStorage.setItem(NUDGE_KEY, JSON.stringify(n)); } catch { /* private mode: it just nudges again */ }
}

// Where a box for `t` goes: above it (below near the top), or beside it for a column of them.
function place(t: HTMLElement, text: string, keys?: string): Live {
  const r = t.getBoundingClientRect();
  // the themed wrapper carries a CSS filter, so it — not the viewport —
  // is what `position: fixed` inside it resolves against
  const host = t.closest("[data-theme]")?.getBoundingClientRect();
  const below = r.top < 130;
  const left = t.dataset.tipSide === "left";
  return {
    text, keys, below, left,
    x: (left ? r.left : r.left + r.width / 2) - (host?.left ?? 0),
    y: (left ? r.top + r.height / 2 : below ? r.bottom : r.top) - (host?.top ?? 0),
  };
}

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
        setTip(place(t, text, t.dataset.key));
      }, DELAY);
    };
    // A click with the mouse on a control that has a key: show the key, if it's due.
    // detail 0 is Enter or Space on a focused button — that hand is on the keys already.
    const click = (e: MouseEvent) => {
      const t = (e.target as Element | null)?.closest?.("[data-key]") as HTMLElement | null;
      const k = t?.dataset.key;
      if (!t || !k || e.detail === 0) return;
      const n = loadNudges();
      if (!nudgeDue(n, k)) return;
      saveNudges(nudged(n, k));
      // a frame later: the click may fold what was clicked away (the sidebar's ◂)
      requestAnimationFrame(() => {
        if (!t.isConnected) return;
        window.clearTimeout(timer);
        el = t;
        setTip(place(t, "next time", k));
        timer = window.setTimeout(hide, NUDGE_MS);
      });
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") hide();
      // a shortcut some control here advertises was pressed: its nudge is done.
      // Not a bare key typed in a field: a / in the message box starts a command.
      const c = chord(e);
      if ((e.metaKey || e.ctrlKey || e.altKey || !inField(e.target))
          && document.querySelector(`[data-key="${CSS.escape(c)}"]`)) saveNudges(keyUsed(loadNudges(), c));
    };

    document.addEventListener("pointerover", over, true);
    document.addEventListener("pointerdown", hide, true);
    document.addEventListener("click", click, true);
    document.addEventListener("keydown", key, true);
    window.addEventListener("scroll", hide, true);
    window.addEventListener("blur", hide);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("pointerover", over, true);
      document.removeEventListener("pointerdown", hide, true);
      document.removeEventListener("click", click, true);
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
               transform: tip.left ? "translate(-100%, -50%)" : `translateX(-50%)${tip.below ? "" : " translateY(-100%)"}`,
               [tip.left ? "paddingRight" : tip.below ? "paddingTop" : "paddingBottom"]: tip.left ? 9 : 7 }}>
      <Bubble text={tip.text} keys={tip.keys} inner={bub} />
    </span>
  );
}
