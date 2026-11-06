import { Annotation, EditorState, RangeSetBuilder, StateEffect, StateField, Transaction, type Extension } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet, type PluginValue, type ViewUpdate } from "@codemirror/view";
import { isolateHistory } from "@codemirror/commands";
import { findEmbeds, fitBox, imageSrc, type Embed, type ImageScope } from "./embeds";
import { dropImage, knownImage, probeImage, worthProbing } from "./imageprobe";

/* The composer's half of images in the chat: `![alt](address)` draws as the image as soon
   as the address is known to load, and stays the characters it was until then or if it
   doesn't, so there's never a broken icon. The document is untouched: it's a source
   editor, and what's sent is what the text says. Same trick as the /command segment
   (MarkdownInput cmdDeco): a replace decoration, atomic, so arrows step over it and
   Backspace takes it whole.

   Stable by construction: the widgets are compared by what they show, so rebuilding the
   set on a keystroke keeps their DOM. Loading is lib/imageprobe's, once per URL, and is
   put off while someone is typing an address, whose every prefix would otherwise be a
   request. A caret already inside the markup keeps it as text until it leaves: an image
   appearing under the caret would throw out the person editing it. */

/** What to wait after a keystroke before asking whether an address loads. */
const TYPING_MS = 280;
export const WIDGET_CAP = 160;

export const setImageScope = StateEffect.define<ImageScope>();
/** A probe came back, or a drawn image stopped loading: draw again. */
const redraw = StateEffect.define<null>();
/** Open the address popover on the embed starting here. */
export const openEmbed = StateEffect.define<number>();

const scopeField = StateField.define<ImageScope>({
  create: () => ({}),
  update: (v, tr) => tr.effects.reduce((a, e) => (e.is(setImageScope) ? e.value : a), v),
});

class EmbedWidget extends WidgetType {
  constructor(readonly address: string, readonly alt: string, readonly url: string,
    readonly width: number, readonly height: number) { super(); }
  eq(o: EmbedWidget) {
    return o.url === this.url && o.alt === this.alt && o.width === this.width && o.height === this.height;
  }
  toDOM(view: EditorView) {
    const el = document.createElement("button");
    el.type = "button";
    el.className = "cm-embed";
    el.title = `${this.address}\nClick to change the address (Alt+Enter from beside it)`;
    el.setAttribute("aria-label", `Image${this.alt && this.alt !== "image" ? ` ${this.alt}` : ""}: ${this.address}. Change its address`);
    const img = document.createElement("img");
    img.src = this.url;
    img.alt = this.alt;
    img.draggable = false;
    img.referrerPolicy = "no-referrer";
    const box = fitBox(this.width, this.height, WIDGET_CAP);
    if (box) { img.width = box.width; img.height = box.height; }
    // It was there when probed and isn't now: back to the text, never a broken icon.
    img.onerror = () => { dropImage(this.url); view.dispatch({ effects: redraw.of(null) }); };
    el.append(img);
    // Down, and the caret and the focus stay put: an editor that isn't focused doesn't
    // have to be for this to work.
    el.addEventListener("mousedown", (e) => e.preventDefault());
    const open = () => view.dispatch({ effects: openEmbed.of(view.posAtDOM(el)) });
    el.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); open(); });
    el.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.stopPropagation(); open(); }
    });
    return el;
  }
  // The widget's own events are its own; the editor doesn't place a caret from them.
  ignoreEvent() { return true; }
}

type Drawn = { embeds: Embed[]; deco: DecorationSet };

function draw(state: EditorState, embeds: Embed[]): DecorationSet {
  if (!embeds.length) return Decoration.none;
  const scope = state.field(scopeField);
  const head = state.selection.main.head;
  const b = new RangeSetBuilder<Decoration>();
  for (const e of embeds) {
    const url = imageSrc(e.address, scope);
    const k = url ? knownImage(url) : null;
    if (!url || k?.state !== "ok") continue;
    if (head > e.from && head < e.to) continue;
    b.add(e.from, e.to, Decoration.replace({
      widget: new EmbedWidget(e.address, e.alt, url, k.width, k.height),
    }));
  }
  return b.finish();
}

const embedField = StateField.define<Drawn>({
  create: (state) => {
    const embeds = findEmbeds(state.doc.toString());
    return { embeds, deco: draw(state, embeds) };
  },
  update: (v, tr) => {
    const again = tr.effects.some((e) => e.is(redraw) || e.is(setImageScope));
    if (!tr.docChanged && !tr.selection && !again) return v;
    const embeds = tr.docChanged ? findEmbeds(tr.newDoc.toString()) : v.embeds;
    return { embeds, deco: draw(tr.state, embeds) };
  },
  provide: (f) => [
    EditorView.decorations.from(f, (v) => v.deco),
    EditorView.atomicRanges.of((view) => view.state.field(f).deco),
  ],
});

class Prober implements PluginValue {
  private timer = 0;
  constructor(readonly view: EditorView) { this.kick(0); }
  update(u: ViewUpdate) {
    const scoped = u.transactions.some((t) => t.effects.some((e) => e.is(setImageScope)));
    if (!u.docChanged && !scoped) return;
    const typing = u.transactions.some((t) => t.isUserEvent("input.type") || t.isUserEvent("delete"));
    this.kick(typing ? TYPING_MS : 0);
  }
  /** Never straight from update(): a view can't be dispatched to while it's updating. */
  private kick(ms: number) {
    clearTimeout(this.timer);
    this.timer = window.setTimeout(() => this.run(), ms);
  }
  private run() {
    const { view } = this;
    const scope = view.state.field(scopeField);
    for (const e of view.state.field(embedField).embeds) {
      const url = imageSrc(e.address, scope);
      if (!url || !worthProbing(url)) continue;
      void probeImage(url).then((s) => {
        // A miss changes nothing on screen, so it doesn't touch the view at all.
        if (s.state === "ok" && !this.dead) view.dispatch({ effects: redraw.of(null) });
      });
    }
  }
  private dead = false;
  destroy() { this.dead = true; clearTimeout(this.timer); }
}

// ---- where an upload lands -------------------------------------------------
// The image is inserted when the bridge answers, at the place you pasted it, whatever
// was typed in the meantime. The spot rides the document's changes in a field; pastes
// are filled in the order they were made, each next one landing after the last.

type Spot = { id: number; from: number; to: number };
export const reserveSpot = StateEffect.define<Spot>();
export const releaseSpot = StateEffect.define<number>();
const fillingSpot = Annotation.define<number>();

const spots = StateField.define<Spot[]>({
  create: () => [],
  update: (list, tr) => {
    const filling = tr.annotation(fillingSpot) !== undefined;
    let next = !tr.docChanged ? list : list.map((s) => {
      // Text typed at an empty spot stays after it, so the image lands where it was
      // pasted; a spot on a selection only ever shrinks. An insert filling the spot
      // pushes any spot sharing its place along behind it.
      const empty = s.from === s.to;
      const from = tr.changes.mapPos(s.from, filling ? 1 : empty ? -1 : 1);
      const to = tr.changes.mapPos(s.to, filling ? 1 : -1);
      return { id: s.id, from, to: Math.max(from, to) };
    });
    for (const e of tr.effects) {
      if (e.is(reserveSpot)) next = [...next, e.value];
      else if (e.is(releaseSpot)) next = next.filter((s) => s.id !== e.value);
    }
    return next;
  },
});

let nextSpot = 1;

/** Hold the place of an image still uploading. */
export function holdSpot(view: EditorView): number {
  const id = nextSpot++;
  const { from, to } = view.state.selection.main;
  view.dispatch({ effects: reserveSpot.of({ id, from, to }) });
  return id;
}

export const dropSpot = (view: EditorView, id: number) =>
  view.dispatch({ effects: releaseSpot.of(id) });

/** Its markdown goes in, as one undo step of its own. */
export function fillSpot(view: EditorView, id: number, markdown: string) {
  const s = view.state.field(spots).find((x) => x.id === id);
  if (!s) return;
  const sel = view.state.selection.main;
  // A caret still at the spot moves past the image; one that's moved on is left alone.
  const follow = sel.empty ? sel.head >= s.from && sel.head <= s.to : sel.from === s.from && sel.to === s.to;
  view.dispatch({
    changes: { from: s.from, to: s.to, insert: markdown },
    selection: follow ? { anchor: s.from + markdown.length } : undefined,
    effects: [releaseSpot.of(id), ...(follow ? [EditorView.scrollIntoView(s.from + markdown.length)] : [])],
    annotations: [fillingSpot.of(id), isolateHistory.of("full"), Transaction.userEvent.of("input.paste")],
  });
}

// ---- reading and editing, for the popover ----------------------------------

export const embedAtPos = (state: EditorState, pos: number) =>
  state.field(embedField).embeds.find((e) => e.from === pos);

/** The drawn image the caret is touching, for Alt+Enter. */
export function drawnAtCaret(state: EditorState): number | null {
  const { head, empty } = state.selection.main;
  if (!empty) return null;
  let at: number | null = null;
  state.field(embedField).deco.between(Math.max(0, head - 1), head + 1, (from, to) => {
    if (from === head || to === head) { at = from; return false; }
  });
  return at;
}

/** The DOM of the widget for the embed starting here, when it's drawn. */
export function widgetAt(view: EditorView, pos: number): HTMLElement | null {
  for (const el of Array.from(view.contentDOM.querySelectorAll<HTMLElement>(".cm-embed"))) {
    if (view.posAtDOM(el) === pos) return el;
  }
  return null;
}

/** An edit from the popover: its own undo step, not put off like typing. */
export const embedEdit = {
  annotations: [isolateHistory.of("full"), Transaction.userEvent.of("input.paste")],
};

/** Deleting a drawn image is its own undo step, so one Ctrl+Z brings back just it
 *  (history would otherwise fold it into the backspacing around it). */
const isolateDeletes = EditorState.transactionExtender.of((tr) => {
  if (!tr.docChanged || !tr.isUserEvent("delete")) return null;
  const { deco } = tr.startState.field(embedField);
  let hit = false;
  tr.changes.iterChangedRanges((a, b) => {
    deco.between(a, b, (from, to) => {
      if (from >= a && to <= b) { hit = true; return false; }
    });
  });
  return hit ? { annotations: isolateHistory.of("full") } : null;
});

export function imageEmbeds(): Extension {
  return [scopeField, embedField, spots, isolateDeletes, ViewPlugin.fromClass(Prober)];
}
