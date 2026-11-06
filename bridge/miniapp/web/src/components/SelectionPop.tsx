import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { selectionMd } from "../lib/selmd";
import { explainText, translateText, useRefSession } from "../lib/readapi";
import { Markdown } from "./Markdown";

// Select words in an agent's message: quote, explain, translate or copy them. In a portal:
// the transcript sits under a transformed ancestor, and `fixed` inside one is measured from
// that instead of the window, which put this a sidebar's width off. Only agent text
// (.md inside `root`, without data-typed): your own prompt has nothing to quote and nothing to
// translate. On glass the phone's own selection handles and menu sit above the words, so this
// goes below them. Same file in both apps.

type Pick = { text: string; plain: string; context: string; message: string; rect: DOMRect };
type Done = { from?: string; text: string; markdown?: boolean };

export function SelectionPop({ root, onQuote, canTranslate = true, canExplain = true }: {
  root: string;
  onQuote?: (text: string) => void;
  canTranslate?: boolean;
  canExplain?: boolean;
}) {
  const session = useRefSession();
  const [pick, setPick] = useState<Pick | null>(null);
  const [said, setSaid] = useState<{ wait?: string; error?: string; done?: Done } | null>(null);
  const [copied, setCopied] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const asked = useRef("");

  const close = useCallback(() => { setPick(null); setSaid(null); asked.current = ""; }, []);

  useEffect(() => {
    let dragging = false;
    let wait: number | undefined;
    const read = () => {
      const sel = window.getSelection();
      const plain = sel?.toString().trim();
      if (!sel || sel.isCollapsed || !plain || !sel.rangeCount) {
        // An answer on screen outlives the selection, until you press somewhere else.
        if (!asked.current) setPick(null);
        return;
      }
      const node = sel.anchorNode;
      const el = node && (node.nodeType === 1 ? (node as Element) : node.parentElement);
      const md = el?.closest(".md");
      if (!md || md.hasAttribute("data-typed") || !el?.closest(root)) { if (!asked.current) setPick(null); return; }
      const rect = sel.getRangeAt(0).getBoundingClientRect();
      const block = el?.closest("p,li,td,blockquote,h1,h2,h3,h4") ?? md;
      setPick({ text: selectionMd() ?? plain, plain, context: (block.textContent ?? "").slice(0, 600), message: (md.textContent ?? "").slice(0, 4000), rect });
    };
    const down = (e: PointerEvent) => {
      if (box.current?.contains(e.target as Node)) return;
      dragging = true;
      close();
    };
    const up = () => { dragging = false; window.setTimeout(read, 10); };
    const change = () => {
      if (dragging) return;
      window.clearTimeout(wait);
      wait = window.setTimeout(read, 250);      // a phone's handles have no mouse-up to wait for
    };
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
    document.addEventListener("pointerdown", down, true);
    document.addEventListener("pointerup", up, true);
    document.addEventListener("selectionchange", change);
    document.addEventListener("keydown", key);
    window.addEventListener("scroll", read, true);
    return () => {
      window.clearTimeout(wait);
      document.removeEventListener("pointerdown", down, true);
      document.removeEventListener("pointerup", up, true);
      document.removeEventListener("selectionchange", change);
      document.removeEventListener("keydown", key);
      window.removeEventListener("scroll", read, true);
    };
  }, [root, close]);

  if (!pick) return null;
  const aside = async (doing: string, ask: (s: string) => Promise<Done>) => {
    if (!session) return;
    const mine = `${doing}\n${pick.plain}`;
    asked.current = mine;
    setSaid({ wait: doing });
    try {
      const done = await ask(session);
      if (asked.current === mine) setSaid({ done });
    } catch (e) {
      if (asked.current === mine) setSaid({ error: e instanceof Error ? e.message : "That didn't work." });
    }
  };
  const translate = () => aside("Translating…", (s) => translateText(s, pick.plain, pick.context, (navigator.language || "en").split("-")[0]));
  const explain = () => aside("Explaining…", async (s) => ({ ...(await explainText(s, pick.plain, pick.message)), markdown: true }));
  const coarse = window.matchMedia?.("(pointer: coarse)").matches;
  // The answer needs room too, and it grows from the side it's on.
  const above = !coarse && pick.rect.top > (said ? window.innerHeight * 0.45 : 60);
  const half = Math.min(said ? 210 : 150, window.innerWidth / 2 - 8);
  const left = Math.max(half + 8, Math.min(pick.rect.left + pick.rect.width / 2, window.innerWidth - half - 8));
  return createPortal(
    <div ref={box} className="rd-pop" role="toolbar" aria-label="Selected text"
      style={{ left, ...(above ? { bottom: window.innerHeight - pick.rect.top + 8 } : { top: pick.rect.bottom + (coarse ? 26 : 8) }) }}
      // A press in here must not take the selection away.
      onMouseDown={(e) => { if (!(e.target as Element).closest(".rd-out")) e.preventDefault(); }}>
      <div className="rd-pop-row">
        {onQuote ? (
          <button type="button" onClick={() => { onQuote(pick.text); window.getSelection()?.removeAllRanges(); close(); }}>Quote reply</button>
        ) : null}
        {canExplain && session ? <button type="button" disabled={!!said?.wait} onClick={() => void explain()}>Explain</button> : null}
        {canTranslate && session ? <button type="button" disabled={!!said?.wait} onClick={() => void translate()}>Translate</button> : null}
        <button type="button" onClick={() => {
          void navigator.clipboard?.writeText(pick.text);
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1200);
        }}>{copied ? "Copied" : "Copy"}</button>
      </div>
      {said ? (
        <div className="rd-out" role="status">
          {said.wait ? <span className="rd-wait">{said.wait}</span> : null}
          {said.error ? <span className="rd-err">{said.error}</span> : null}
          {said.done ? (
            <>
              {said.done.from ? <div className="rd-from">{said.done.from}</div> : null}
              {said.done.markdown ? <Markdown>{said.done.text}</Markdown> : <div className="rd-text">{said.done.text}</div>}
            </>
          ) : null}
        </div>
      ) : null}
    </div>,
    document.body,
  );
}
