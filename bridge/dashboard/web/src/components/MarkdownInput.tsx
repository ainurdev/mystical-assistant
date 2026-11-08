import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { Decoration, EditorView, WidgetType, keymap, placeholder as cmPlaceholder, type DecorationSet } from "@codemirror/view";
import { Compartment, EditorState, MapMode, Prec, StateEffect, StateField } from "@codemirror/state";
import { defaultKeymap, history, historyKeymap, insertNewlineAndIndent } from "@codemirror/commands";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { insertNewlineContinueMarkup, markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { tags as t } from "@lezer/highlight";
import { drawnAtCaret, dropSpot, fillSpot, holdSpot, imageEmbeds, openEmbed, setImageScope } from "../lib/cmembeds";
import { minimalChange } from "../lib/embeds";
import { registerEditor } from "../lib/editorctx";
import { leadCommand } from "../lib/slash";
import type { SlashCommand } from "../api";
import { EmbedPopover } from "./EmbedPopover";
import { useMultiOn } from "../lib/multistore";

// The composer's command line: a live markdown editor, not a preview pane. The
// symbols stay in the text you edit — dimmed to the ghost tier so they read as
// markup, not words — and the span they wrap takes the effect beside them: bold
// is bold, a heading is a size up, `code` sits on a tint. What you typed is
// what gets sent, character for character; the transcript then renders it with
// the same Markdown component the agent's replies use.
//
// Why CodeMirror and not a contentEditable WYSIWYG: a rich editor owns the
// text and hands markdown back through a serializer, which rewrites what you
// typed (`*` becomes `_`, a list renumbers). A prompt is source, so the editor
// has to be one too — and CodeMirror was already in the bundle for EditorTab.
//
// An image written in the text draws as the image once it's known to load, the
// markup still in the document underneath: lib/cmembeds holds why and how.
//
// The API mirrors the textarea it replaced (value / onChange / caret / keydown),
// so the composer's @-mentions, /commands and Ctrl+R need no second path.

export type MarkdownInputHandle = {
  focus(): void;
  setSelectionRange(from: number, to: number): void;
  /** Insert `s` in front of the text, the caret staying with the text it was in. */
  prepend(s: string): void;
  /** Focus and type `s` at the caret, as if typed here (a letter typed elsewhere, App). */
  type(s: string): void;
  /** Hold the caret's place for an image still uploading (lib/cmembeds). */
  holdSpot(): number | null;
  /** Its markdown goes where the place was held, as one undo step. */
  fillSpot(id: number, markdown: string): void;
  dropSpot(id: number): void;
};

const mdHighlight = HighlightStyle.define([
  { tag: t.heading1, fontWeight: "bold", fontSize: "1.3em", color: "var(--txb)" },
  { tag: t.heading2, fontWeight: "bold", fontSize: "1.18em", color: "var(--txb)" },
  { tag: [t.heading3, t.heading4, t.heading5, t.heading6], fontWeight: "bold", color: "var(--txb)" },
  { tag: t.strong, fontWeight: "bold", color: "var(--txb)" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.strikethrough, textDecoration: "line-through", color: "var(--txl)" },
  { tag: t.monospace, color: "var(--acc)", backgroundColor: "color-mix(in srgb, var(--acc) 9%, transparent)" },
  { tag: t.link, color: "var(--acc)", textDecoration: "underline" },
  { tag: t.url, color: "var(--txd)" },
  { tag: t.quote, color: "var(--txl)", fontStyle: "italic" },
  { tag: t.contentSeparator, color: "var(--txd)" },
  // Inside a fenced block the fence's own language highlights — the same
  // palette EditorTab's crtHighlight uses, so code reads the same in both.
  { tag: t.keyword, color: "var(--purple)" },
  { tag: [t.function(t.variableName), t.labelName], color: "var(--acc)" },
  { tag: [t.typeName, t.className, t.number, t.bool], color: "var(--warn)" },
  { tag: [t.string, t.special(t.string)], color: "var(--ok)" },
  { tag: [t.meta, t.comment], color: "var(--txd)", fontStyle: "italic" },
  // Markup marks (`#`, `**`, `>`, list bullets, fences) all carry
  // processingInstruction; that one tag is what makes them "the symbols". Last,
  // because a mark also sits inside the span it wraps and gets that span's
  // class too — equal specificity, so the later rule is the one that shows.
  { tag: t.processingInstruction, color: "var(--txd)", fontStyle: "normal" },
]);

const mdTheme = EditorView.theme({
  "&": { backgroundColor: "transparent", color: "var(--txb)", fontSize: "var(--t13)", maxHeight: "min(500px, 50vh)" },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": { fontFamily: "'JetBrains Mono',monospace", lineHeight: "1.5", overflow: "auto" },
  ".cm-content": { padding: 0, caretColor: "var(--acc)" },
  ".cm-line": { padding: 0 },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--acc)" },
  ".cm-content ::selection": { backgroundColor: "color-mix(in srgb, var(--acc) 22%, transparent)" },
  ".cm-placeholder": { color: "var(--txd)" },
  // An image written in the text, drawn (lib/cmembeds). A button, so Tab and a screen
  // reader can find it; inline, so it sits among the words it was put between.
  ".cm-embed": { appearance: "none", display: "inline-block", verticalAlign: "bottom", maxWidth: "100%", margin: "1px 2px", padding: 0, border: "1px solid color-mix(in srgb, var(--acc) 22%, transparent)", background: "transparent", cursor: "pointer", lineHeight: 0 },
  ".cm-embed:hover, .cm-embed:focus-visible": { borderColor: "var(--acc)", outline: "none" },
  ".cm-embed img": { display: "block", maxWidth: "100%", maxHeight: "160px", width: "auto", height: "auto" },
});

// Shift+Enter is the newline (Enter sends, unless SEND KEY is CTRL+ENTER — then
// a bare Enter falls through to markdown()'s own keymap, which does the same);
// inside a list or a quote it carries the bullet or `>` onto the next line, as
// a markdown editor should.
const newlineKeys = keymap.of([{
  key: "Shift-Enter",
  run: (v) => insertNewlineContinueMarkup(v) || insertNewlineAndIndent(v),
}]);

// A /command the line leads with is drawn as its segment (lib/slash leadCommand,
// .cmdseg in index.css): a replace decoration over `/name `, so the doc still
// holds the text you send, and atomic, so Backspace takes the command whole.
// Derived in the same transaction as the keystroke, so it never lags a frame.
const setCmds = StateEffect.define<SlashCommand[]>();
const cmdList = StateField.define<SlashCommand[]>({
  create: () => [],
  update: (v, tr) => tr.effects.reduce((a, e) => (e.is(setCmds) ? e.value : a), v),
});

/** `/superpowers:brainstorming` → a quiet `superpowers` segment, then `brainstorming`.
 *  The hidden `/` and `:` keep it the command it is for a screen reader. Its twin
 *  for the sent plate is CmdSeg in PromptBubble. */
class CmdWidget extends WidgetType {
  constructor(readonly name: string, readonly desc: string) { super(); }
  eq(o: CmdWidget) { return o.name === this.name && o.desc === this.desc; }
  toDOM() {
    const el = document.createElement("span");
    el.className = "cmdseg";
    el.title = this.desc;
    const add = (cls: string, t: string) => { const s = document.createElement("span"); s.className = cls; s.textContent = t; el.append(s); };
    const i = this.name.lastIndexOf(":");
    add("sr-only", "/");
    if (i > 0) { add("sg ns", this.name.slice(0, i)); add("sr-only", ":"); }
    add("sg", this.name.slice(i + 1));
    return el;
  }
  // A mousedown reaches the editor's handler (onCmdClick); every other event stays the widget's.
  ignoreEvent(e: Event) { return e.type !== "mousedown"; }
}

const cmdDeco = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update: (_, tr) => {
    const s = tr.state;
    const c = leadCommand(s.doc.sliceString(0, 300), s.selection.main.head, s.field(cmdList));
    return c ? Decoration.set(Decoration.replace({ widget: new CmdWidget(c.name, c.desc) }).range(0, c.end)) : Decoration.none;
  },
  provide: (f) => [EditorView.decorations.from(f), EditorView.atomicRanges.of((v) => v.state.field(f))],
});

// The skill router's suggestion (lib/route ghostFor): the same segment, outlined, drawn in
// front of the text but not in it, so what you send stays what you typed until Tab takes
// it. A widget at 0 with side -1, so typing at the start never pushes it along. Its
// suggested argument is the editor's own placeholder (the `ph` effect below).
type Ghost = { name: string; desc: string; arg: string };
const setGhost = StateEffect.define<Ghost | null>();

/** CmdWidget's segment, outlined (.cmdseg.ghost). eq is CmdWidget's: same name and desc, same DOM.
 *  aria-hidden keeps it out of the accessibility tree: it isn't in the doc, so a screen reader
 *  mustn't take it for typed text (the composer's caption line announces it). */
class GhostWidget extends CmdWidget {
  toDOM() {
    const el = super.toDOM();
    el.classList.add("ghost");
    el.setAttribute("aria-hidden", "true");
    return el;
  }
}

const ghostDeco = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update: (v, tr) => {
    for (const e of tr.effects) {
      if (e.is(setGhost)) {
        const g = e.value;
        return g ? Decoration.set(Decoration.widget({ widget: new GhostWidget(g.name, g.desc), side: -1 }).range(0)) : Decoration.none;
      }
    }
    return v.map(tr.changes);
  },
  provide: (f) => EditorView.decorations.from(f),
});

type Props = {
  value: string;
  /** The bridge's command list, so a leading /command draws as one. */
  commands?: SlashCommand[];
  /** The router's suggestion, drawn outlined in front of the text (lib/route ghostFor). */
  ghost?: Ghost | null;
  /** A mousedown on any /command segment, solid or ghost. The editor keeps its caret and focus. */
  onCmdClick?: () => void;
  onChange: (text: string, caret: number) => void;
  onCaret: (caret: number) => void;
  /** Runs before the editor's own keys; preventDefault() to take the key. */
  onKeyDown: (e: KeyboardEvent) => void;
  onPaste: (e: ClipboardEvent) => void;
  placeholder: string;
  /** The right-click menu's Attach file… and Clear draft rows (lib/editorctx). */
  onAttach?: () => void;
  onClear?: () => void;
  /** Whose images: what a local address in the text resolves against. */
  imageSession?: string | null;
  imageProject?: string | null;
};

export const MarkdownInput = forwardRef<MarkdownInputHandle, Props>(function MarkdownInput(props, ref) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  // The handlers close over the composer's state, which changes every render;
  // the editor is built once, so it reads them through this ref.
  const cb = useRef(props);
  cb.current = props;
  const ph = useRef(new Compartment());
  // Live images in the text are behind the EXPERIMENTAL switch.
  const images = useRef(new Compartment());
  const multiOn = useMultiOn();
  // The embed whose address popover is open: its start, kept current as the text moves.
  const [pop, setPop] = useState<number | null>(null);
  const popRef = useRef(pop);
  popRef.current = pop;

  useEffect(() => {
    const view = new EditorView({
      parent: hostRef.current!,
      state: EditorState.create({
        doc: cb.current.value,
        extensions: [
          history(),
          Prec.highest(EditorView.domEventHandlers({
            keydown: (e) => {
              if (e.isComposing) return false;
              // Before the composer's keys, for which an Enter is a send.
              if (e.key === "Enter" && e.altKey) {
                const at = drawnAtCaret(viewRef.current!.state);
                if (at !== null) { e.preventDefault(); setPop(at); return true; }
              }
              cb.current.onKeyDown(e);
              return e.defaultPrevented;
            },
            paste: (e) => {
              cb.current.onPaste(e);
              return e.defaultPrevented;
            },
            // Taking the event (true) is what keeps the click from moving the caret or
            // blurring the editor; focus() covers a click on a segment of an unfocused one.
            // A right-click and a Mac ctrl+click (a mousedown with button 0) are the context menu's.
            mousedown: (e, v) => {
              if (e.button !== 0 || e.ctrlKey || !(e.target as Element).closest(".cmdseg")) return false;
              cb.current.onCmdClick?.();
              v.focus();
              return true;
            },
          })),
          newlineKeys,
          keymap.of([...defaultKeymap, ...historyKeymap]),
          markdown({ base: markdownLanguage, codeLanguages: languages }),
          syntaxHighlighting(mdHighlight),
          EditorView.lineWrapping,
          EditorView.contentAttributes.of({ "aria-label": "Message", spellcheck: "true" }),
          ph.current.of(cmPlaceholder(cb.current.placeholder)),
          cmdList,
          cmdDeco,
          ghostDeco,
          images.current.of([]),
          mdTheme,
          EditorView.updateListener.of((u) => {
            for (const tr of u.transactions) for (const e of tr.effects) if (e.is(openEmbed)) setPop(e.value);
            // TrackDel: the embed deleted out from under an open popover closes it.
            if (u.docChanged && popRef.current !== null) setPop(u.changes.mapPos(popRef.current, 1, MapMode.TrackDel));
            const head = u.state.selection.main.head;
            if (u.docChanged) cb.current.onChange(u.state.doc.toString(), head);
            else if (u.selectionSet) cb.current.onCaret(head);
          }),
        ],
      }),
    });
    viewRef.current = view;
    const off = registerEditor("composer", {
      view,
      actions: {
        attach: () => cb.current.onAttach?.(),
        clear: () => cb.current.onClear?.(),
        // A typed "@" is what opens the mention list, and only after a space
        // (lib/mention mentionAt), so one is put in front when a word ends at the caret.
        mention: () => {
          const at = view.state.selection.main.from;
          const prev = at ? view.state.doc.sliceString(at - 1, at) : "";
          view.dispatch(view.state.replaceSelection(prev && !/\s/.test(prev) ? " @" : "@"));
          view.focus();
        },
      },
    });
    return () => { off(); view.destroy(); viewRef.current = null; };
  }, []);

  // Controlled: a draft swapped in from outside (session switch, Ctrl+R, a
  // mention splice, clearing on send) replaces the doc, caret at its end.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const cur = view.state.doc.toString();
    if (cur === props.value) return;
    // Only what changed: an image beside a spliced mention keeps its drawn widget.
    view.dispatch({
      changes: minimalChange(cur, props.value),
      selection: { anchor: props.value.length },
    });
  }, [props.value]);

  // While a ghost shows, the placeholder is its suggested argument (none if it has none), so the
  // two never stack. CM's placeholder is aria-hidden and click-through, shows only in an empty doc,
  // goes in the first keystroke's own transaction, and leaves the caret in front of it.
  useEffect(() => {
    const g = props.ghost;
    viewRef.current?.dispatch({ effects: ph.current.reconfigure(g ? (g.arg ? cmPlaceholder(g.arg) : []) : cmPlaceholder(props.placeholder)) });
  }, [props.placeholder, !!props.ghost, props.ghost?.arg]);

  useEffect(() => {
    viewRef.current?.dispatch({ effects: setCmds.of(props.commands ?? []) });
  }, [props.commands]);

  // ghostFor returns a new object each render; its name and desc are what the segment shows.
  const ghost = props.ghost;
  useEffect(() => {
    viewRef.current?.dispatch({ effects: setGhost.of(ghost ?? null) });
  }, [ghost?.name, ghost?.desc]);
  useEffect(() => {
    viewRef.current?.dispatch({ effects: images.current.reconfigure(multiOn ? imageEmbeds() : []) });
  }, [multiOn]);

  useEffect(() => {
    viewRef.current?.dispatch({ effects: setImageScope.of({ session: props.imageSession, project: props.imageProject }) });
  }, [props.imageSession, props.imageProject]);

  useImperativeHandle(ref, () => ({
    focus: () => viewRef.current?.focus(),
    prepend: (s) => {
      const v = viewRef.current;
      if (!v) return;
      // A cursor at 0 stays in front of an insert at 0 unless the selection is mapped forward.
      const changes = v.state.changes({ from: 0, insert: s });
      v.dispatch({ changes, selection: v.state.selection.map(changes, 1) });
    },
    type: (s) => {
      const v = viewRef.current;
      if (!v) return;
      v.focus();
      v.dispatch(v.state.replaceSelection(s), { scrollIntoView: true, userEvent: "input.type" });
    },
    holdSpot: () => (viewRef.current ? holdSpot(viewRef.current) : null),
    fillSpot: (id, markdown) => { if (viewRef.current) fillSpot(viewRef.current, id, markdown); },
    dropSpot: (id) => { if (viewRef.current) dropSpot(viewRef.current, id); },
    setSelectionRange: (from, to) => {
      const view = viewRef.current;
      if (!view) return;
      const n = view.state.doc.length;
      view.dispatch({ selection: { anchor: Math.min(from, n), head: Math.min(to, n) }, scrollIntoView: true });
    },
  }), []);

  return (
    <>
      <div ref={hostRef} data-ctx-type="editor" data-ctx-id="composer" data-ctx-label="prompt"
        data-empty={props.value === "" ? "" : undefined} style={{ flex: 1, minWidth: 0 }} />
      {pop !== null && viewRef.current && (
        <EmbedPopover view={viewRef.current} pos={pop} scope={{ session: props.imageSession, project: props.imageProject }}
          onClose={() => setPop(null)} />
      )}
    </>
  );
});
