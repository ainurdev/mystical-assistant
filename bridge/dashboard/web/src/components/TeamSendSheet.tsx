import { useEffect, useRef, useState, type ReactNode } from "react";
import { Check, Clock, History, Send, ShieldCheck } from "lucide-react";
import { api, type Share, type Teammate, type TeamPreview } from "../api";
import { ago, useClock12 } from "../lib/surfaces";
import { byPresence, presence, sentBefore, sentStatus } from "../lib/team";
import { Avatar } from "./hud/TeamPanel";

/** What is being sent: a session of yours, a picture this bridge holds (its upload
 *  folder), or a file picked in the Files tab (relative to its project). */
export type SendWhat =
  | { kind: "session"; session: string; title: string }
  | { kind: "picture"; path: string; url: string; name: string; title?: string }
  | { kind: "file"; project: string; branch?: string; file: string };

const UI = "var(--ui-font, inherit)";
const MONO = "var(--mono)";
const mix = (c: string, pct: number) => `color-mix(in srgb, ${c} ${pct}%, transparent)`;
const TONE = { ok: "var(--ok)", purple: "var(--purple)", warn: "var(--warn)", dim: "var(--txm)", err: "var(--err)" } as const;
const BTN = { appearance: "none", cursor: "pointer", fontFamily: "inherit", fontSize: "var(--t95)", letterSpacing: 1.5, padding: "7px 16px" } as const;

const Label = ({ children }: { children: ReactNode }) => (
  <div style={{ flex: "none", width: 62, paddingTop: 4, fontFamily: MONO, fontSize: "var(--t8)", letterSpacing: 1.5, color: "var(--txl)" }}>{children}</div>
);

function Box({ on, locked, onToggle, title, hint }: { on: boolean; locked?: boolean; onToggle?: () => void; title: string; hint: string }) {
  return (
    <button type="button" disabled={locked} onClick={onToggle} aria-pressed={on} style={{
      appearance: "none", display: "flex", alignItems: "flex-start", gap: 9, padding: "4px 0", width: "100%", textAlign: "left",
      border: 0, background: "transparent", cursor: locked ? "default" : "pointer", fontFamily: "inherit",
    }}>
      <span style={{
        flex: "none", marginTop: 1, width: 14, height: 14, borderRadius: 4, boxSizing: "border-box", display: "grid", placeItems: "center",
        ...(on ? { background: mix("var(--acc)", locked ? 40 : 85), color: "var(--acc-on)", border: "1px solid var(--acc)" }
          : { border: "1px solid var(--line2)", background: "transparent" }),
      }}>{on && <Check size={10} strokeWidth={3} />}</span>
      <span style={{ minWidth: 0 }}>
        <span style={{ display: "block", fontFamily: UI, fontSize: "var(--t115)", color: on ? "var(--txh)" : "var(--txm)" }}>
          {title}{locked && <span style={{ marginLeft: 7, fontFamily: MONO, fontSize: "var(--t8)", letterSpacing: 1, color: "var(--txl)" }}>ALWAYS</span>}
        </span>
        <span style={{ display: "block", marginTop: 1, fontFamily: UI, fontSize: "var(--t105)", color: "var(--txl)", lineHeight: 1.4 }}>{hint}</span>
      </span>
    </button>
  );
}

function Radio({ on, onPick, title, hint }: { on: boolean; onPick: () => void; title: string; hint: string }) {
  return (
    <button type="button" role="radio" aria-checked={on} onClick={onPick} style={{
      appearance: "none", display: "flex", alignItems: "flex-start", gap: 9, padding: "5px 0 1px", width: "100%", textAlign: "left",
      border: 0, background: "transparent", cursor: "pointer", fontFamily: "inherit",
    }}>
      <span style={{
        flex: "none", marginTop: 2, width: 14, height: 14, borderRadius: "50%", boxSizing: "border-box", display: "grid", placeItems: "center",
        border: `1px solid ${on ? "var(--acc)" : "var(--line2)"}`,
      }}>{on && <i style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--acc)" }} />}</span>
      <span style={{ minWidth: 0 }}>
        <span style={{ display: "block", fontFamily: UI, fontSize: "var(--t115)", color: on ? "var(--txh)" : "var(--txm)" }}>{title}</span>
        <span style={{ display: "block", marginTop: 1, fontFamily: UI, fontSize: "var(--t105)", color: "var(--txl)", lineHeight: 1.4 }}>{hint}</span>
      </span>
    </button>
  );
}

/** SEND SESSION / PICTURE / FILE (bridge/team.py): who it goes to, what goes with
 *  it, a note, and the promise that nothing runs on their side until they continue
 *  it. A session that already went to them says so, and goes as an update; one with a
 *  turn running waits for it by default. Above the lightbox (z 97), with an Esc of its own. */
export function TeamSendSheet({ what, teammates, outbox = [], to: first, onClose, onSent }: {
  what: SendWhat;
  teammates: Teammate[];
  outbox?: Share[];          // YOU SENT: what each teammate already has
  to?: string;
  onClose: () => void;
  onSent: (share: Share, to: Teammate) => void;
}) {
  const h12 = useClock12();
  const roster = [...teammates].sort(byPresence);
  const [to, setTo] = useState(first ?? roster[0]?.id ?? "");
  const [note, setNote] = useState("");
  const [pictures, setPictures] = useState(true);
  const [code, setCode] = useState(false);
  const [when, setWhen] = useState<"end" | "now">("end");
  const [picTitle, setPicTitle] = useState(what.kind === "picture" ? what.title ?? what.name : "");
  const [preview, setPreview] = useState<TeamPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const noteRef = useRef<HTMLTextAreaElement>(null);
  const person = roster.find((t) => t.id === to);

  // Once, on open: App hands a new onClose every render, and focusing again on each one
  // pulled the caret out of the picture's title into NOTE mid-word.
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    noteRef.current?.focus();
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopImmediatePropagation();     // the lightbox under it listens for Esc too
      close.current();
    };
    window.addEventListener("keydown", key, true);
    return () => window.removeEventListener("keydown", key, true);
  }, []);

  useEffect(() => {
    if (what.kind !== "session") return;
    let live = true;
    api.teamPreview(what.session).then((p) => live && setPreview(p),
      (e: Error) => live && setError(e.message === "not found" ? "Restart the bridge to send sessions from here." : e.message));
    return () => { live = false; };
  }, [what]);

  async function send() {
    if (!person || busy) return;
    setBusy(true);
    setError("");
    try {
      const body = what.kind === "session"
        ? { kind: what.kind, session: what.session, pictures, code, ...(preview?.running && when === "end" ? { when: "end" as const } : {}) }
        : what.kind === "picture" ? { kind: what.kind, path: what.path, ...(picTitle.trim() ? { title: picTitle.trim() } : {}) }
        : { kind: what.kind, project: what.project, branch: what.branch, file: what.file };
      const r = await api.teamSend({ ...body, to: person.id, note });
      onSent(r.share, person);
    } catch (e) {
      const m = (e as Error).message;
      setError(m === "not found" ? "Restart the bridge to send from here." : m);
      setBusy(false);
    }
  }

  const title = what.kind === "session" ? what.title : what.kind === "picture" ? what.name : what.file.split("/").pop() || what.file;
  // What they already have of this session (YOU SENT, by its thread): it goes as the next version.
  const had = what.kind === "session" && person ? sentBefore(outbox, preview?.thread, person.id) : null;
  const num = (v: unknown) => (typeof v === "number" ? v : 0);
  // A turn that was still running when it went is new to them again now it has an answer.
  const newTurns = had && preview ? preview.turns - num(had.last.meta.turns) + num(had.last.meta.unfinished) : 0;
  const newPics = had && preview ? preview.pictures - num(had.last.meta.pictures) : 0;
  const picsLine = preview && (preview.pictures_total ?? 0) > preview.pictures ? `${preview.pictures} of ${preview.pictures_total}` : `${preview?.pictures ?? 0}`;
  const waits = what.kind === "session" && !!preview?.running && when === "end";
  const label = waits ? "SEND WHEN IT ENDS" : had ? (newTurns > 0 || newPics > 0 ? "SEND UPDATE" : "SEND AGAIN") : "SEND";
  const nowSec = Date.now() / 1000;
  return (
    <div onClick={onClose} style={{
      position: "fixed", inset: 0, background: "color-mix(in srgb, var(--panel3) 74%, transparent)", zIndex: 97,
      display: "flex", alignItems: "flex-start", justifyContent: "center", paddingTop: "13vh", animation: "backdropIn .2s ease both",
    }}>
      <div role="dialog" aria-modal aria-label={`Send ${what.kind}`} className="panel" onClick={(e) => e.stopPropagation()} style={{
        width: 490, maxWidth: "94vw", border: `1px solid ${mix("var(--acc)", 40)}`,
        background: "color-mix(in srgb, var(--panel2) 98%, transparent)", boxShadow: "0 0 60px var(--shadow-modal)", animation: "mslide .2s ease both",
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "12px 18px", borderBottom: `1px solid ${mix("var(--acc)", 16)}` }}>
          <span style={{ color: "var(--acc)", display: "flex" }}><Send size={13} strokeWidth={2} /></span>
          <span style={{ fontSize: "var(--t95)", letterSpacing: 2.5, color: "var(--txl)" }}>SEND {what.kind.toUpperCase()}</span>
          <span style={{ marginLeft: "auto", fontFamily: MONO, fontSize: "var(--t9)", color: "var(--txl)" }}>through Rivendell</span>
        </div>
        <div style={{ padding: "16px 18px 14px", display: "flex", flexDirection: "column", gap: 15 }}>
          <div style={{ display: "flex", gap: 12 }}>
            <Label>TO</Label>
            <div style={{ minWidth: 0, flex: 1 }}>
              {person ? (
                <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
                  <Avatar id={person.id} name={person.name} src={person.avatarUrl} size={26} state={person.online ? "on" : "away"} />
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontFamily: UI, fontSize: "var(--t125)", fontWeight: 500, color: "var(--txh)" }}>{person.name}</div>
                    <div style={{ marginTop: 2, fontFamily: MONO, fontSize: "var(--t9)", color: person.online ? "var(--ok)" : "var(--txl)" }}>
                      {person.online ? `${presence(person, Date.now() / 1000, h12).split(" · ")[0]} · lands in their TEAM tab` : `${presence(person, Date.now() / 1000, h12)} · it waits for them`}
                    </div>
                  </div>
                </div>
              ) : <div style={{ fontFamily: UI, fontSize: "var(--t115)", color: "var(--txl)" }}>No teammates to send to.</div>}
              {had && person && (() => {
                const st = sentStatus(had.last, nowSec);
                const firstName = person.name.split(" ")[0] || person.name;
                const sentAt = Date.parse(had.last.sentAt) / 1000;
                const bits = [newTurns > 0 && `${newTurns} turn${newTurns === 1 ? "" : "s"}`, newPics > 0 && `${newPics} picture${newPics === 1 ? "" : "s"}`].filter(Boolean);
                return (
                  <div style={{
                    marginTop: 9, padding: "8px 10px", borderRadius: 7, border: `1px solid ${mix("var(--info)", 32)}`, background: mix("var(--info)", 6),
                    display: "flex", gap: 8, fontFamily: UI, fontSize: "var(--t105)", lineHeight: 1.5, color: "var(--txm)",
                  }}>
                    <span style={{ flex: "none", marginTop: 2, color: "var(--info)", display: "flex" }}><History size={12} strokeWidth={2} /></span>
                    <span>
                      {firstName} has {bits.length ? "this session" : "this exact version"}: sent {ago(sentAt, nowSec) === "now" ? "just now" : `${ago(sentAt, nowSec)} ago`},{" "}
                      <b style={{ color: TONE[st.tone], fontWeight: 600 }}>{st.text}</b>.
                      {bits.length > 0 && <><br />Since then <b style={{ color: "var(--txh)", fontWeight: 600 }}>+{bits.join(", ")}</b>. It goes as v{had.count + 1}: {firstName} gets the new part on top of what they have, not a second copy.</>}
                    </span>
                  </div>
                );
              })()}
              {roster.length > 1 && (
                <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 9 }}>
                  {roster.map((t) => (
                    <button key={t.id} type="button" onClick={() => setTo(t.id)} aria-pressed={t.id === to} style={{
                      appearance: "none", cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 6, padding: "3px 8px 3px 4px",
                      borderRadius: 999, fontFamily: UI, fontSize: "var(--t105)", color: t.id === to ? "var(--txh)" : "var(--txm)",
                      border: `1px solid ${t.id === to ? mix("var(--acc)", 55) : "var(--line2)"}`, background: t.id === to ? mix("var(--acc)", 10) : "transparent",
                    }}><Avatar id={t.id} name={t.name} src={t.avatarUrl} size={16} state={t.online ? "on" : "away"} />{t.name.split(" ")[0]}</button>
                  ))}
                </div>
              )}
            </div>
          </div>
          <div style={{ display: "flex", gap: 12 }}>
            <Label>{what.kind.toUpperCase()}</Label>
            <div style={{ minWidth: 0 }}>
              {what.kind === "picture" && <img src={what.url} alt="" style={{ display: "block", maxWidth: 220, maxHeight: 120, borderRadius: 7, border: "1px solid var(--line2)", marginBottom: 6 }} />}
              <div style={{ fontFamily: UI, fontSize: "var(--t125)", fontWeight: 600, color: "var(--txh)", overflowWrap: "anywhere" }}>{title}</div>
              {what.kind === "session" && preview && (
                <div style={{ marginTop: 4, display: "flex", flexWrap: "wrap", gap: "2px 10px", fontFamily: MONO, fontSize: "var(--t9)", color: "var(--txl)" }}>
                  <span style={{ color: "var(--info)", fontFamily: UI }}>{(preview.repo || preview.project || "").split("/").pop()}</span>
                  {preview.branch && <span>⎇ {preview.branch}</span>}
                  <span>{preview.turns} turn{preview.turns === 1 ? "" : "s"}</span>
                </div>
              )}
              {what.kind === "file" && <div style={{ marginTop: 4, fontFamily: MONO, fontSize: "var(--t9)", color: "var(--txl)" }}>{what.file}</div>}
              {what.kind === "picture" && (
                <input value={picTitle} onChange={(e) => setPicTitle(e.target.value.slice(0, 200))} aria-label="Its title" placeholder="a title for it"
                  style={{
                    marginTop: 6, width: "100%", boxSizing: "border-box", border: `1px solid ${mix("var(--acc)", 30)}`, background: "color-mix(in srgb, var(--panel3) 60%, transparent)",
                    borderRadius: 7, padding: "6px 10px", fontFamily: UI, fontSize: "var(--t115)", color: "var(--txh)", outline: "none",
                  }} />
              )}
            </div>
          </div>
          {what.kind === "session" && preview?.running && (
            <div style={{ display: "flex", gap: 12 }}>
              <Label>WHEN</Label>
              <div role="radiogroup" aria-label="When it goes" style={{ minWidth: 0, flex: 1 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 7, fontFamily: UI, fontSize: "var(--t115)", color: "var(--warn)" }}>
                  <Clock size={12} strokeWidth={2} />A turn is still running in this session.
                </div>
                <Radio on={when === "end"} onPick={() => setWhen("end")} title="When it ends" hint="they get its answer too; nothing to wait for on your side" />
                <Radio on={when === "now"} onPick={() => setWhen("now")} title="Now" hint="up to here: the running turn reaches them unfinished, marked so" />
              </div>
            </div>
          )}
          {what.kind === "session" && (
            <div style={{ display: "flex", gap: 12 }}>
              <Label>SENDS</Label>
              <div style={{ minWidth: 0, flex: 1 }}>
                <Box on locked title="The transcript" hint="prompts, answers and steps, as you see them" />
                <Box on={pictures && !!preview?.pictures} locked={!preview?.pictures} onToggle={() => setPictures((v) => !v)}
                  title={`Pictures · ${picsLine}`} hint="the screenshots in its WORK zones" />
                <Box on={code} onToggle={() => setCode((v) => !v)} title="The code"
                  hint="this checkout with its uncommitted changes; it opens on a branch of its own" />
                {preview?.earlier && (
                  <Box on locked title={`Where it started · ${preview.earlier.turns} turn${preview.earlier.turns === 1 ? "" : "s"} from ${preview.earlier.from.split(" ")[0]}`}
                    hint={`the session you continued this from goes with it, words only, so ${person ? person.name.split(" ")[0] : "they"} can read where it began`} />
                )}
                <div style={{ marginTop: 8, display: "flex", alignItems: "center", gap: 7, fontFamily: UI, fontSize: "var(--t105)", color: "var(--txd)" }}>
                  <span style={{ color: "var(--ok)", display: "flex" }}><ShieldCheck size={12} strokeWidth={2} /></span>
                  {preview?.redacted ? `${preview.redacted} token-shaped string${preview.redacted === 1 ? "" : "s"} blanked out` : "Token-shaped text is blanked out"} · your home folder shows as ~ · .env files never go
                </div>
              </div>
            </div>
          )}
          <div style={{ display: "flex", gap: 12 }}>
            <Label>NOTE</Label>
            <textarea ref={noteRef} value={note} onChange={(e) => setNote(e.target.value.slice(0, 2000))} rows={3}
              placeholder="what should they do with it?"
              onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void send(); } }}
              style={{
                flex: 1, minWidth: 0, resize: "vertical", border: `1px solid ${mix("var(--acc)", 30)}`, background: "color-mix(in srgb, var(--panel3) 60%, transparent)",
                borderRadius: 7, padding: "8px 11px", fontFamily: UI, fontSize: "var(--t12)", lineHeight: 1.5, color: "var(--txh)", outline: "none",
              }} />
          </div>
          {error && <div role="alert" style={{ fontFamily: UI, fontSize: "var(--t105)", color: "var(--err)", lineHeight: 1.45 }}>{error}</div>}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 9, padding: "12px 18px 14px", borderTop: `1px solid ${mix("var(--acc)", 10)}` }}>
          <span style={{ flex: 1, fontFamily: UI, fontSize: "var(--t105)", lineHeight: 1.4, color: "var(--txl)" }}>Nothing runs on their side until they choose to continue it.</span>
          <button type="button" onClick={onClose} style={{ ...BTN, border: `1px solid ${mix("var(--acc)", 25)}`, background: "transparent", color: "var(--txm)" }}>CANCEL</button>
          <button type="button" disabled={!person || busy} onClick={() => void send()} style={{
            ...BTN, display: "inline-flex", alignItems: "center", gap: 7, border: `1px solid ${mix("var(--acc)", 45)}`,
            background: mix("var(--acc)", 20), color: "var(--txh)", opacity: !person || busy ? 0.6 : 1,
          }}><Send size={11} strokeWidth={2} />{busy ? "SENDING…" : label}</button>
        </div>
      </div>
    </div>
  );
}
