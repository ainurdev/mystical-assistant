import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { imagesIn, type Ref } from "../lib/refs";
import { InlineImage, openOnComputer, postRefs, useRefSession } from "../lib/readapi";

// A file an agent named, as something you can press (bridge/chat_files.py says which are real).
// Until the bridge says yes, and if it says no, this draws exactly what was there before, so
// a word never flickers into a dead link. Own components with their own hooks, rather than
// anything read in Markdown: that one is memoized because re-parsing a long turn is the most
// expensive thing the transcript does. The same file is in both apps, and lib/readapi is
// each one's way to the bridge.

type Seen = { ref: Ref | null; until: number };
const seen = new Map<string, Seen>();
const waiting = new Map<string, Set<string>>();
const told = new Set<() => void>();
let timer: number | undefined;
// A file the agent is about to write doesn't exist yet: ask again before long.
const YES = 5 * 60_000, NO = 20_000;

const keyOf = (session: string, address: string) => `${session}\n${address}`;

function flush() {
  timer = undefined;
  const asks = [...waiting];
  waiting.clear();
  for (const [session, set] of asks) {
    const addresses = [...set];
    void postRefs(session, addresses).then((refs) => {
      const now = Date.now();
      for (const a of addresses) seen.set(keyOf(session, a), refs[a] ? { ref: refs[a], until: now + YES } : { ref: null, until: now + NO });
      told.forEach((f) => f());
    }).catch(() => { /* a bridge without the route: everything stays a word */ });
  }
}

function useFileRef(address: string | null): Ref | null {
  const session = useRefSession();
  const [, tick] = useState(0);
  useEffect(() => {
    if (!session || !address) return;
    const f = () => tick((n) => n + 1);
    told.add(f);
    const hit = seen.get(keyOf(session, address));
    if (!hit || hit.until < Date.now()) {
      const set = waiting.get(session) ?? new Set<string>();
      set.add(address);
      waiting.set(session, set);
      timer ??= window.setTimeout(flush, 40);
    }
    return () => { told.delete(f); };
  }, [session, address]);
  return session && address ? seen.get(keyOf(session, address))?.ref ?? null : null;
}

type View = (path: string, line?: number, at?: { x: number; y: number }) => void;

function Menu({ item: r, session, at, onView, onClose }: { item: Ref; session: string; at: DOMRect; onView?: View; onClose: () => void }) {
  const box = useRef<HTMLDivElement>(null);
  const [said, setSaid] = useState("");
  useEffect(() => {
    const away = (e: PointerEvent) => { if (!box.current?.contains(e.target as Node)) onClose(); };
    const key = (e: globalThis.KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("pointerdown", away, true);
    window.addEventListener("keydown", key);
    window.addEventListener("scroll", onClose, true);
    return () => {
      window.removeEventListener("pointerdown", away, true);
      window.removeEventListener("keydown", key);
      window.removeEventListener("scroll", onClose, true);
    };
  }, [onClose]);
  const open = async () => {
    setSaid("Opening…");
    const err = await openOnComputer(session, r.path ?? r.rel);
    if (err) setSaid(err); else onClose();
  };
  const left = Math.max(8, Math.min(at.left, window.innerWidth - 268));
  const below = at.bottom + 240 < window.innerHeight || r.kind !== "image" && at.bottom + 130 < window.innerHeight;
  return createPortal(
    <div ref={box} className="rd-menu" role="menu" style={below ? { left, top: at.bottom + 4 } : { left, bottom: window.innerHeight - at.top + 4 }}>
      <div className="rd-menu-path" title={r.path ?? r.rel}>{r.rel}</div>
      {r.kind === "image" && r.path ? <div className="rd-menu-img"><InlineImage address={r.path} /></div> : null}
      <button type="button" role="menuitem" onClick={() => void open()}>Open on computer</button>
      {onView && r.kind === "file" ? (
        <button type="button" role="menuitem" onClick={() => { onView(r.rel, r.line, { x: at.left, y: at.bottom + 4 }); onClose(); }}>View in editor</button>
      ) : null}
      <button type="button" role="menuitem" onClick={() => { void navigator.clipboard?.writeText(r.path ?? r.rel); onClose(); }}>Copy path</button>
      {said ? <div className="rd-menu-said" role="status">{said}</div> : null}
    </div>,
    document.body,
  );
}

export function FileRef({ address, md, onView, link, children }: {
  address: string;
  /** What this copies back as (lib/selmd). */
  md: string;
  /** Drawn once it's a link, where that differs: a code span leaves its copy glyph behind,
   *  as the menu has Copy path and a button can't sit in a button. */
  link?: ReactNode;
  /** Show it in the app's own editor. Absent on the phone, which has none here. */
  onView?: View;
  children: ReactNode;
}) {
  const session = useRefSession();
  const r = useFileRef(address);
  const [at, setAt] = useState<DOMRect | null>(null);
  if (!r || (r.kind === "ambiguous" && !onView)) return <>{children}</>;
  const press = (el: HTMLElement) => {
    const box = el.getBoundingClientRect();
    // Two files could be meant: the editor's picker already asks which.
    if (r.kind === "ambiguous") onView?.(address.replace(/(:\d+){1,2}$/, ""), r.line, { x: box.left, y: box.bottom + 4 });
    else setAt(box);
  };
  const click = (e: MouseEvent<HTMLElement>) => {
    // The end of a drag across the name is a selection, not a press.
    if (!window.getSelection()?.isCollapsed) return;
    e.preventDefault();
    press(e.currentTarget);
  };
  const key = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); press(e.currentTarget); }
  };
  return (
    <>
      {/* a span, since a button's words can't be selected */}
      <span className="rd-ref" role="button" tabIndex={0} data-md={md} data-kind={r.kind} title={r.path ?? r.rel} onClick={click} onKeyDown={key}>
        {link ?? children}
      </span>
      {at ? <Menu item={r} session={session ?? ""} at={at} onView={onView} onClose={() => setAt(null)} /> : null}
    </>
  );
}

function RefImage({ address }: { address: string }) {
  const r = useFileRef(address);
  return r?.kind === "image" && r.path ? <div className="rd-img"><InlineImage address={r.path} /></div> : null;
}

/** The pictures a message names, drawn under it. Each is only there if the file is. */
export function RefImages({ text }: { text: string }) {
  const images = useMemo(() => imagesIn(text), [text]);
  return images.length ? <div className="rd-imgs">{images.map((a) => <RefImage key={a} address={a} />)}</div> : null;
}
