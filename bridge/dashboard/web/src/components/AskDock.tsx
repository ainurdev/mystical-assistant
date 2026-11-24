import { Fragment, createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  ArrowDown, Ban, Check, ChevronDown, ChevronLeft, ChevronRight, ChevronUp, CircleQuestionMark, ListChecks, Maximize2, MessageCircleQuestion,
  KeyRound, Minimize2, MonitorCog, Plug, SquareTerminal, X,
} from "lucide-react";
import { api, SCOPE_WORD, scopeAnswer, type AllowScope, type AnswerSelection, type CardAnswer, type Question } from "../api";
import { splitAsk, waited, type Docked } from "../lib/askdock";
import { frameOf, optionKey, parsePreview, previewTexts, sharedShot, staged } from "../lib/qpreview";
import { clearDraft, readDraft, saveDraft } from "../lib/questionDraft";
import { hhmm as clock, useClock12 } from "../lib/surfaces";
import { mcpParts } from "../lib/tools";
import { SecretForm } from "./EvidenceRows";
import { ImageLightbox } from "./ImageLightbox";
import { Markdown } from "./Markdown";
import { REC, TaskQuestion, TextPreview, isTask, taskLabel, taskVerb } from "./QuestionCard";
import { Spinner } from "./ui";
import { Keys, useAskKeys } from "./ui/Keys";

/* Every card that waits on you, docked on the prompt box
   (.mystical/design-drafts/response-cards, C · DOCK — the user's pick over an
   in-place card and a louder in-place one). The ask sits where your hands
   already are and never scrolls away; the transcript keeps a marker where it
   was asked (AskMarker) and, once it's answered, a header and a chip per answer
   (AskRecord); a chip opens its question read-only — every option, the skipped
   ones too.

   The box is the answer: what you type goes back as your own answer (a
   question) or as the reason with a Deny (a permission), and its button names
   what goes back. The dock reports that to the composer through `bind`
   (AskMode) instead of drawing a second input.

   Colour is the theme's `--ask`, the hue that already means "waits on you" in
   the sidebar and the notifications. Tokens only, so every family and every
   prompt-box layout draws it (index.css, THE ASK DOCK). */

export interface AskMode {
  placeholder: string;
  /** The box's primary button while it answers this; absent, the box sends as usual. */
  label?: ReactNode;
  /** The button works on an empty box: a pick is made. */
  ready?: boolean;
  /** The button needs text: a Deny's note. */
  needsText?: boolean;
  /** Where the box's text goes instead of a new prompt. The dock clears the box. */
  send?: (text: string) => void;
  /** The box's footer while it answers this: the ⌘1–N keys, named once instead of on every row. */
  hint?: ReactNode;
}

type Respond = (requestId: string, opts: { behavior?: "allow" | "deny"; answers?: CardAnswer[]; message?: string })
  => Promise<false | { noted?: boolean }>;

const Key = ({ k, on }: { k: string; on?: boolean }) => (
  <span className="ad-key" data-on={on ? "" : undefined}>{on ? <Check size={12} strokeWidth={3} aria-hidden /> : k}</span>
);
const Pk = ({ k }: { k: string }) => <span className="ask-pk">{k}</span>;

/** "waiting · 2m", ticking. */
function Wait({ at, word = "waiting" }: { at?: number; word?: string }) {
  const [, tick] = useState(0);
  useEffect(() => { const t = setInterval(() => tick((n) => n + 1), 15_000); return () => clearInterval(t); }, []);
  const w = waited(at);
  return <span className="ad-wait"><span className="ad-beacon" aria-hidden />{w ? `${word} · ${w}` : word}</span>;
}

/** The dock folded to its head line, so the session above it can be read
 *  (.mystical/design-drafts/ask-dock-readable, A · LIST + fold). Per ask: the
 *  next one opens unfolded. Folded, the body is only hidden, so the box still
 *  answers and ⌘1–9 still pick (their mark stays in the DOM). */
const Fold = createContext<{ folded: boolean; toggle: () => void } | null>(null);

/** One line: what kind of ask, about what, since when, and the fold. Folded, `line` (the ask itself) stands in for the rest. */
function Head({ icon, kind, topic, children, at, word, line }: {
  icon?: ReactNode; kind: string; topic?: string; children?: ReactNode; at?: number; word?: string; line?: string;
}) {
  const fold = useContext(Fold);
  const folded = !!fold?.folded;
  return (
    <div className="ad-h">
      {icon && <span className="ad-g" aria-hidden>{icon}</span>}
      <span className="ad-kind">{kind}</span>
      {topic && <span className="ad-topic">· {topic}</span>}
      {folded ? line && <span className="ad-line">{line}</span> : children}
      <Wait at={at} word={word} />
      {fold && (
        <button type="button" className="ad-fold" onClick={fold.toggle} aria-expanded={!folded}
          title={folded ? "Open it again" : "Fold it to read the session"} aria-label={folded ? "Open it again" : "Fold it"}>
          {folded ? <ChevronUp size={14} strokeWidth={2.4} aria-hidden /> : <ChevronDown size={14} strokeWidth={2.4} aria-hidden />}
        </button>
      )}
    </div>
  );
}

/** Context, then the ask: in reading order, all of it (it scrolls in the dock when long). */
function AskText({ text }: { text: string }) {
  const s = splitAsk(text);
  return (
    <>
      {s.ctx && <p className="ad-ctx">{s.ctx}</p>}
      <p className="ad-ask">{s.ask}</p>
      {s.tail && <p className="ad-tail">{s.tail}</p>}
    </>
  );
}

export function AskDock({ d, draft, setDraft, onRespond, onAnswer, onSteer, bind, stashed }: {
  d: Docked;
  draft: string;
  setDraft: (text: string) => void;
  onRespond: Respond;
  /** A reply to a question asked in prose ("No" drops it). */
  onAnswer: (text: string) => void;
  /** A Deny's note the bridge couldn't carry (an older bridge, an ACP agent). */
  onSteer: (text: string) => void;
  bind: (mode: AskMode | null) => void;
  /** The box held a draft when this docked; it's set aside until you answer. */
  stashed: boolean;
}) {
  const key = d.kind === "prose" ? d.turnId : d.requestId;
  // Which ask is folded: a new one (another key) opens unfolded.
  const [foldedKey, setFoldedKey] = useState<string | null>(null);
  const fold = useMemo(() => ({ folded: foldedKey === key, toggle: () => setFoldedKey((f) => f === key ? null : key) }), [foldedKey, key]);
  // A marker's "answer below" lands here: open the dock, flash it, focus the box.
  const [flash, setFlash] = useState(0);
  useEffect(() => {
    const f = () => { setFoldedKey(null); setFlash((n) => n + 1); };
    window.addEventListener("ask:focus", f);
    return () => window.removeEventListener("ask:focus", f);
  }, []);
  useEffect(() => () => bind(null), [bind]);
  return (
    <Fold.Provider value={fold}>
    <div className="askdock" data-kind={d.kind} data-flash={flash % 2 ? "a" : flash ? "b" : undefined} data-folded={fold.folded ? "" : undefined}>
      {d.kind === "question" && d.questions[0]?.computer
        ? <ComputerDock key={key} d={d} onRespond={onRespond} bind={bind} />
        : d.kind === "question"
        ? <QuestionDock key={key} d={d} draft={draft} setDraft={setDraft} onRespond={onRespond} bind={bind} />
        : d.kind === "permission"
          ? <PermissionDock key={key} d={d} draft={draft} setDraft={setDraft} onRespond={onRespond} onSteer={onSteer} bind={bind} />
          : d.kind === "secret"
            ? <SecretDock key={key} d={d} onRespond={onRespond} bind={bind} />
            : <ProseDock key={key} d={d} onAnswer={onAnswer} bind={bind} />}
      {stashed && <p className="ad-note">Your draft is set aside: it comes back after you answer.</p>}
    </div>
    </Fold.Provider>
  );
}

/* ── a question (AskUserQuestion): one or several, one pick or many, pictures ── */

function QuestionDock({ d, draft, setDraft, onRespond, bind }: {
  d: Extract<Docked, { kind: "question" }>;
  draft: string;
  setDraft: (text: string) => void;
  onRespond: Respond;
  bind: (mode: AskMode | null) => void;
}) {
  const qs = d.questions;
  const rid = d.requestId;
  const task = isTask(qs);
  const [restored] = useState(() => readDraft(rid));
  // Picks and notes are keyed by the question's position: headers can repeat.
  const [sel, setSel] = useState<Record<string, string[]>>(() => {
    // The Rivendell task question arrives with its suggestion picked (QuestionCard).
    const rec = task && !Object.keys(restored.sel).length && qs[0].options.find((o) => REC.test(o.label));
    return rec ? { 0: [rec.label] } : restored.sel;
  });
  // Every page's note but the one on screen: that one is the box's draft.
  const [notes, setNotes] = useState<Record<string, string>>(restored.notes);
  const [page, setPage] = useState(0);
  const [sending, setSending] = useState(false);
  const [failed, setFailed] = useState(false);
  const q = qs[page] ?? qs[0];
  const picked = sel[page] ?? [];
  const last = page === qs.length - 1;
  const answered = (qi: number) => (sel[qi]?.length ?? 0) > 0 || ((qi === page ? draft : notes[qi]) ?? "").trim() !== "";

  useEffect(() => { saveDraft(rid, { sel, notes }); }, [rid, sel, notes]);

  function toggle(label: string) {
    setFailed(false);
    setSel((prev) => {
      const cur = prev[page] ?? [];
      if (q.multiSelect) return { ...prev, [page]: cur.includes(label) ? cur.filter((l) => l !== label) : [...cur, label] };
      return { ...prev, [page]: [label] };
    });
  }
  function go(to: number, text = draft) {
    setNotes((n) => ({ ...n, [page]: text }));
    setDraft(notes[to] ?? "");
    setPage(to);
  }
  async function send(text: string) {
    if (sending) return;
    if (!last) { go(page + 1, text); return; }
    const all: Record<string, string> = { ...notes, [page]: text };
    setSending(true);
    setFailed(false);
    const ok = await onRespond(rid, {
      answers: qs.map((x, qi) => ({ header: x.header, labels: sel[qi] ?? [], notes: (all[qi] ?? "").trim() || undefined })),
    });
    if (ok === false) { setSending(false); setFailed(true); return; }
    clearDraft(rid);
    setDraft("");
  }
  const sendRef = useRef(send);
  sendRef.current = send;

  // What the box's button says. Strings key the memo; the node follows them.
  const pick = !q.multiSelect && picked[0] ? optionKey(picked[0], q.options.findIndex((o) => o.label === picked[0])) : null;
  const typed = draft.trim() !== "";
  const verb = task ? taskVerb(q, picked[0]) : null;
  const openN = qs.filter((_, qi) => !answered(qi)).length;
  const state = sending ? "sending"
    : !last ? (pick ? `next:${pick.key}` : typed || picked.length ? "next" : "go")
    : qs.length > 1 ? (openN ? `open:${openN}` : "all")
    : verb ? `verb:${verb}`
    : q.multiSelect ? (picked.length ? `many:${picked.length}` : typed ? "own" : "none")
    : pick ? `one:${pick.key}` : typed ? "own" : "none";
  const mode = useMemo<AskMode>(() => {
    const label: ReactNode = state === "sending" ? <><Spinner className="h-3 w-3 border" /> Sending…</>
      : state.startsWith("next:") && pick ? <>Next <Pk k={pick.key} /> {pick.name} <ChevronRight size={13} aria-hidden /></>
      : state === "next" ? <>Next <ChevronRight size={13} aria-hidden /></>
      : state === "go" ? "Pick to go on"
      : state === "all" ? `Send ${qs.length} answers`
      : state.startsWith("open:") ? `${openN} still open`
      : state.startsWith("verb:") ? verb
      : state.startsWith("many:") ? <>Send <Pk k={String(picked.length)} /> picked</>
      : state.startsWith("one:") && pick ? <>Send <Pk k={pick.key} /> {pick.name}</>
      : state === "own" ? "Send your answer"
      : "Pick or type an answer";
    const n = Math.min(q.options.length, 9);
    // The rows show letters; the hint says which ones the digits reach.
    const reach = n > 1 ? `${optionKey(q.options[0].label, 0).key}–${optionKey(q.options[n - 1].label, n - 1).key}` : n ? optionKey(q.options[0].label, 0).key : "";
    return {
      placeholder: picked.length ? "Add a note, or just send…" : "Or type your own answer…",
      label,
      hint: n > 0 ? <>{n > 1 ? <><Keys k="Ctrl+1" />{" – "}<Keys k={`Ctrl+${n}`} /></> : <Keys k="Ctrl+1" />} picks {reach}</> : undefined,
      ready: !sending && (state === "all" || /^(next:|one:|many:|verb:)/.test(state) || (state === "next" && picked.length > 0)),
      send: (t: string) => { void sendRef.current(t); },
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, picked.length > 0, page]);
  useEffect(() => { bind(mode); }, [mode, bind]);
  // ⌘1–9 pick on this page and a pick-one question then moves on by itself (the
  // last one waits); ⌘↵ is the box's button: Next, or Send on the last (ui/Keys).
  const mark = useAskKeys((k) => {
    if (sending) return false;
    if (k === "enter") {
      if (mode.ready) mode.send?.(draft);
      return !!mode.ready;
    }
    const o = q.options[Number(k) - 1];
    if (!o) return false;
    toggle(o.label);
    if (!q.multiSelect && !last) go(page + 1);
    return true;
  });

  const folded = !!useContext(Fold)?.folded;
  const pics = staged(q);
  const texts = previewTexts(q);
  return (
    <>
      <Head kind="Question" topic={qs.length > 1 ? (folded ? `${page + 1} of ${qs.length}` : undefined) : task ? "Rivendell task" : q.header}
        at={d.at} line={splitAsk(q.question).ask}>
      {qs.length > 1 && (
        <div className="ad-steps">
          {page > 0 && (
            <button type="button" className="ad-back" onClick={() => go(page - 1)} disabled={sending}>
              <ChevronLeft size={12} strokeWidth={2.4} aria-hidden />Back
            </button>
          )}
          {qs.map((x, qi) => {
            const done = qi !== page && answered(qi);
            const name = (sel[qi] ?? []).map((l) => optionKey(l, qs[qi].options.findIndex((o) => o.label === l)).name).join(", ");
            return (
              <button key={qi} type="button" className="ad-st" data-on={qi === page ? "" : undefined} data-done={done ? "" : undefined}
                onClick={() => qi !== page && go(qi)} disabled={sending}>
                <i>{done ? <Check size={10} strokeWidth={3.2} aria-hidden /> : qi + 1}</i>{x.header}
                {done && name && <em>· {name}</em>}
              </button>
            );
          })}
        </div>
      )}
        {d.of > 1 && <span className="ad-more">+{d.of - 1} more after this</span>}
      </Head>
      <div className="ad-b" key={page}>
        <span ref={mark} data-ask-keys hidden />
        {task ? <TaskQuestion text={q.question} /> : <AskText text={q.question} />}
        {pics
          ? <Pictures q={q} chosen={picked} onPick={toggle} sending={sending} />
          : (
            <div className="ad-rows" role={q.multiSelect ? "group" : "radiogroup"} aria-label={q.header}>
              {q.options.map((o, i) => {
                const k = optionKey(o.label, i);
                const on = picked.includes(o.label);
                return (
                  <button key={o.label} type="button" className="ad-row" aria-pressed={on} disabled={sending}
                    data-multi={q.multiSelect ? "" : undefined} onClick={() => toggle(o.label)}>
                    <Key k={k.key} on={on} />
                    <span className="ad-lab">
                      {task ? taskLabel(o.label, true) : k.name}
                      {k.rec && !task && <span className="ad-sug">Recommended</span>}
                    </span>
                    {o.description && <span className="ad-desc">{o.description}</span>}
                  </button>
                );
              })}
            </div>
          )}
        {texts && <TextPreview q={q} texts={texts} picked={picked[0]} />}
        {q.multiSelect && <p className="ad-hint">Pick any — they all go back together.</p>}
        {failed && <p className="ad-err">That didn't reach the bridge. Try again.</p>}
      </div>
    </>
  );
}

/** A question whose options carry pictures (.mystical/design-drafts/ask-pictures-steady).
 *  Only the options that bring pictures get picture space; the others are plain rows
 *  under them, never a "No picture" box. One pictured option (approve / revise / park)
 *  is what the question is about: its shots fill a stage and every option is a row.
 *  Several are tiles showing the same shot (the tabs switch every tile at once), and
 *  Bigger pages them on a stage. Every frame takes the question's largest shot
 *  (lib/qpreview frameOf), so a tab or an option never resizes the dock, and every
 *  shot fills that frame as large as it fits, centred. A shot every option shares
 *  says so on the picture (sharedShot). Every picture opens the lightbox with PICK. */
function Pictures({ q, chosen, onPick, sending, readOnly = false }: {
  q: Question; chosen: string[]; onPick: (label: string) => void; sending: boolean;
  /** The answered record: tiles open their picture and Bigger pages them; nothing is picked. */
  readOnly?: boolean;
}) {
  const opts = q.options.map((o, i) => ({ o, ...optionKey(o.label, i), pv: parsePreview(o.preview) }));
  const pics = opts.filter((x) => x.pv.shots.length || x.pv.text);
  const solo = pics.length === 1;
  const rows = solo ? opts : opts.filter((x) => !pics.includes(x));
  const tabs = pics.reduce((m, x) => (x.pv.shots.length > m.length ? x.pv.shots : m), pics[0]?.pv.shots ?? []);
  const [tab, setTab] = useState(0);
  const [big, setBig] = useState(false);
  // the stage grows the dock (index.css .askdock[data-stage])
  const stage = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const dock = stage.current?.closest<HTMLElement>(".askdock");
    if (!dock) return;
    dock.dataset.stage = "";
    return () => { delete dock.dataset.stage; };
  }, [solo, big]);
  const at = pics.findIndex((x) => chosen.includes(x.o.label));
  const [shown, setShown] = useState(at >= 0 ? at : 0);
  const [zoom, setZoom] = useState<number | null>(null);
  const [dims, setDims] = useState<Record<string, [number, number]>>({});
  const [gone, setGone] = useState<Set<string>>(() => new Set());
  const [W, H] = frameOf(pics.flatMap((x) => x.pv.shots).filter((s) => !gone.has(s.path)).map((s) => dims[s.path]));
  const frame = { "--W": W, "--H": H, "--ar": Math.min(Math.max(W / H, 1.15), 2.4) } as React.CSSProperties;
  const kOf = (x: (typeof pics)[number]) => Math.min(tab, Math.max(x.pv.shots.length - 1, 0));
  // two identical tiles read as a mix-up unless the picture says why (2026-11-03)
  const same = sharedShot(pics.map((x) => x.pv.shots), tab) && <span className="ad-same">Same in every option</span>;
  const all = pics.flatMap((x, pi) => x.pv.shots.map((s, k) => ({
    pi, k, src: api.attachmentUrl(s.path), tag: x.key,
    name: [`${x.key} · ${x.name}`, x.pv.shots.length > 1 ? `${k + 1}/${x.pv.shots.length}` : "", s.alt].filter(Boolean).join(" · "),
  })));
  const open = (pi: number) => {
    const i = all.findIndex((a) => a.pi === pi && a.k === kOf(pics[pi]));
    if (i >= 0) setZoom(i);
  };
  // One option's shots stacked in a frame, only the `on` one visible.
  const layers = (x: (typeof pics)[number], on: (k: number) => boolean) => x.pv.shots.length
    ? x.pv.shots.map((s, k) => (
      <span key={k} className="ad-shot" data-on={on(k) ? "" : undefined}>
        {gone.has(s.path)
          ? <span className="ad-pre">{s.alt || "This picture is gone."}</span>
          : <img src={api.attachmentUrl(s.path)} alt={`${x.key} · ${x.name}${s.alt ? ` · ${s.alt}` : ""}`} draggable={false}
              onLoad={(e) => { const im = e.currentTarget; setDims((d) => ({ ...d, [s.path]: [im.naturalWidth, im.naturalHeight] })); }}
              onError={() => setGone((g) => new Set(g).add(s.path))} />}
      </span>
    ))
    : [<span key="t" className="ad-shot ad-pre" data-on={on(0) ? "" : undefined}>{x.pv.text}</span>];
  const cur = pics[shown] ?? pics[0];
  const curShot = cur.pv.shots[kOf(cur)];
  return (
    <>
      <div className="ad-pbar">
        {tabs.length > 1 && (
          <span className="ad-tabs" role="tablist" aria-label="Shots">
            {tabs.map((s, k) => (
              <button key={k} type="button" role="tab" aria-selected={k === tab} className="ad-tab" onClick={() => setTab(k)}>
                <i>{k + 1}</i>{s.alt || `Shot ${k + 1}`}
              </button>
            ))}
          </span>
        )}
        {solo
          ? curShot && <button type="button" className="ad-grow" onClick={() => open(0)}><Maximize2 size={11} aria-hidden /> Full size</button>
          : (
            <button type="button" className="ad-grow" onClick={() => setBig((b) => !b)} title={big ? "Back to the tiles" : "See one option large"}>
              {big ? <><Minimize2 size={11} aria-hidden /> Smaller</> : <><Maximize2 size={11} aria-hidden /> Bigger</>}
            </button>
          )}
      </div>
      {solo || big ? (
        <>
          <div ref={stage} className="ad-stage" style={frame}>
            {!solo && (
              <div className="ad-sh">
                <Key k={cur.key} on={chosen.includes(cur.o.label)} />
                <b>{cur.name}</b>
                {curShot && <span className="ad-of">{cur.pv.shots.length > 1 ? `shot ${kOf(cur) + 1} of ${cur.pv.shots.length}` : "1 shot"}{curShot.alt ? ` · ${curShot.alt}` : ""}</span>}
                {curShot && <button type="button" className="ad-full" onClick={() => open(shown)}><Maximize2 size={11} aria-hidden /> Full size</button>}
              </div>
            )}
            {/* Bigger drops the tiles, and the chips under the stage carry names
                only: without this the shown option's description had nowhere to be. */}
            {!solo && cur.o.description && <p className="ad-shd">{cur.o.description}</p>}
            <div className="ad-pic">
              <div className="ad-frame" onClick={() => open(shown)} title={curShot ? "Open full size" : undefined}>
                {pics.map((x, pi) => <Fragment key={pi}>{layers(x, (k) => pi === shown && k === kOf(x))}</Fragment>)}
                {same}
              </div>
              {pics.length > 1 && <>
                <button type="button" className="ad-nav" data-side="l" aria-label="Previous option" onClick={() => setShown((shown + pics.length - 1) % pics.length)}><ChevronLeft size={16} strokeWidth={2.4} /></button>
                <button type="button" className="ad-nav" data-side="r" aria-label="Next option" onClick={() => setShown((shown + 1) % pics.length)}><ChevronRight size={16} strokeWidth={2.4} /></button>
              </>}
            </div>
          </div>
          {!solo && (
            <div className="ad-strip">
              {pics.map((x, pi) => (
                <button key={x.o.label} type="button" className="ad-chip" aria-pressed={chosen.includes(x.o.label)} data-shown={pi === shown ? "" : undefined}
                  disabled={sending} onClick={() => { setShown(pi); if (!readOnly) onPick(x.o.label); }}>
                  <Key k={x.key} on={chosen.includes(x.o.label)} />{x.name}{x.rec && <span className="ad-sug">Recommended</span>}
                  {x.pv.shots.length > 0 && <small>{x.pv.shots.length === 1 ? "1 shot" : `${x.pv.shots.length} shots`}</small>}
                </button>
              ))}
            </div>
          )}
        </>
      ) : (
        <div className="ad-pics" style={{ "--n": Math.min(pics.length, 4), ...frame } as React.CSSProperties}>
          {pics.map((x, pi) => {
            const on = chosen.includes(x.o.label);
            return (
              <div key={x.o.label} className="ad-tile" data-on={on ? "" : undefined}>
                <button type="button" className="ad-tilebtn" aria-pressed={on} disabled={sending}
                  onClick={() => { setShown(pi); if (readOnly) open(pi); else onPick(x.o.label); }}>
                  <span className="ad-th ad-frame">{layers(x, (k) => k === kOf(x))}{same}</span>
                  <span className="ad-meta">
                    <Key k={x.key} on={on} />
                    <span className="ad-lab">{x.name}{x.rec && <span className="ad-sug">Recommended</span>}</span>
                    {x.o.description && <span className="ad-desc">{x.o.description}</span>}
                  </span>
                </button>
                {x.pv.shots.length > 0 && (
                  <button type="button" className="ad-zm" title="Open full size" aria-label={`Open ${x.name} full size`} onClick={() => open(pi)}>
                    <Maximize2 size={11} aria-hidden />
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}
      {rows.length > 0 && (
        <div className="ad-rows" role={readOnly ? undefined : "radiogroup"} aria-label={q.header}>
          {rows.map((x) => {
            const on = chosen.includes(x.o.label);
            const inner = <>
              <Key k={x.key} on={on} />
              <span className="ad-lab">{x.name}{x.rec && <span className="ad-sug">Recommended</span>}</span>
              {x.o.description && <span className="ad-desc">{x.o.description}</span>}
            </>;
            return readOnly
              ? <div key={x.o.label} className="ad-row" aria-pressed={on} data-ro="">{inner}</div>
              : <button key={x.o.label} type="button" className="ad-row" aria-pressed={on} disabled={sending} onClick={() => onPick(x.o.label)}>{inner}</button>;
          })}
        </div>
      )}
      {zoom !== null && all[zoom] && (
        <ImageLightbox
          src={all[zoom].src}
          all={all}
          onClose={() => setZoom(null)}
          action={readOnly ? undefined : (i) => {
            const a = all[i];
            return a ? { label: `PICK ${pics[a.pi].key}`, onClick: () => { onPick(pics[a.pi].o.label); setShown(a.pi); setTab(a.k); setZoom(null); } } : null;
          }}
        />
      )}
    </>
  );
}

/* ── a permission (can_use_tool): a command, a plan, an MCP call, any tool ── */

/** An MCP call's input, as runner._mcp_detail wrote it ("key: value" lines,
 *  long strings as "key:" then their lines), back into rows. */
function kvRows(detail: string): [string, string][] {
  const rows: [string, string][] = [];
  for (const line of detail.split("\n")) {
    const m = /^([A-Za-z_][\w.-]{0,40}):(?:\s(.*))?$/.exec(line);
    if (m) rows.push([m[1], m[2] ?? ""]);
    else if (rows.length) rows[rows.length - 1][1] += (rows[rows.length - 1][1] ? "\n" : "") + line;
  }
  return rows;
}

function KvValue({ v }: { v: string }) {
  if (v === "[]" || v === "{}" || v === "") return <span className="ad-none">nothing</span>;
  if (/^\[.*\]$/.test(v)) {
    try {
      const xs = JSON.parse(v) as unknown[];
      if (xs.every((x) => typeof x === "string")) return <>{(xs as string[]).map((x) => <span key={x} className="ad-vchip">{x}</span>)}</>;
    } catch { /* not JSON: as written */ }
  }
  return <>{v}</>;
}

function PermissionDock({ d, draft, setDraft, onRespond, onSteer, bind }: {
  d: Extract<Docked, { kind: "permission" }>;
  draft: string;
  setDraft: (text: string) => void;
  onRespond: Respond;
  onSteer: (text: string) => void;
  bind: (mode: AskMode | null) => void;
}) {
  const [sending, setSending] = useState<"allow" | "deny" | AllowScope | null>(null);
  const [failed, setFailed] = useState(false);
  const mcp = d.tool.startsWith("mcp__") ? mcpParts(d.tool) : null;
  const plan = d.tool === "ExitPlanMode";
  const bash = d.tool === "Bash";
  // Mystical's own card for a delegate call (bridge/gateway.py): what it would start.
  const helpers = d.tool === "delegate";
  async function answer(behavior: "allow" | "deny", note = "", scope?: AllowScope) {
    if (sending) return;
    setSending(scope ?? behavior);
    setFailed(false);
    const res = await onRespond(d.requestId, scope ? { behavior, answers: scopeAnswer(scope) } : note ? { behavior, message: note } : { behavior });
    if (res === false) { setSending(null); setFailed(true); return; }
    if (note) {
      setDraft("");
      // An older bridge drops the note: it still reaches the turn, right behind the Deny.
      if (!res.noted) onSteer(note);
    }
  }
  const sendRef = useRef(answer);
  sendRef.current = answer;
  const typed = draft.trim() !== "";
  const mode = useMemo<AskMode>(() => ({
    placeholder: plan ? "Type what to change, and it goes back with Keep planning…" : "Type to deny it and say what to do instead…",
    label: sending === "deny" ? <><Spinner className="h-3 w-3 border" /> Sending…</> : plan ? "Keep planning with note" : "Deny with note",
    needsText: true,
    send: (t: string) => { void sendRef.current("deny", t); },
  }), [plan, sending]);
  useEffect(() => { bind(mode); }, [mode, bind]);
  // ⌘1 allows, ⌘2 denies (with the box's note, as the button does) — ui/Keys.
  const mark = useAskKeys((k) => {
    if (sending || (k !== "1" && k !== "2")) return false;
    void (k === "1" ? answer("allow") : answer("deny", draft.trim()));
    return true;
  });

  const topic = bash ? "Bash" : plan ? "ready to build" : helpers ? "helpers" : mcp ? `${mcp.server} · ${mcp.tool}` : d.tool;
  return (
    <>
      <Head icon={plan ? <ListChecks size={13} strokeWidth={2.2} /> : mcp ? <Plug size={13} strokeWidth={2.2} /> : <SquareTerminal size={13} strokeWidth={2.2} />}
        kind={plan ? "Plan" : "Permission"} topic={topic} at={d.at} word="asked" line={plan ? undefined : d.summary}>
        {d.of > 1 && <span className="ad-more">+{d.of - 1} more after this</span>}
      </Head>
      <div className="ad-b">
        {bash ? (
          <>
            <p className="ad-ask">Run this command?</p>
            <pre className="ad-cmd"><span className="ad-pr" aria-hidden>$ </span>{d.detail ?? d.summary}</pre>
          </>
        ) : plan ? (
          <>
            <p className="ad-ask">Build this plan?</p>
            <div className="ad-plan"><Markdown>{d.detail ?? d.summary}</Markdown></div>
          </>
        ) : mcp ? (
          <>
            <p className="ad-ask">Let <b>{mcp.server}</b> run <code>{mcp.tool}</code>?</p>
            {d.detail
              ? <div className="ad-kv">{kvRows(d.detail).map(([k, v], i) => <div key={i} className="ad-kvr"><span className="k">{k}</span><span className="v"><KvValue v={v} /></span></div>)}</div>
              : d.summary && <pre className="ad-cmd">{d.summary}</pre>}
          </>
        ) : helpers ? (
          <>
            <p className="ad-ask">{d.summary}?</p>
            {d.detail && <pre className="ad-cmd">{d.detail}</pre>}
          </>
        ) : (
          <>
            <p className="ad-ask">Allow <b>{d.tool}</b>?</p>
            {d.summary && <pre className="ad-cmd">{d.detail ?? d.summary}</pre>}
          </>
        )}
        <div className="ad-acts">
          <span ref={mark} data-ask-keys hidden />
          <button type="button" className="ad-btn" data-pri="" disabled={!!sending} onClick={() => void answer("allow")}>
            {sending === "allow" ? <Spinner className="h-3 w-3 border" /> : <Check size={13} strokeWidth={2.6} aria-hidden />}
            {plan ? "Approve & build" : "Allow"}
            <Keys k="Ctrl+1" hover />
          </button>
          {(d.scopes ?? []).map((sc) => (
            <button key={sc} type="button" className="ad-btn" disabled={!!sending} onClick={() => void answer("allow", "", sc)}
              title={sc === "turn" ? "Allow this and every later one until this turn ends" : "Allow this and stop asking in this chat"}>
              {sending === sc ? <Spinner className="h-3 w-3 border" /> : <Check size={13} strokeWidth={2.6} aria-hidden />}
              {SCOPE_WORD[sc]}
            </button>
          ))}
          <button type="button" className="ad-btn" disabled={!!sending} onClick={() => void answer("deny", draft.trim())}>
            {sending === "deny" ? <Spinner className="h-3 w-3 border" /> : <X size={13} strokeWidth={2.6} aria-hidden />}
            {plan ? "Keep planning" : typed ? "Deny with note" : "Deny"}
            <Keys k="Ctrl+2" hover />
          </button>
          <span className="ad-aside">{plan ? "nothing has changed yet" : "or type below to deny it and say what to do instead"}</span>
        </div>
        {failed && <p className="ad-err">That didn't reach the bridge. Try again.</p>}
      </div>
    </>
  );
}

/* ── computer use's access ask (bridge/computer.py): the apps, each FULL or LOOK,
      the extra grants as ticks, Allow or Deny. It arrives as a question so
      Telegram and the Mini App can answer it with plain options; here it gets
      the dock drawn in .mystical/design-drafts/computer-use (1 · Access ask). ── */

function ComputerDock({ d, onRespond, bind }: {
  d: Extract<Docked, { kind: "question" }>;
  onRespond: Respond;
  bind: (mode: AskMode | null) => void;
}) {
  const [q, also] = d.questions;
  const cu = q.computer!;
  const [ticked, setTicked] = useState<string[]>([]);
  const [sending, setSending] = useState<"allow" | "deny" | null>(null);
  const [failed, setFailed] = useState(false);
  const mode = useMemo<AskMode>(() => ({ placeholder: "Answer above, or type to steer…" }), []);
  useEffect(() => { bind(mode); }, [mode, bind]);
  const [allow, deny] = q.options;
  async function answer(which: "allow" | "deny") {
    if (sending) return;
    setSending(which);
    setFailed(false);
    const answers = [{ header: q.header, labels: [(which === "allow" ? allow : deny).label] },
      ...(also ? [{ header: also.header, labels: which === "allow" ? ticked : [] }] : [])];
    if ((await onRespond(d.requestId, { answers })) === false) { setSending(null); setFailed(true); }
  }
  // ⌘1 allows, ⌘2 denies, as a click would (ui/Keys).
  const mark = useAskKeys((k) => {
    if (sending || (k !== "1" && k !== "2")) return false;
    void answer(k === "1" ? "allow" : "deny");
    return true;
  });
  const look = cu.apps.some((a) => a.tier === "look");
  return (
    <>
      <Head icon={<MonitorCog size={13} strokeWidth={2.2} />} kind="Computer" topic="your Mac" at={d.at}
        line="Let this chat control these apps?" />
      <div className="ad-b cu-b">
        <p className="ad-ask">Let this chat control these apps?</p>
        {cu.why && <p className="cu-why">{cu.why}</p>}
        <div className="cu-apps">
          {cu.apps.map((a) => (
            <div key={a.name} className="cu-app">
              <span className="cu-ic" aria-hidden>{a.name.slice(0, 1).toUpperCase()}</span>
              <span className="cu-an">{a.name}<small>{a.tier === "full" ? "see · click · type" : "see only: typing here could run code"}</small></span>
              <span className="cu-tier caps" data-tier={a.tier}>{a.tier === "full" ? "Full" : "Look"}</span>
            </div>
          ))}
        </div>
        {also && (
          <div className="cu-extra" role="group" aria-label="Also allow">
            {also.options.map((o) => {
              const on = ticked.includes(o.label);
              return (
                <button key={o.label} type="button" className="cu-chk" aria-pressed={on} disabled={!!sending}
                  onClick={() => setTicked((t) => on ? t.filter((x) => x !== o.label) : [...t, o.label])}>
                  {o.label.toLowerCase()}
                </button>
              );
            })}
          </div>
        )}
        <div className="cu-btns">
          <span ref={mark} data-ask-keys hidden />
          <button type="button" className="ad-btn" data-pri="" disabled={!!sending} onClick={() => void answer("allow")}>
            {sending === "allow" ? <Spinner className="h-3 w-3 border" /> : <>Allow apps <Keys k="Ctrl+1" /></>}
          </button>
          <button type="button" className="ad-btn" disabled={!!sending} onClick={() => void answer("deny")}>
            {sending === "deny" ? <Spinner className="h-3 w-3 border" /> : <>Deny <Keys k="Ctrl+2" /></>}
          </button>
        </div>
        {failed && <p className="ad-err">That didn't reach the bridge. Try again.</p>}
        <p className="cu-note">
          Other apps stay hidden in screenshots and can't be clicked{look ? "; look-only apps are seen, never typed into" : ""}.
          Esc on the Mac stops it any time.
        </p>
      </div>
    </>
  );
}

/* ── a secret (request_secret): typed here and nowhere else, so the box stays out of it ── */

function SecretDock({ d, onRespond, bind }: {
  d: Extract<Docked, { kind: "secret" }>;
  onRespond: Respond;
  bind: (mode: AskMode | null) => void;
}) {
  const mode = useMemo<AskMode>(() => ({ placeholder: "Answer in the card above…" }), []);
  useEffect(() => { bind(mode); }, [mode, bind]);
  return (
    <>
      <Head icon={<KeyRound size={13} strokeWidth={2.2} />} kind="Secret" topic={d.name} at={d.at} word="asked">
        {d.of > 1 && <span className="ad-more">+{d.of - 1} more after this</span>}
      </Head>
      <div className="ad-b">
        {d.why && <p className="ad-ask">{d.why}</p>}
        <SecretForm requestId={d.requestId} name={d.name} onRespond={onRespond} autoFocus />
      </div>
    </>
  );
}

/* ── a question the answer ended on, asked in prose (lib/askback) ── */

function ProseDock({ d, onAnswer, bind }: {
  d: Extract<Docked, { kind: "prose" }>;
  onAnswer: (text: string) => void;
  bind: (mode: AskMode | null) => void;
}) {
  const [sent, setSent] = useState<string | null>(null);
  const mode = useMemo<AskMode>(() => ({ placeholder: "Or type your own reply…" }), []);
  useEffect(() => { bind(mode); }, [mode, bind]);
  const opts = d.ask.options.map((o) => {
    const m = /^([A-D1-4]) · (.+)$/.exec(o);
    return { o, key: m?.[1], name: m?.[2] ?? o };
  });
  const reply = (o: string) => { setSent(o); onAnswer(o); };
  // ⌘1–9 reply with that option, as a click would (ui/Keys).
  const mark = useAskKeys((k) => {
    const x = opts[Number(k) - 1];
    if (sent !== null || !x) return false;
    reply(x.o);
    return true;
  });
  return (
    <>
      <Head icon={<MessageCircleQuestion size={13} strokeWidth={2.2} />} kind="Asked in the answer" at={d.at} word="asked" line={splitAsk(d.ask.question).ask.replace(/[*_`#>]/g, "")} />
      <div className="ad-b">
        <div className="ad-ask"><Markdown>{d.ask.question}</Markdown></div>
        <div className="ad-replies">
          <span ref={mark} data-ask-keys hidden />
          {opts.map((x, i) => (
            <button key={x.o} type="button" className="ad-reply" data-key={x.key ? "" : undefined} disabled={sent !== null} aria-pressed={sent === x.o}
              title={x.o === "No" ? "Drop the question — nothing runs" : `Reply "${x.o}"`} onClick={() => reply(x.o)}>
              {x.key && <Key k={x.key} />}{x.name}
              {i < 9 && <Keys k={`Ctrl+${i + 1}`} hover />}
            </button>
          ))}
          {!d.ask.options.includes("No") && (
            <button type="button" className="ad-reply" data-quiet="" disabled={sent !== null} title="Drop the question — nothing runs" onClick={() => reply("No")}>
              <Ban size={12} aria-hidden />Dismiss
            </button>
          )}
        </div>
      </div>
    </>
  );
}

/* ── in the transcript ── */

/** Where a docked ask was asked. */
export function AskMarker({ kind, topic }: { kind: "question" | "permission" | "plan" | "prose" | "secret"; topic: string }) {
  const icon = kind === "secret" ? <KeyRound size={12} strokeWidth={2.2} /> : kind === "permission" ? <SquareTerminal size={12} strokeWidth={2.2} /> : kind === "plan" ? <ListChecks size={12} strokeWidth={2.2} />
    : kind === "prose" ? <MessageCircleQuestion size={12} strokeWidth={2.2} /> : <CircleQuestionMark size={12} strokeWidth={2.2} />;
  const word = kind === "secret" ? "Secret" : kind === "permission" ? "Permission" : kind === "plan" ? "Plan" : kind === "prose" ? "Asked" : "Question";
  return (
    <div className="ask-mark" data-kind={kind}>
      <span className="ad-g" aria-hidden>{icon}</span>
      <span className="ad-kind">{word}</span>
      <b className="ask-mark-t">{topic}</b>
      <span className="ask-mark-w">waiting on you at the prompt box</span>
      <button type="button" className="ask-mark-go" onClick={() => window.dispatchEvent(new Event("ask:focus"))}>
        answer below <ArrowDown size={12} strokeWidth={2.4} aria-hidden />
      </button>
    </div>
  );
}

/** An answered question read back: every option, yours lit, the skipped ones as
 *  readable as when they were asked — pictures open and page, nothing picks. */
function RecordQuestion({ q, given, task }: { q: Question; given?: AnswerSelection; task: boolean }) {
  const chosen = given?.labels ?? [];
  const texts = previewTexts(q);
  return (
    <div className="ad-b">
      {task ? <TaskQuestion text={q.question} /> : <AskText text={q.question} />}
      {staged(q)
        ? <Pictures q={q} chosen={chosen} onPick={() => {}} sending={false} readOnly />
        : (
          <div className="ad-rows">
            {q.options.map((o, i) => {
              const k = optionKey(o.label, i);
              const on = chosen.includes(o.label);
              return (
                <div key={o.label} className="ad-row" aria-pressed={on} data-ro="" data-multi={q.multiSelect ? "" : undefined}>
                  <Key k={k.key} on={on} />
                  <span className="ad-lab">{task ? taskLabel(o.label) : k.name}{k.rec && <span className="ad-sug">Recommended</span>}</span>
                  {o.description && <span className="ad-desc">{o.description}</span>}
                </div>
              );
            })}
          </div>
        )}
      {texts && <TextPreview q={q} texts={texts} picked={chosen[0]} />}
      {given?.notes && <p className="ad-hint">Your words: “{given.notes}”</p>}
    </div>
  );
}

/** What an answered (or never answered) card leaves: one header (its state, how
 *  many questions, when) and a chip per question with your pick. A chip opens
 *  just that question read-only — every option, the ones you skipped and their
 *  pictures included; a permission keeps its one line and ▸. */
export function AskRecord(p:
  | { kind: "question"; questions: Question[]; answered?: AnswerSelection[]; stale?: boolean; at?: number }
  | { kind: "permission"; tool: string; summary: string; detail?: string; resolved?: "allow" | "deny"; stale?: boolean; at?: number }) {
  const [open, setOpen] = useState(false);
  const [shown, setShown] = useState<number | null>(null);
  const h12 = useClock12();
  if (p.kind === "question") {
    const task = isTask(p.questions);
    const rows = p.questions.map((q, qi) => {
      const given = p.answered?.[qi]?.header === q.header ? p.answered[qi] : p.answered?.find((x) => x.header === q.header);
      const names = (given?.labels ?? []).map((l) => optionKey(l, q.options.findIndex((o) => o.label === l)));
      return { q, given, names, rec: names.some((n) => n.rec) };
    });
    const state = p.answered ? "ok" : p.stale ? "gone" : "open";
    const count = p.questions.length;
    const one = shown === null ? null : rows[shown];
    return (
      <div className="ask-rec" data-state={state}>
        <div className="ask-rec-row">
          <span className="ask-rec-ic" aria-hidden>{state === "ok" ? <Check size={12} strokeWidth={3} /> : state === "gone" ? <Ban size={12} strokeWidth={2.4} /> : <CircleQuestionMark size={12} />}</span>
          <span className="ask-rec-k">{state === "ok" ? "Answered" : state === "gone" ? "Never answered" : "Asked"}</span>
          {(state === "gone" || count > 1) && <span className="ask-rec-n">{state === "gone" ? "the run ended first" : `${count} questions`}</span>}
          {p.at ? <span className="ask-rec-at">{clock(p.at, h12)}</span> : null}
        </div>
        <div className="ask-rec-chips">
          {rows.map(({ q, given, names, rec }, qi) => (
            <button key={qi} type="button" className="ask-rec-chip" aria-expanded={shown === qi}
              onClick={() => setShown((s) => (s === qi ? null : qi))}
              title={shown === qi ? "Fold it" : "Open the question: every option, the skipped ones too"}>
              <span className="ask-rec-tp">{task ? "Task" : q.header}</span>
              {state !== "gone" && (
                <span className="ask-rec-v">
                  {names.length ? names.map((n) => n.name).join(", ") : given?.notes ? <q>{given.notes}</q> : <i>no pick</i>}
                </span>
              )}
              {rec && <span className="ask-rec-dot" role="img" aria-label="Suggested" title="Suggested" />}
              {given?.notes && names.length > 0 && <span className="ask-rec-note" title={given.notes}>+ note</span>}
            </button>
          ))}
        </div>
        {one && (
          <div className="ask-rec-body">
            <RecordQuestion q={one.q} given={one.given} task={task} />
          </div>
        )}
      </div>
    );
  }
  const toggle = (
    <button type="button" className="ask-rec-open" aria-expanded={open} onClick={() => setOpen((o) => !o)}
      title={open ? "Fold it" : "Show what it asked"}>
      {p.at ? clock(p.at, h12) : ""}<ChevronRight size={13} strokeWidth={2.2} aria-hidden className="ask-rec-car" />
    </button>
  );
  const state = p.resolved === "allow" ? "ok" : p.resolved === "deny" ? "no" : p.stale ? "gone" : "open";
  const plan = p.tool === "ExitPlanMode";
  const word = state === "ok" ? (plan ? "Approved" : "Allowed") : state === "no" ? (plan ? "Kept planning" : "Denied") : state === "gone" ? "Never answered" : "Permission";
  const mcp = p.tool.startsWith("mcp__") ? mcpParts(p.tool) : null;
  return (
    <div className="ask-rec" data-state={state} data-open={open ? "" : undefined}>
      <div className="ask-rec-row">
        <span className="ask-rec-ic" aria-hidden>{state === "ok" ? <Check size={12} strokeWidth={3} /> : state === "no" ? <X size={12} strokeWidth={3} /> : <Ban size={12} strokeWidth={2.4} />}</span>
        <span className="ask-rec-k">{word}</span>
        <span className="ask-rec-tp">{plan ? "Plan" : mcp ? mcp.server : p.tool}</span>
        <span className="ask-rec-ar" aria-hidden>›</span>
        <span className="ask-rec-v" data-mono={plan ? undefined : ""}>{plan ? (p.summary.replace(/^#+\s*/, "").split("\n")[0] || "the plan") : mcp ? mcp.tool : p.summary}</span>
        {toggle}
      </div>
      {open && (
        <div className="ask-rec-body">
          {plan ? <div className="ad-plan"><Markdown>{p.detail ?? p.summary}</Markdown></div>
            : <pre className="ad-cmd">{p.detail ?? p.summary}</pre>}
        </div>
      )}
    </div>
  );
}
