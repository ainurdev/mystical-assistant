import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import { Decoration, EditorView, WidgetType, keymap, placeholder as cmPlaceholder, type DecorationSet } from "@codemirror/view";
import { Compartment, EditorState, Prec, StateEffect, StateField } from "@codemirror/state";
import { defaultKeymap, history, historyKeymap, insertNewlineAndIndent } from "@codemirror/commands";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { insertNewlineContinueMarkup, markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { tags as t } from "@lezer/highlight";
import { registerEditor } from "../lib/editorctx";
import { leadCommand } from "../lib/slash";
import type { SlashCommand } from "../api";

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
// The API mirrors the textarea it replaced (value / onChange / caret / keydown),
// so the composer's @-mentions, /commands and Ctrl+R need no second path.

export type MarkdownInputHandle = {
  focus(): void;
  setSelectionRange(from: number, to: number): void;
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

type Props = {
  value: string;
  /** The bridge's command list, so a leading /command draws as one. */
  commands?: SlashCommand[];
  onChange: (text: string, caret: number) => void;
  onCaret: (caret: number) => void;
  /** Runs before the editor's own keys; preventDefault() to take the key. */
  onKeyDown: (e: KeyboardEvent) => void;
  onPaste: (e: ClipboardEvent) => void;
  placeholder: string;
  /** The right-click menu's Attach file… and Clear draft rows (lib/editorctx). */
  onAttach?: () => void;
  onClear?: () => void;
};

export const MarkdownInput = forwardRef<MarkdownInputHandle, Props>(function MarkdownInput(props, ref) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  // The handlers close over the composer's state, which changes every render;
  // the editor is built once, so it reads them through this ref.
  const cb = useRef(props);
  cb.current = props;
  const ph = useRef(new Compartment());

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
              cb.current.onKeyDown(e);
              return e.defaultPrevented;
            },
            paste: (e) => {
              cb.current.onPaste(e);
              return e.defaultPrevented;
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
          mdTheme,
          EditorView.updateListener.of((u) => {
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
    view.dispatch({
      changes: { from: 0, to: cur.length, insert: props.value },
      selection: { anchor: props.value.length },
    });
  }, [props.value]);

  useEffect(() => {
    viewRef.current?.dispatch({ effects: ph.current.reconfigure(cmPlaceholder(props.placeholder)) });
  }, [props.placeholder]);

  useEffect(() => {
    viewRef.current?.dispatch({ effects: setCmds.of(props.commands ?? []) });
  }, [props.commands]);

  useImperativeHandle(ref, () => ({
    focus: () => viewRef.current?.focus(),
    setSelectionRange: (from, to) => {
      const view = viewRef.current;
      if (!view) return;
      const n = view.state.doc.length;
      view.dispatch({ selection: { anchor: Math.min(from, n), head: Math.min(to, n) }, scrollIntoView: true });
    },
  }), []);

  return <div ref={hostRef} data-ctx-type="editor" data-ctx-id="composer" data-ctx-label="prompt" style={{ flex: 1, minWidth: 0 }} />;
});
