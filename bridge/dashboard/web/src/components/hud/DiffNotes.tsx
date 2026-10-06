import { useState } from "react";
import type { SessionBrief } from "../../api";
import { lineLabel, type Note } from "../../lib/reviewnotes";
import { hairline } from "../../lib/shell";
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

/** The diff panel's foot once a note exists: count · target session ▾ · CLEAR · SEND. */
export function SendBar({ count, targets, target, tint, busy, onPick, onClear, onSend }: {
  count: number;
  /** The sessions on this branch, newest first. */
  targets: SessionBrief[];
  /** Where SEND goes. null means "new session here". */
  target: SessionBrief | null;
  tint: string;
  busy: boolean;
  onPick: (id: string) => void;   // a session id, or "new"
  onClear: () => void;
  onSend: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [hov, setHov] = useState("");
  const hp = (k: string) => ({ onMouseEnter: () => setHov(k), onMouseLeave: () => setHov("") });
  const pick = (id: string) => { onPick(id); setOpen(false); };
  const row = (k: string) => ({
    width: "100%", appearance: "none" as const, cursor: "pointer", display: "flex", alignItems: "center", gap: 7,
    border: 0, background: hov === k ? "color-mix(in srgb, var(--purple) 10%, transparent)" : "transparent",
    color: "var(--txh)", fontFamily: "inherit", fontSize: "var(--t10)", padding: "7px 9px", textAlign: "left" as const,
  });
  return (
    <div style={{ position: "relative", flex: "none", display: "flex", alignItems: "center", gap: 9, padding: "8px 10px", borderTop: "1px solid color-mix(in srgb, var(--purple) 40%, transparent)", background: "color-mix(in srgb, var(--purple) 7%, transparent)" }}>
      <span style={{ fontSize: "var(--t95)", letterSpacing: 1.2, color: "var(--purple-h)", flex: "none" }}>◆ {count} NOTE{count === 1 ? "" : "S"}</span>
      <span style={hairline(11)} />
      <button onClick={() => setOpen((o) => !o)} title="which session gets the notes" {...hp("to")}
        style={{ appearance: "none", cursor: "pointer", border: 0, background: "transparent", padding: 0, display: "flex", alignItems: "center", gap: 6, minWidth: 0, flex: 1, fontFamily: "inherit", fontSize: "var(--t10)", color: hov === "to" || open ? "var(--txb)" : "var(--txm)" }}>
        →
        <span style={{ width: 5, height: 5, borderRadius: "50%", background: tint, flex: "none" }} />
        <span style={{ color: "var(--txh)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
          {target ? target.title || "untitled session" : "new session here"}
        </span>
        <span style={{ color: "var(--txl)", flex: "none" }}>▾</span>
      </button>
      <button onClick={onClear} {...hp("clear")} style={btn(hov === "clear", "ghost")}>CLEAR</button>
      <button onClick={onSend} disabled={busy} {...hp("send")}
        style={{ ...btn(hov === "send", "var(--purple)"), opacity: busy ? 0.6 : 1, cursor: busy ? "wait" : "pointer" }}>
        {busy ? "SENDING…" : "SEND TO AGENT ▸"}
      </button>
      {open && (
        <div style={{ position: "absolute", bottom: "calc(100% + 5px)", left: 10, zIndex: 30, minWidth: 260, maxWidth: "80%", border: "1px solid color-mix(in srgb, var(--purple) 40%, transparent)", background: "color-mix(in srgb, var(--panel2) 99%, transparent)", boxShadow: "0 12px 32px var(--shadow-pop)", padding: 5, animation: "mslide .16s ease both" }}>
          <div style={{ fontSize: "var(--t8)", letterSpacing: 1.5, color: "var(--txl)", padding: "5px 9px 7px" }}>SEND TO</div>
          {targets.map((s) => (
            <button key={s.id} onClick={() => pick(s.id)} {...hp(`t:${s.id}`)} style={row(`t:${s.id}`)}>
              <span style={{ flex: 1, minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{s.title || "untitled session"}</span>
              {s.id === target?.id && <span style={{ color: "var(--acc)", flex: "none" }}>✓</span>}
            </button>
          ))}
          <button onClick={() => pick("new")} {...hp("t:new")} style={row("t:new")}>
            <span style={{ flex: 1, color: "var(--purple-h)" }}>+ new session here</span>
            {!target && <span style={{ color: "var(--acc)", flex: "none" }}>✓</span>}
          </button>
        </div>
      )}
    </div>
  );
}
