import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  ArrowDown, Ban, Check, ChevronLeft, ChevronRight, CircleQuestionMark, ListChecks, Maximize2, MessageCircleQuestion,
  Minimize2, Plug, SquareTerminal, X,
} from "lucide-react";
import { api, type AnswerSelection, type Question } from "../api";
import { splitAsk, waited, type Docked } from "../lib/askdock";
import { optionKey, parsePreview, previewTexts, staged } from "../lib/qpreview";
import { clearDraft, readDraft, saveDraft } from "../lib/questionDraft";
import { hhmm as clock, useClock12 } from "../lib/surfaces";
import { mcpParts } from "../lib/tools";
import { ImageLightbox } from "./ImageLightbox";
import { Markdown } from "./Markdown";
import { REC, TaskQuestion, TextPreview, isTask, taskLabel, taskVerb } from "./QuestionCard";
import { Spinner } from "./ui";

/* Every card that waits on you, docked on the prompt box
   (.mystical/design-drafts/response-cards, C · DOCK — the user's pick over an
   in-place card and a louder in-place one). The ask sits where your hands
   already are and never scrolls away; the transcript keeps a marker where it
   was asked (AskMarker) and, once it's answered, a one-line record that opens
   back into the full card (AskRecord) — every option, the skipped ones too.

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
}

type Respond = (requestId: string, opts: { behavior?: "allow" | "deny"; answers?: AnswerSelection[]; message?: string })
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

function Head({ icon, kind, topic, children, at, word }: {
  icon: ReactNode; kind: string; topic?: string; children?: ReactNode; at?: number; word?: string;
}) {
  return (
    <div className="ad-h">
      <span className="ad-g" aria-hidden>{icon}</span>
      <span className="ad-kind">{kind}</span>
      {topic && <span className="ad-topic">· {topic}</span>}
      {children}
      <Wait at={at} word={word} />
    </div>
  );
}

/** Context, then the ask. Context is folded to two lines; a click opens it. */
function AskText({ text }: { text: string }) {
  const s = splitAsk(text);
  const [open, setOpen] = useState(false);
  return (
    <>
      <p className="ad-ask">{s.ask}</p>
      {s.tail && <p className="ad-tail">{s.tail}</p>}
      {s.ctx && (
        <button type="button" className="ad-ctx" data-open={open ? "" : undefined} onClick={() => setOpen((o) => !o)}
          title={open ? "Fold the context" : "Show all of it"}>
          <b>Context ›</b> {s.ctx}
        </button>
      )}
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
  // A marker's "answer below" lands here: flash the dock, focus the box.
  const [flash, setFlash] = useState(0);
  useEffect(() => {
    const f = () => setFlash((n) => n + 1);
    window.addEventListener("ask:focus", f);
    return () => window.removeEventListener("ask:focus", f);
  }, []);
  useEffect(() => () => bind(null), [bind]);
  const key = d.kind === "prose" ? d.turnId : d.requestId;
  return (
    <div className="askdock" data-kind={d.kind} data-flash={flash % 2 ? "a" : flash ? "b" : undefined}>
      {d.kind === "question"
        ? <QuestionDock key={key} d={d} draft={draft} setDraft={setDraft} onRespond={onRespond} bind={bind} />
        : d.kind === "permission"
          ? <PermissionDock key={key} d={d} draft={draft} setDraft={setDraft} onRespond={onRespond} onSteer={onSteer} bind={bind} />
          : <ProseDock key={key} d={d} onAnswer={onAnswer} bind={bind} />}
      {stashed && <p className="ad-note">Your draft is set aside: it comes back after you answer.</p>}
    </div>
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
    return {
      placeholder: picked.length ? "Add a note, or just send…" : "Or type your own answer…",
      label,
      ready: !sending && (state === "all" || /^(next:|one:|many:|verb:)/.test(state) || (state === "next" && picked.length > 0)),
      send: (t: string) => { void sendRef.current(t); },
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, picked.length > 0]);
  useEffect(() => { bind(mode); }, [mode, bind]);

  const pics = staged(q);
  const texts = previewTexts(q);
  return (
    <>
      <Head icon={<CircleQuestionMark size={13} strokeWidth={2.2} />} kind={qs.length > 1 ? "Questions" : "Question"}
        topic={qs.length > 1 ? `${page + 1} of ${qs.length}` : task ? "Rivendell task" : q.header} at={d.at}>
        {d.of > 1 && <span className="ad-more">+{d.of - 1} more after this</span>}
      </Head>
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
      <div className="ad-b" key={page}>
        {task ? <TaskQuestion text={q.question} /> : <AskText text={q.question} />}
        {pics
          ? <Pictures q={q} chosen={picked} onPick={toggle} sending={sending} />
          : (
            <div className="ad-rows" style={{ "--n": q.options.length === 4 ? 2 : Math.min(q.options.length, 3) } as React.CSSProperties}
              role={q.multiSelect ? "group" : "radiogroup"} aria-label={q.header}>
              {q.options.map((o, i) => {
                const k = optionKey(o.label, i);
                const on = picked.includes(o.label);
                return (
                  <button key={o.label} type="button" className="ad-row" aria-pressed={on} disabled={sending}
                    data-multi={q.multiSelect ? "" : undefined} onClick={() => toggle(o.label)}>
                    <Key k={k.key} on={on} />
                    <span className="ad-lab">
                      {task ? taskLabel(o.label, true) : k.name}
                      {k.rec && !task && <span className="ad-sug" title="Suggested">★</span>}
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

/** A question whose options carry pictures. Tiles side by side, each showing the
 *  same shot (the tabs switch every tile at once, so one state compares across
 *  options); Bigger grows the dock into a stage for one option at a time, and
 *  every picture opens the lightbox with PICK. */
function Pictures({ q, chosen, onPick, sending, readOnly = false }: {
  q: Question; chosen: string[]; onPick: (label: string) => void; sending: boolean;
  /** The answered record: tiles open their picture and Bigger pages them; nothing is picked. */
  readOnly?: boolean;
}) {
  const opts = q.options.map((o, i) => ({ o, ...optionKey(o.label, i), pv: parsePreview(o.preview) }));
  const tabs = opts.reduce((m, x) => (x.pv.shots.length > m.length ? x.pv.shots : m), opts[0]?.pv.shots ?? []);
  const [tab, setTab] = useState(0);
  const [big, setBig] = useState(false);
  const at = opts.findIndex((x) => chosen.includes(x.o.label));
  const [shown, setShown] = useState(at >= 0 ? at : 0);
  const [zoom, setZoom] = useState<number | null>(null);
  const shotOf = (x: (typeof opts)[number]) => x.pv.shots[Math.min(tab, x.pv.shots.length - 1)];
  const all = opts.flatMap((x, oi) => x.pv.shots.map((s, k) => ({
    oi, k, src: api.attachmentUrl(s.path), tag: x.key,
    name: [`${x.key} · ${x.name}`, x.pv.shots.length > 1 ? `${k + 1}/${x.pv.shots.length}` : "", s.alt].filter(Boolean).join(" · "),
  })));
  const open = (oi: number) => {
    const s = shotOf(opts[oi]);
    const i = all.findIndex((a) => a.oi === oi && (!s || a.k === opts[oi].pv.shots.indexOf(s)));
    if (i >= 0) setZoom(i);
  };
  const cur = opts[shown] ?? opts[0];
  const curShot = shotOf(cur);
  const n = Math.min(opts.length, 4);
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
        <button type="button" className="ad-grow" onClick={() => setBig((b) => !b)} title={big ? "Back to the tiles" : "See one option large"}>
          {big ? <><Minimize2 size={11} aria-hidden /> Smaller</> : <><Maximize2 size={11} aria-hidden /> Bigger</>}
        </button>
      </div>
      {big ? (
        <>
          <div className="ad-stage">
            <div className="ad-sh">
              <Key k={cur.key} on={chosen.includes(cur.o.label)} />
              <b>{cur.name}</b>
              {curShot && <span className="ad-of">{cur.pv.shots.length > 1 ? `shot ${Math.min(tab, cur.pv.shots.length - 1) + 1} of ${cur.pv.shots.length}` : "1 shot"}{curShot.alt ? ` · ${curShot.alt}` : ""}</span>}
              {curShot && <button type="button" className="ad-full" onClick={() => open(shown)}><Maximize2 size={11} aria-hidden /> Full size</button>}
            </div>
            <div className="ad-pic">
              {curShot
                ? <button type="button" className="ad-img" onClick={() => open(shown)} title="Open full size"><img src={api.attachmentUrl(curShot.path)} alt={`${cur.key} · ${cur.name}`} /></button>
                : <pre className="ad-pre">{cur.pv.text || "No picture for this option"}</pre>}
              {opts.length > 1 && <>
                <button type="button" className="ad-nav" data-side="l" aria-label="Previous option" onClick={() => setShown((shown + opts.length - 1) % opts.length)}><ChevronLeft size={16} strokeWidth={2.4} /></button>
                <button type="button" className="ad-nav" data-side="r" aria-label="Next option" onClick={() => setShown((shown + 1) % opts.length)}><ChevronRight size={16} strokeWidth={2.4} /></button>
              </>}
            </div>
          </div>
          <div className="ad-strip">
            {opts.map((x, oi) => (
              <button key={x.o.label} type="button" className="ad-chip" aria-pressed={chosen.includes(x.o.label)} data-shown={oi === shown ? "" : undefined}
                disabled={sending} onClick={() => { setShown(oi); if (!readOnly) onPick(x.o.label); }}>
                <Key k={x.key} on={chosen.includes(x.o.label)} />{x.name}{x.rec && <span className="ad-sug" title="Suggested">★</span>}
                {x.pv.shots.length > 0 && <small>{x.pv.shots.length === 1 ? "1 shot" : `${x.pv.shots.length} shots`}</small>}
              </button>
            ))}
          </div>
        </>
      ) : (
        <div className="ad-pics" style={{ "--n": n } as React.CSSProperties}>
          {opts.map((x, oi) => {
            const s = shotOf(x);
            const on = chosen.includes(x.o.label);
            return (
              <div key={x.o.label} className="ad-tile" data-on={on ? "" : undefined}>
                <button type="button" className="ad-tilebtn" aria-pressed={on} disabled={sending}
                  onClick={() => { setShown(oi); if (readOnly) open(oi); else onPick(x.o.label); }}>
                  <span className="ad-th">
                    {s ? <img src={api.attachmentUrl(s.path)} alt={`${x.key} · ${x.name}${s.alt ? ` · ${s.alt}` : ""}`} loading="lazy" />
                      : <pre className="ad-pre">{x.pv.text || "No picture"}</pre>}
                  </span>
                  <span className="ad-meta">
                    <Key k={x.key} on={on} />
                    <span className="ad-lab">{x.name}{x.rec && <span className="ad-sug" title="Suggested">★</span>}</span>
                    {x.o.description && <span className="ad-desc">{x.o.description}</span>}
                  </span>
                </button>
                {s && (
                  <button type="button" className="ad-zm" title="Open full size" aria-label={`Open ${x.name} full size`} onClick={() => open(oi)}>
                    <Maximize2 size={11} aria-hidden />
                  </button>
                )}
              </div>
            );
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
            return a ? { label: `PICK ${opts[a.oi].key}`, onClick: () => { onPick(opts[a.oi].o.label); setShown(a.oi); setTab(a.k); setZoom(null); } } : null;
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
  const [sending, setSending] = useState<"allow" | "deny" | null>(null);
  const [failed, setFailed] = useState(false);
  const mcp = d.tool.startsWith("mcp__") ? mcpParts(d.tool) : null;
  const plan = d.tool === "ExitPlanMode";
  const bash = d.tool === "Bash";
  async function answer(behavior: "allow" | "deny", note = "") {
    if (sending) return;
    setSending(behavior);
    setFailed(false);
    const res = await onRespond(d.requestId, note ? { behavior, message: note } : { behavior });
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

  const topic = bash ? "Bash" : plan ? "ready to build" : mcp ? `${mcp.server} · ${mcp.tool}` : d.tool;
  return (
    <>
      <Head icon={plan ? <ListChecks size={13} strokeWidth={2.2} /> : mcp ? <Plug size={13} strokeWidth={2.2} /> : <SquareTerminal size={13} strokeWidth={2.2} />}
        kind={plan ? "Plan" : "Permission"} topic={topic} at={d.at} word="asked">
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
        ) : (
          <>
            <p className="ad-ask">Allow <b>{d.tool}</b>?</p>
            {d.summary && <pre className="ad-cmd">{d.summary}</pre>}
          </>
        )}
        <div className="ad-acts">
          <button type="button" className="ad-btn" data-pri="" disabled={!!sending} onClick={() => void answer("allow")}>
            {sending === "allow" ? <Spinner className="h-3 w-3 border" /> : <Check size={13} strokeWidth={2.6} aria-hidden />}
            {plan ? "Approve & build" : "Allow"}
          </button>
          <button type="button" className="ad-btn" disabled={!!sending} onClick={() => void answer("deny", draft.trim())}>
            {sending === "deny" ? <Spinner className="h-3 w-3 border" /> : <X size={13} strokeWidth={2.6} aria-hidden />}
            {plan ? "Keep planning" : typed ? "Deny with note" : "Deny"}
          </button>
          <span className="ad-aside">{plan ? "nothing has changed yet" : "or type below to deny it and say what to do instead"}</span>
        </div>
        {failed && <p className="ad-err">That didn't reach the bridge. Try again.</p>}
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
  return (
    <>
      <Head icon={<MessageCircleQuestion size={13} strokeWidth={2.2} />} kind="Asked in the answer" at={d.at} word="asked" />
      <div className="ad-b">
        <div className="ad-ask"><Markdown>{d.ask.question}</Markdown></div>
        <div className="ad-replies">
          {opts.map((x) => (
            <button key={x.o} type="button" className="ad-reply" disabled={sent !== null} aria-pressed={sent === x.o}
              title={x.o === "No" ? "Drop the question — nothing runs" : `Reply "${x.o}"`} onClick={() => reply(x.o)}>
              {x.key && <Key k={x.key} />}{x.name}
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
export function AskMarker({ kind, topic }: { kind: "question" | "permission" | "plan" | "prose"; topic: string }) {
  const icon = kind === "permission" ? <SquareTerminal size={12} strokeWidth={2.2} /> : kind === "plan" ? <ListChecks size={12} strokeWidth={2.2} />
    : kind === "prose" ? <MessageCircleQuestion size={12} strokeWidth={2.2} /> : <CircleQuestionMark size={12} strokeWidth={2.2} />;
  const word = kind === "permission" ? "Permission" : kind === "plan" ? "Plan" : kind === "prose" ? "Asked" : "Question";
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
function RecordQuestions({ questions, answered }: { questions: Question[]; answered?: AnswerSelection[] }) {
  return (
    <div className="ask-recq">
      {questions.map((q, qi) => {
        const given = answered?.[qi]?.header === q.header ? answered[qi] : answered?.find((x) => x.header === q.header);
        const chosen = given?.labels ?? [];
        const texts = previewTexts(q);
        return (
          <div key={qi} className="ad-b">
            {questions.length > 1 && <p className="ad-tail">{qi + 1} of {questions.length} · {q.header}</p>}
            {isTask(questions) ? <TaskQuestion text={q.question} /> : <AskText text={q.question} />}
            {staged(q)
              ? <Pictures q={q} chosen={chosen} onPick={() => {}} sending={false} readOnly />
              : (
                <div className="ad-rows" style={{ "--n": q.options.length === 4 ? 2 : Math.min(q.options.length, 3) } as React.CSSProperties}>
                  {q.options.map((o, i) => {
                    const k = optionKey(o.label, i);
                    const on = chosen.includes(o.label);
                    return (
                      <div key={o.label} className="ad-row" aria-pressed={on} data-ro="" data-multi={q.multiSelect ? "" : undefined}>
                        <Key k={k.key} on={on} />
                        <span className="ad-lab">{isTask(questions) ? taskLabel(o.label) : k.name}{k.rec && <span className="ad-sug" title="Suggested">★</span>}</span>
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
      })}
    </div>
  );
}

/** What an answered (or never answered) card leaves: one line per question, and
 *  ▾ opens the whole card read-only — every option, the ones you skipped and
 *  their pictures included. */
export function AskRecord(p:
  | { kind: "question"; questions: Question[]; answered?: AnswerSelection[]; stale?: boolean; at?: number }
  | { kind: "permission"; tool: string; summary: string; detail?: string; resolved?: "allow" | "deny"; stale?: boolean; at?: number }) {
  const [open, setOpen] = useState(false);
  const h12 = useClock12();
  const toggle = (
    <button type="button" className="ask-rec-open" aria-expanded={open} onClick={() => setOpen((o) => !o)}
      title={open ? "Fold it" : p.kind === "question" ? "Open the card: every option, the skipped ones too" : "Show what it asked"}>
      {p.at ? clock(p.at, h12) : ""}<ChevronRight size={13} strokeWidth={2.2} aria-hidden className="ask-rec-car" />
    </button>
  );
  if (p.kind === "question") {
    const rows = p.questions.map((q, qi) => {
      const given = p.answered?.[qi]?.header === q.header ? p.answered[qi] : p.answered?.find((x) => x.header === q.header);
      const names = (given?.labels ?? []).map((l) => optionKey(l, q.options.findIndex((o) => o.label === l)));
      return { q, given, names, rec: names.some((n) => n.rec) };
    });
    const state = p.answered ? "ok" : p.stale ? "gone" : "open";
    return (
      <div className="ask-rec" data-state={state} data-open={open ? "" : undefined}>
        {rows.map(({ q, given, names, rec }, qi) => (
          <div key={qi} className="ask-rec-row">
            <span className="ask-rec-ic" aria-hidden>{state === "ok" ? <Check size={12} strokeWidth={3} /> : state === "gone" ? <Ban size={12} strokeWidth={2.4} /> : <CircleQuestionMark size={12} />}</span>
            <span className="ask-rec-k">{state === "gone" ? "Never answered" : p.questions.length > 1 ? "Questions" : "Question"}</span>
            <span className="ask-rec-tp">{isTask(p.questions) ? "Task" : q.header}</span>
            <span className="ask-rec-ar" aria-hidden>›</span>
            <span className="ask-rec-v">
              {state === "gone" ? <i>the run ended before you answered</i>
                : names.length ? names.map((n) => n.name).join(", ")
                : given?.notes ? <q>{given.notes}</q> : <i>no pick</i>}
            </span>
            {rec && <span className="ask-rec-tag">SUGGESTED</span>}
            {given?.notes && names.length > 0 && <span className="ask-rec-note" title={given.notes}>+ note</span>}
            {qi === 0 && toggle}
          </div>
        ))}
        {open && (
          <div className="ask-rec-body">
            <RecordQuestions questions={p.questions} answered={p.answered} />
          </div>
        )}
      </div>
    );
  }
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
