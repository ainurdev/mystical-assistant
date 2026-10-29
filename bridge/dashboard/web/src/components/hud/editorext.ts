import { StateEffect, StateField, type EditorState, type Extension } from "@codemirror/state";
import { Decoration, EditorView, hoverTooltip, ViewPlugin, WidgetType, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import { syntaxTree } from "@codemirror/language";
import { getChunks } from "@codemirror/merge";
import { highlightTree, type Highlighter } from "@lezer/highlight";
import { enclosing } from "../../lib/symbols";

/* The EDITOR's reading and tracing aids, as CodeMirror extensions. Each one is
   self-contained DOM, styled by EditorTab's crtTheme (`.cm-sticky`, `.cm-ruler`,
   `.cm-peek`, `.cm-symhover`, `.cm-modlink`), so a tab switch that rebuilds the
   view rebuilds them with it.

   - stickyScroll: the definitions around the top visible line stay pinned
     above it (VS Code's sticky scroll), clickable.
   - overviewRuler: marks down the right edge for the word under the cursor,
     the diff's chunks and the cursor, across the whole file.
   - peekField / setPeek: a block under a line holding another place's code
     (⌥F12), built by the caller.
   - symbolHover: the definition's signature and comment under the pointer.
   - modClick: ⌘/Ctrl-hover underlines a name, ⌘/Ctrl-click goes to it. */

type Tree = ReturnType<typeof syntaxTree>;

/** Code as DOM: lines `first..last` (1-based) of `text`, coloured by `hl` over
 *  `tree` (parsed from the same text), with line numbers; `mark` gets the lit row. */
export function codeLines(text: string, tree: Tree | null, hl: Highlighter, first: number, last: number, mark?: number): HTMLElement {
  const box = document.createElement("div");
  box.className = "cm-codelines";
  const lines = text.split("\n");
  let off = 0;
  for (let i = 0; i < first - 1 && i < lines.length; i++) off += lines[i].length + 1;
  const spans: [number, number, string][] = [];
  const end = off + lines.slice(first - 1, last).join("\n").length;
  if (tree) highlightTree(tree, hl, (from, to, cls) => { spans.push([from, to, cls]); }, off, end);
  let si = 0;
  for (let n = first; n <= last && n <= lines.length; n++) {
    const l = lines[n - 1], lineEnd = off + l.length;
    const row = document.createElement("div");
    row.className = n === mark ? "cm-codeline cm-codeline-on" : "cm-codeline";
    const num = document.createElement("span");
    num.className = "cm-codenum";
    num.textContent = String(n);
    const code = document.createElement("span");
    code.className = "cm-codetext";
    let at = off;
    while (si < spans.length && spans[si][1] <= off) si++;
    for (let j = si; j < spans.length && spans[j][0] < lineEnd; j++) {
      const a = Math.max(spans[j][0], off), b = Math.min(spans[j][1], lineEnd);
      if (a > at) code.append(text.slice(at, a));
      const s = document.createElement("span");
      s.className = spans[j][2];
      s.textContent = text.slice(a, b);
      code.append(s);
      at = b;
    }
    if (lineEnd > at) code.append(text.slice(at, lineEnd));
    row.append(num, code);
    box.append(row);
    off = lineEnd + 1;
  }
  return box;
}

/* ---- sticky scroll ---- */

export function stickyScroll(hl: Highlighter, onJump: (line: number) => void): Extension {
  return ViewPlugin.fromClass(class {
    dom = document.createElement("div");
    key = "";
    constructor(readonly view: EditorView) {
      this.dom.className = "cm-sticky";
      this.dom.addEventListener("mousedown", (e) => {
        const n = (e.target as HTMLElement).closest<HTMLElement>("[data-line]")?.dataset.line;
        if (!n) return;
        e.preventDefault();
        onJump(Number(n));
      });
      // It sits over the scroller, not in it, so hand the wheel down.
      this.dom.addEventListener("wheel", (e) => {
        view.scrollDOM.scrollTop += e.deltaY;
        view.scrollDOM.scrollLeft += e.deltaX;
        e.preventDefault();
      }, { passive: false });
      view.dom.appendChild(this.dom);
      view.scrollDOM.addEventListener("scroll", this.schedule, { passive: true });
      this.schedule();
    }
    schedule = () => this.view.requestMeasure({ key: this, read: (v) => this.read(v), write: (m) => this.write(m) });
    update(u: ViewUpdate) { if (u.docChanged || u.viewportChanged || u.geometryChanged) this.schedule(); }
    read(view: EditorView) {
      const top = view.scrollDOM.getBoundingClientRect().top - view.documentTop;
      if (top <= 0) return null;
      const lineH = view.defaultLineHeight;
      const at = view.lineBlockAtHeight(top + lineH * 0.5);
      const topLine = view.state.doc.lineAt(at.from).number;
      // The ones whose first line has scrolled away; the innermost three.
      const chain = enclosing(view.state, at.from, 50).filter((s) => s.line < topLine).slice(-3);
      const gut = view.dom.querySelector<HTMLElement>(".cm-gutters")?.getBoundingClientRect().width ?? 0;
      return { lines: chain.map((s) => s.line), gut, left: view.scrollDOM.scrollLeft };
    }
    write(m: { lines: number[]; gut: number; left: number } | null) {
      const key = m ? `${m.lines.join(",")}|${m.gut}|${m.left}` : "";
      if (key === this.key) return;
      this.key = key;
      this.dom.replaceChildren();
      this.dom.style.display = m && m.lines.length ? "" : "none";
      if (!m) return;
      const { state } = this.view;
      for (const n of m.lines) {
        const line = state.doc.line(n);
        const row = document.createElement("div");
        row.className = "cm-sticky-line";
        row.dataset.line = String(n);
        const num = document.createElement("span");
        num.className = "cm-sticky-num";
        num.style.width = `${m.gut}px`;
        num.textContent = String(n);
        const code = document.createElement("span");
        code.className = "cm-sticky-code";
        code.style.transform = `translateX(${-m.left}px)`;
        let at = line.from;
        const put = (to: number, cls: string) => {
          if (to <= at) return;
          const s = document.createElement("span");
          if (cls) s.className = cls;
          s.textContent = state.doc.sliceString(at, to);
          code.append(s);
          at = to;
        };
        highlightTree(syntaxTree(state), hl, (from, to, cls) => { put(from, ""); put(Math.min(to, line.to), cls); }, line.from, line.to);
        put(line.to, "");
        row.append(num, code);
        this.dom.append(row);
      }
    }
    destroy() {
      this.view.scrollDOM.removeEventListener("scroll", this.schedule);
      this.dom.remove();
    }
  });
}

/* ---- overview ruler ---- */

const escRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Lines holding `word` as a whole name, at most `cap` of them. */
export function wordLines(state: EditorState, word: string, cap = 400): number[] {
  if (state.doc.length > 2_000_000) return [];
  const re = new RegExp(`(?<![\\w$])${escRe(word)}(?![\\w$])`, "g");
  const text = state.doc.toString(), out: number[] = [];
  for (let m = re.exec(text); m && out.length < cap; m = re.exec(text)) {
    const n = state.doc.lineAt(m.index).number;
    if (out[out.length - 1] !== n) out.push(n);
  }
  return out;
}

export function overviewRuler(): Extension {
  return ViewPlugin.fromClass(class {
    dom = document.createElement("div");
    constructor(readonly view: EditorView) {
      this.dom.className = "cm-ruler";
      view.dom.appendChild(this.dom);
      this.draw();
    }
    update(u: ViewUpdate) { if (u.docChanged || u.selectionSet || u.heightChanged) this.draw(); }
    draw() {
      const { state } = this.view, total = Math.max(1, state.doc.lines);
      const at = (n: number) => `${((n - 1) / total) * 100}%`;
      const marks: string[] = [];
      const sel = state.selection.main, w = sel.empty ? state.wordAt(sel.head) : null;
      if (w && w.to - w.from > 1) for (const n of wordLines(state, state.sliceDoc(w.from, w.to))) marks.push(`<i data-k="w" style="top:${at(n)}"></i>`);
      for (const c of getChunks(state)?.chunks ?? []) {
        const a = state.doc.lineAt(c.fromB).number, b = state.doc.lineAt(Math.max(c.fromB, c.toB - 1)).number;
        const k = c.fromA === c.toA ? "add" : c.fromB === c.toB ? "del" : "mod";
        marks.push(`<i data-k="${k}" style="top:${at(a)};height:${Math.max(3, ((b - a + 1) / total) * 100)}${b > a ? "%" : "px"}"></i>`);
      }
      marks.push(`<i data-k="cur" style="top:${at(state.doc.lineAt(sel.head).number)}"></i>`);
      this.dom.innerHTML = marks.join("");
    }
    destroy() { this.dom.remove(); }
  });
}

/* ---- peek ---- */

export interface PeekSpec { line: number; dom: () => HTMLElement }
export const setPeek = StateEffect.define<PeekSpec | null>();

class PeekWidget extends WidgetType {
  constructor(readonly spec: PeekSpec) { super(); }
  eq(o: PeekWidget) { return o.spec === this.spec; }
  toDOM() { return this.spec.dom(); }
  ignoreEvent() { return true; }
}

export const peekField = StateField.define<{ spec: PeekSpec | null; deco: DecorationSet }>({
  create: () => ({ spec: null, deco: Decoration.none }),
  update(v, tr) {
    for (const e of tr.effects) {
      if (!e.is(setPeek)) continue;
      const spec = e.value;
      if (!spec) return { spec: null, deco: Decoration.none };
      const at = tr.state.doc.line(Math.min(spec.line, tr.state.doc.lines)).to;
      return { spec, deco: Decoration.set([Decoration.widget({ widget: new PeekWidget(spec), block: true, side: 1 }).range(at)]) };
    }
    // An edit closes it: the line it hangs under may be gone.
    return tr.docChanged && v.spec ? { spec: null, deco: Decoration.none } : v;
  },
  provide: (f) => EditorView.decorations.from(f, (v) => v.deco),
});

export const peekOpen = (s: EditorState) => !!s.field(peekField, false)?.spec;

/** The peek's frame: a head row (file, where, tag, open, close) over `body`. */
export function peekDom(o: { file: string; where: string; tag: string; body: HTMLElement; onOpen: () => void; onClose: () => void }): HTMLElement {
  const box = document.createElement("div");
  box.className = "cm-peek";
  const head = document.createElement("div");
  head.className = "cm-peek-head";
  const btn = (label: string, title: string, on: () => void) => {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = label;
    b.title = title;
    b.addEventListener("mousedown", (e) => { e.preventDefault(); on(); });
    return b;
  };
  const file = document.createElement("b");
  file.textContent = o.file;
  const where = document.createElement("span");
  where.textContent = o.where;
  const tag = document.createElement("em");
  tag.textContent = o.tag;
  head.append(file, where, tag, btn("open ↗", "open it · F12", o.onOpen), btn("✕", "close · esc", o.onClose));
  box.append(head, o.body);
  return box;
}

/* ---- hover ---- */

export interface HoverInfo { sig: HTMLElement; doc: string; where: string; refs?: number }

export function symbolHover(lookup: (word: string, pos: number, view: EditorView) => Promise<HoverInfo | null>): Extension {
  return hoverTooltip(async (view, pos, side) => {
    const w = view.state.wordAt(pos);
    if (!w) return null;
    const node = syntaxTree(view.state).resolveInner(pos, side);
    const word = view.state.sliceDoc(w.from, w.to);
    // Keyword tokens are named after themselves; comments and strings aren't code.
    if (node.name === word || /Comment|String|Template/.test(node.name) || !/^[A-Za-z_$][\w$]*$/.test(word)) return null;
    const info = await lookup(word, pos, view);
    if (!info) return null;
    return {
      pos: w.from, end: w.to, above: false,
      create: () => {
        const dom = document.createElement("div");
        dom.className = "cm-symhover";
        const doc = document.createElement("div");
        doc.className = "cm-symhover-doc";
        doc.textContent = info.doc;
        const foot = document.createElement("div");
        foot.className = "cm-symhover-foot";
        foot.textContent = `${info.where}${info.refs != null ? ` · ${info.refs} reference${info.refs === 1 ? "" : "s"}` : ""}   ⌘-click go · ⌥F12 peek · ⇧F12 refs`;
        dom.append(info.sig, ...(info.doc ? [doc] : []), foot);
        return { dom };
      },
    };
  }, { hoverTime: 450 });
}

/* ---- ⌘-click ---- */

const linkMark = Decoration.mark({ class: "cm-modlink" });

export function modClick(go: (pos: number) => void): Extension {
  return ViewPlugin.fromClass(class {
    deco = Decoration.none;
    key = "";
    constructor(readonly view: EditorView) {}
    set(r: { from: number; to: number } | null) {
      const key = r ? `${r.from}:${r.to}` : "";
      if (key === this.key) return;
      this.key = key;
      this.deco = r ? Decoration.set([linkMark.range(r.from, r.to)]) : Decoration.none;
      this.view.dispatch({});
    }
  }, {
    decorations: (p) => p.deco,
    eventHandlers: {
      mousemove(e, view) {
        if (!(e.metaKey || e.ctrlKey)) { this.set(null); return; }
        const pos = view.posAtCoords({ x: e.clientX, y: e.clientY });
        const w = pos == null ? null : view.state.wordAt(pos);
        this.set(w && /^[A-Za-z_$]/.test(view.state.sliceDoc(w.from, w.to)) ? w : null);
      },
      mouseleave() { this.set(null); },
      keyup(e) { if (e.key === "Meta" || e.key === "Control") this.set(null); },
      mousedown(e, view) {
        if (!(e.metaKey || e.ctrlKey) || e.button !== 0) return false;
        const pos = view.posAtCoords({ x: e.clientX, y: e.clientY });
        if (pos == null) return false;
        e.preventDefault();
        this.set(null);
        go(pos);
        return true;
      },
    },
  });
}
