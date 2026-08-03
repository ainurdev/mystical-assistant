import { useEffect, useRef } from "react";
import { EditorState, Compartment } from "@codemirror/state";
import { EditorView, keymap, highlightSpecialChars, drawSelection } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";
import { langFor } from "../lib/langfor";

/* The buffer itself. Deliberately not CodeMirror's `basicSetup`: on a phone the
   line-number and fold gutters cost real width, and bracket-matching popups
   fight the on-screen keyboard. What's left is wrapping, undo, and colour.

   Loaded through React.lazy from the files route, so a user who never opens a
   file never downloads CodeMirror. */

const highlight = HighlightStyle.define([
  { tag: [t.keyword, t.moduleKeyword, t.controlKeyword], color: "var(--brand-bright)" },
  { tag: [t.string, t.special(t.string), t.regexp], color: "#a7e6c3" },
  { tag: [t.comment, t.lineComment, t.blockComment], color: "var(--tg-hint)", fontStyle: "italic" },
  { tag: [t.number, t.bool, t.null, t.atom], color: "#e8c07d" },
  { tag: [t.function(t.variableName), t.definition(t.variableName)], color: "var(--brand-soft)" },
  { tag: [t.typeName, t.className, t.namespace], color: "#7fd1e0" },
  { tag: [t.propertyName, t.attributeName], color: "#c5a6f0" },
  { tag: [t.operator, t.punctuation, t.bracket], color: "var(--tg-hint)" },
  { tag: [t.heading, t.strong], color: "var(--tg-text)", fontWeight: "600" },
  { tag: [t.link, t.url], color: "var(--tg-link)", textDecoration: "underline" },
  { tag: t.invalid, color: "#ff6b6b" },
]);

const theme = EditorView.theme({
  "&": { color: "var(--tg-text)", backgroundColor: "transparent", height: "100%", fontSize: "13px" },
  ".cm-content": {
    fontFamily: "'JetBrains Mono', ui-monospace, monospace",
    padding: "10px 12px 40vh",   // room to scroll the last line clear of the keyboard
    caretColor: "var(--brand-bright)",
  },
  ".cm-scroller": { overflow: "auto", lineHeight: "1.6" },
  "&.cm-focused": { outline: "none" },
  ".cm-selectionBackground, &.cm-focused .cm-selectionBackground, ::selection": {
    backgroundColor: "var(--brand-glow)",
  },
}, { dark: true });

export default function CodeEditor({
  path,
  initial,
  onChange,
}: {
  path: string;
  initial: string;
  onChange: (text: string) => void;
}) {
  const host = useRef<HTMLDivElement | null>(null);
  const cb = useRef(onChange);
  cb.current = onChange;

  useEffect(() => {
    if (!host.current) return;
    const lang = new Compartment();
    const view = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: initial,
        extensions: [
          history(),
          keymap.of([...defaultKeymap, ...historyKeymap]),
          highlightSpecialChars(),
          drawSelection(),
          EditorView.lineWrapping,
          syntaxHighlighting(highlight),
          theme,
          lang.of([]),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) cb.current(u.state.doc.toString());
          }),
          // Phone keyboards "help" by capitalising and correcting source code.
          EditorView.contentAttributes.of({
            autocapitalize: "off", autocorrect: "off", spellcheck: "false",
          }),
        ],
      }),
    });
    // Highlighting is a lazy chunk; the buffer renders plain and repaints when
    // it lands. A failed fetch just means this file stays colourless.
    void langFor(path)?.load()
      .then((sup) => view.dispatch({ effects: lang.reconfigure(sup) }))
      .catch(() => {});
    return () => view.destroy();
    // Remounting per file is the point — each file gets a fresh buffer.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, initial]);

  return <div ref={host} className="h-full" />;
}
