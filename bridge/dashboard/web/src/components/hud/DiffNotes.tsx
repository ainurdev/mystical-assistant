import { useState } from "react";
import { lineLabel, type Note } from "../../lib/reviewnotes";
import { ago } from "../../lib/surfaces";

/* Review notes on the GIT tab's diff (review loop A, sheet A): the inline
   editor, a saved note's thread, and the send bar at the panel's foot.
   ChangesTab (AnalyzeModal.tsx) owns the notes and decides where each one
   renders. These pieces only draw and report. Plain text, no markdown:
   ponytail, since a note is a line or two typed at a diff. */

/** Under the gutter, the line-number column and the +/− mark (18 + 36 + 14),
 *  so a thread lines up with the code it is about. */
const INDENT = 68;

const btn = (on: boolean, tone = "var(--acc)") => ({
  appearance: "none" as const, cursor: "pointer", fontFamily: "inherit", fontSize: "var(--t9)",
  letterSpacing: 1.4, padding: "5px 10px", flex: "none" as const,
  border: `1px solid ${tone === "ghost" ? "color-mix(in srgb, var(--acc) 22%, transparent)" : tone}`,
  background: tone === "ghost" ? (on ? "color-mix(in srgb, var(--acc) 6%, transparent)" : "transparent")
    : `color-mix(in srgb, ${tone} ${on ? 22 : 12}%, transparent)`,
  color: tone === "ghost" ? "var(--txm)" : "var(--txb)",
});

export function NoteEditor({ start, end, initial, isNew, onSave, onCancel }: {
  start: number; end: number; initial: string; isNew: boolean;
  onSave: (text: string) => void; onCancel: () => void;
}) {
  const [text, setText] = useState(initial);
  const [hov, setHov] = useState("");
  const hp = (k: string) => ({ onMouseEnter: () => setHov(k), onMouseLeave: () => setHov("") });
  return (
    <div style={{ margin: `3px 12px 6px ${INDENT}px`, border: "1px solid var(--acc)", background: "color-mix(in srgb, var(--panel) 92%, transparent)", boxShadow: "0 0 0 3px color-mix(in srgb, var(--acc) 12%, transparent)" }}>
      <div style={{ fontSize: "var(--t85)", letterSpacing: 1.2, color: "var(--acc)", padding: "6px 9px 0" }}>
        ◆ {lineLabel(start, end)} · {isNew ? "NEW NOTE" : "EDIT NOTE"}
      </div>
      <textarea autoFocus value={text} rows={2} placeholder="what should change here?"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          // Esc must stop here: App's window handler would close the whole modal.
          if (e.key === "Escape") { e.stopPropagation(); onCancel(); }
          else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); onSave(text); }
        }}
        style={{ display: "block", width: "100%", boxSizing: "border-box", resize: "vertical", minHeight: 40, background: "transparent", border: 0, outline: "none", color: "var(--txb)", fontFamily: "inherit", fontSize: "var(--t105)", lineHeight: 1.5, padding: "5px 9px 8px" }} />
      <div style={{ display: "flex", alignItems: "center", gap: 7, padding: "6px 9px", borderTop: "1px solid color-mix(in srgb, var(--acc) 12%, transparent)" }}>
        <span style={{ fontSize: "var(--t85)", letterSpacing: 1, color: "var(--txl)", marginRight: "auto" }}>⌘↵ {isNew ? "ADD" : "SAVE"} · ESC CANCEL</span>
        <button onClick={onCancel} {...hp("cancel")} style={btn(hov === "cancel", "ghost")}>CANCEL</button>
        <button onClick={() => onSave(text)} disabled={!text.trim()} {...hp("add")}
          style={{ ...btn(hov === "add"), opacity: text.trim() ? 1 : 0.45, cursor: text.trim() ? "pointer" : "not-allowed" }}>
          {isNew ? "ADD NOTE" : "SAVE NOTE"}
        </button>
      </div>
    </div>
  );
}

export function NoteThread({ note, onEdit, onDelete }: {
  note: Note;
  /** Absent for a note whose line has left the diff: there's no row to edit it under. */
  onEdit?: () => void;
  onDelete: () => void;
}) {
  const [hov, setHov] = useState("");
  const hp = (k: string) => ({ onMouseEnter: () => setHov(k), onMouseLeave: () => setHov("") });
  const link = (k: string) => ({
    appearance: "none" as const, cursor: "pointer", border: 0, background: "transparent", padding: 0,
    fontFamily: "inherit", fontSize: "inherit", letterSpacing: "inherit",
    color: hov === k ? (k === "del" ? "var(--err)" : "var(--txb)") : "var(--txl)",
  });
  return (
    <div style={{ margin: `3px 12px 5px ${INDENT}px`, border: "1px solid color-mix(in srgb, var(--purple) 38%, transparent)", borderLeft: "2px solid var(--purple)", background: "color-mix(in srgb, var(--purple) 7%, transparent)", padding: "7px 9px", fontSize: "var(--t105)", lineHeight: 1.5 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 7, fontSize: "var(--t85)", letterSpacing: 1.2, color: "var(--purple-h)", marginBottom: 3 }}>
        <span>◆ {lineLabel(note.start, note.end)} · YOU · {ago(note.at / 1000) || "now"}</span>
        <span style={{ flex: 1 }} />
        {onEdit && <>
          <button onClick={onEdit} {...hp("edit")} style={link("edit")}>EDIT</button>
          <span style={{ color: "var(--txl)" }}>·</span>
        </>}
        <button onClick={onDelete} title="delete this note" {...hp("del")} style={link("del")}>✕</button>
      </div>
      <div style={{ color: "var(--txh)", whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{note.text}</div>
    </div>
  );
}
