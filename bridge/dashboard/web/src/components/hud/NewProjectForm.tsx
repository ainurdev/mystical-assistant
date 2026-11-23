/** NEW PROJECT, in the info tint: a project is not a session. Four kinds, because
 *  "new project" means four things (bridge/newproject.py): a fresh repo, a folder
 *  you name, a clone, or a chat with no code.
 *
 *  The bridge decides what needs a yes. A folder that isn't a repo, or one
 *  outside your projects folder, comes back as notices with nothing done; the
 *  form shows them and the button becomes the yes. Change a field and the yes
 *  is asked again, since it was given for another folder. */
import { useState } from "react";
import type { CSSProperties } from "react";
import type { NewProjectBody, NewProjectKind, NewProjectNote } from "../../api";

interface Props {
  /** Resolves to the notices that wait for a yes, or null once it is made.
   *  Rejects with the bridge's reason. */
  onCreate: (body: NewProjectBody) => Promise<NewProjectNote[] | null>;
  onClose: () => void;
}

const KINDS: { id: NewProjectKind; label: string; hint: string }[] = [
  { id: "new", label: "NEW", hint: "A fresh repository in your projects folder." },
  { id: "folder", label: "FOLDER", hint: "A folder you already have, or one to make. A plain name or relative path is under your projects folder; ~/… and /… go anywhere." },
  { id: "clone", label: "CLONE", hint: "A git URL, or owner/repo for GitHub. It lands in your projects folder unless you name another." },
  { id: "chat", label: "CHAT", hint: "No code, no repository: somewhere to think out loud. Leave the name empty for General chat." },
];

const field: CSSProperties = {
  width: "100%", boxSizing: "border-box", background: "color-mix(in srgb, var(--panel2) 60%, transparent)",
  border: "1px solid color-mix(in srgb, var(--info) 25%, transparent)", outline: "none", color: "var(--txb)",
  fontFamily: "'JetBrains Mono',monospace", fontSize: "var(--t11)", padding: "6px 9px",
};

export function NewProjectForm({ onCreate, onClose }: Props) {
  const [kind, setKind] = useState<NewProjectKind>("new");
  const [name, setName] = useState("");
  const [path, setPath] = useState("");
  const [into, setInto] = useState("");     // where a clone goes: not the folder typed under FOLDER
  const [url, setUrl] = useState("");
  const [prompt, setPrompt] = useState("");
  const [notes, setNotes] = useState<NewProjectNote[] | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [hov, setHov] = useState("");

  // A yes belongs to the folder it was asked about.
  const edit = <T,>(set: (v: T) => void) => (v: T) => { set(v); setNotes(null); setError(""); };
  const ready = !busy && (kind === "new" ? !!name.trim() : kind === "folder" ? !!path.trim() : kind === "clone" ? !!url.trim() : true);

  async function go() {
    if (!ready) return;
    const body: NewProjectBody = { kind, prompt: prompt.trim(), confirmed: !!notes };
    if (kind === "new" || kind === "chat") body.name = name.trim();
    if (kind === "folder") body.path = path.trim();
    if (kind === "clone") { body.url = url.trim(); body.path = into.trim(); }
    setBusy(true); setError("");
    try {
      const wait = await onCreate(body);
      if (wait) setNotes(wait); else onClose();
    } catch (e) {
      const msg = (e as Error).message;
      // A bridge from before the kinds reads every request as NEW and finds no name.
      setError(kind !== "new" && msg === "invalid name"
        ? "The running bridge is older than this form. Press ⟳ (right rail) to make it live, then try again."
        : msg);
    } finally { setBusy(false); }
  }

  const tab = (k: typeof KINDS[number]): CSSProperties => ({
    flex: 1, appearance: "none", cursor: "pointer", padding: "6px 0", fontFamily: "inherit", fontSize: "var(--t9)", letterSpacing: 1.5,
    border: `1px solid ${kind === k.id ? "var(--info)" : "color-mix(in srgb, var(--info) 22%, transparent)"}`,
    background: kind === k.id ? "color-mix(in srgb, var(--info) 18%, transparent)" : hov === k.id ? "color-mix(in srgb, var(--info) 8%, transparent)" : "transparent",
    color: kind === k.id ? "var(--info-b)" : "var(--txd)",
  });
  const verb = busy ? (kind === "clone" ? "CLONING…" : "WORKING…")
    : notes ? "YES, GO AHEAD" : kind === "clone" ? "CLONE & START" : kind === "chat" ? "START CHAT" : kind === "folder" ? "OPEN & START" : "CREATE & START";

  return (
    <div style={{ border: "1px solid color-mix(in srgb, var(--info) 30%, transparent)", background: "linear-gradient(160deg,color-mix(in srgb, var(--info) 7%, transparent),color-mix(in srgb, var(--panel) 40%, transparent))", padding: 12, marginBottom: 11, animation: "mslide .22s ease backwards" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 11 }}>
        <span style={{ width: 7, height: 7, borderRadius: "50%", background: "var(--info)", flex: "none" }} />
        <span style={{ fontSize: "var(--t9)", letterSpacing: 1.5, color: "var(--info-hi)" }}>NEW PROJECT</span>
        <span style={{ flex: 1 }} />
        <button
          onClick={onClose} title="close" aria-label="close"
          onMouseEnter={() => setHov("close")} onMouseLeave={() => setHov("")}
          style={{ appearance: "none", cursor: "pointer", flex: "none", width: 24, height: 24, padding: 0, borderRadius: 7,
                   display: "grid", placeItems: "center", border: 0,
                   background: hov === "close" ? "color-mix(in srgb, var(--info) 14%, transparent)" : "transparent",
                   color: hov === "close" ? "var(--info-b)" : "var(--txd)", transition: "background .15s ease, color .15s ease" }}
        >
          <svg width="10" height="10" viewBox="0 0 12 12" aria-hidden="true">
            <path d="M2 2l8 8M10 2l-8 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          </svg>
        </button>
      </div>

      <div role="tablist" aria-label="Kind of project" style={{ display: "flex", gap: 4, marginBottom: 8 }}>
        {KINDS.map((k) => (
          <button key={k.id} role="tab" aria-selected={kind === k.id} disabled={busy} style={tab(k)}
                  onMouseEnter={() => setHov(k.id)} onMouseLeave={() => setHov("")}
                  onClick={() => { setKind(k.id); setNotes(null); setError(""); }}>{k.label}</button>
        ))}
      </div>
      <div style={{ fontSize: "var(--t10)", lineHeight: 1.5, color: "var(--txl)", marginBottom: 8 }}>{KINDS.find((k) => k.id === kind)!.hint}</div>

      {kind === "new" && (
        <input value={name} onChange={(e) => edit(setName)(e.target.value)} placeholder="project-name" aria-label="Project name" autoFocus style={field} />
      )}
      {kind === "chat" && (
        <input value={name} onChange={(e) => edit(setName)(e.target.value)} placeholder="General chat" aria-label="Chat name" autoFocus style={field} />
      )}
      {kind === "clone" && (
        <input value={url} onChange={(e) => edit(setUrl)(e.target.value)} placeholder="https://github.com/owner/repo.git" aria-label="Git URL" autoFocus spellCheck={false} style={field} />
      )}
      {kind === "folder" && (
        <input value={path} onChange={(e) => edit(setPath)(e.target.value)} spellCheck={false} autoFocus
               placeholder="~/path/to/folder" aria-label="Folder" style={field} />
      )}
      {kind === "clone" && (
        <input value={into} onChange={(e) => edit(setInto)(e.target.value)} spellCheck={false}
               placeholder="clone into… (optional)" aria-label="Clone into" style={{ ...field, marginTop: 8 }} />
      )}
      <textarea
        value={prompt} onChange={(e) => setPrompt(e.target.value)} aria-label="Starting prompt"
        placeholder={kind === "chat" ? "what's on your mind? (optional)" : "starting prompt — what should Claude do first? (optional)"}
        style={{ width: "100%", boxSizing: "border-box", minHeight: 60, resize: "vertical", marginTop: 8, background: "color-mix(in srgb, var(--panel2) 60%, transparent)", border: "1px solid color-mix(in srgb, var(--acc) 18%, transparent)", outline: "none", color: "var(--txb)", fontFamily: "inherit", fontSize: "var(--t12)", lineHeight: 1.5, padding: "8px 9px" }} />

      {notes && (
        <div role="alert" style={{ marginTop: 8, padding: "8px 9px", border: "1px solid color-mix(in srgb, var(--warn) 45%, transparent)", background: "color-mix(in srgb, var(--warn) 9%, transparent)" }}>
          <div style={{ fontSize: "var(--t9)", letterSpacing: 1.5, color: "var(--warn)", marginBottom: 5 }}>BEFORE THIS STARTS</div>
          {notes.map((n) => (
            <div key={n.kind} style={{ fontSize: "var(--t11)", lineHeight: 1.5, color: "var(--txh)", overflowWrap: "anywhere", marginTop: 4 }}>{n.text}</div>
          ))}
        </div>
      )}
      {error && (
        <div role="alert" style={{ marginTop: 8, fontSize: "var(--t11)", lineHeight: 1.5, color: "var(--err)", overflowWrap: "anywhere" }}>{error}</div>
      )}

      <div style={{ display: "flex", gap: 7, marginTop: 9 }}>
        <button
          onClick={() => void go()} disabled={!ready}
          onMouseEnter={() => setHov("go")} onMouseLeave={() => setHov("")}
          style={{ flex: 1, appearance: "none", cursor: ready ? "pointer" : "not-allowed", opacity: ready ? 1 : 0.45, border: "1px solid var(--info)", background: hov === "go" ? "color-mix(in srgb, var(--info) 26%, transparent)" : "color-mix(in srgb, var(--info) 16%, transparent)", color: "var(--info-b)", fontFamily: "inherit", fontSize: "var(--t10)", letterSpacing: 1.5, padding: 9, display: "flex", alignItems: "center", justifyContent: "center", gap: 6 }}
        ><span style={{ color: "var(--info)" }}>▸</span>{verb}</button>
        <button
          onClick={onClose}
          onMouseEnter={() => setHov("cancel")} onMouseLeave={() => setHov("")}
          style={{ appearance: "none", cursor: "pointer", border: "1px solid color-mix(in srgb, var(--acc) 20%, transparent)", background: hov === "cancel" ? "color-mix(in srgb, var(--acc) 6%, transparent)" : "transparent", color: "var(--txd)", fontFamily: "inherit", fontSize: "var(--t10)", letterSpacing: 1.5, padding: "9px 12px" }}
        >CANCEL</button>
      </div>
    </div>
  );
}
