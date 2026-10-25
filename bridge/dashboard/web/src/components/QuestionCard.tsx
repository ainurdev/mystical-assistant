import { useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { Check, Maximize2 } from "lucide-react";
import { Button, Card, Spinner } from "./ui";
import { api, type AnswerSelection, type Question } from "../api";
import { ImageLightbox } from "./ImageLightbox";
import { frameOf, optionKey, parsePreview, previewTexts, staged } from "../lib/qpreview";
import { clearDraft, readDraft, saveDraft } from "../lib/questionDraft";
import { RivendellIcon } from "../lib/rivendellicon";

/* The Rivendell note's push question (header "Task",
   docs/superpowers/specs/rivendell-task-check.md) wears the board's mark, the
   work line the question carries on a ⎇ line, keys as chips, and the
   suggestion (the option the note marks "(Recommended)") picked before you
   touch anything. Display only: the labels go back exactly as asked, because
   the bridge reads the answer (taskcheck.answer_state). The Mini App and
   Telegram show it as a plain card. */
export const REC = /\s*\(Recommended\)\s*$/i;
export const KEYS = /(\b[A-Z][A-Z0-9]{1,9}-\d+\b)/;
export const isTask = (qs: Question[]) => qs.length === 1 && qs[0].header.trim().toLowerCase() === "task";
const chips = (text: string, re: RegExp, cls: string) =>
  text.split(re).map((p, i) => (i % 2 ? <span key={i} className={cls}>{p}</span> : p));

export function TaskQuestion({ text }: { text: string }) {
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  const work = lines.find((l) => l.startsWith("⎇"));
  return (
    <div className="tc-q">
      <span className="tc-mark"><RivendellIcon size={16} strokeWidth={1.9} /></span>
      <div className="min-w-0">
        <div className="text-sm font-medium">{lines.filter((l) => l !== work).join(" ")}</div>
        {work && (
          <div className="tc-work">
            {work.split(/((?<=\s)\+\d+|(?<=\s)[−-]\d+)/).map((p, i) =>
              i % 2 ? <span key={i} className={p.startsWith("+") ? "add" : "del"}>{p}</span> : p)}
          </div>
        )}
      </div>
    </div>
  );
}

export const taskLabel = (label: string, suggest = false) => (
  <>
    {suggest && REC.test(label) && <span className="tc-sug">SUGGESTED</span>}
    {chips(label.replace(REC, ""), KEYS, "tc-key")}
  </>
);

/** What the send button does, said: the card comes at the push, or earlier
 *  when you asked for it from the task tab. */
export function taskVerb(q: Question, picked?: string): string | null {
  if (!picked) return null;
  const push = /\bpush/i.test(q.question);
  const key = picked.match(KEYS)?.[1];
  if (/^create\b/i.test(picked)) return push ? "Create task & push" : "Create task";
  if (/^it[’']?s\b/i.test(picked) && key) return push ? `Link ${key} & push` : `Link ${key}`;
  if (/^not a task/i.test(picked)) return push ? "Push without a task" : "Not a task";
  return null;
}

/** A question whose options carry pictures (their `preview`, lib/qpreview): the
 *  options down the left and the shown one's shots on a stage beside them, the
 *  CLI terminal's own preview layout. Chosen over side-by-side tiles because a
 *  design direction usually brings several shots
 *  (.mystical/design-drafts/picture-choices). The tabs page the shown option's
 *  shots and keep their place when you switch options, so A·2 → B·2 compares one
 *  state across them. A narrow card stacks it, stage first (index.css .qstage).
 *  Only an option with pictures takes the stage: picking Revise or Park it leaves
 *  the last pictures up, never a "No picture" box, and every shot draws at one
 *  scale in one frame (lib/qpreview frameOf), as in the dock's Pictures.
 *  Without `onPick` it is the answered record: rows still switch the stage. */
function Stage({ q, chosen, onPick, sending }: {
  q: Question;
  chosen: string[];
  onPick?: (label: string) => void;
  sending?: boolean;
}) {
  const opts = q.options.map((o, i) => ({ o, ...optionKey(o.label, i), pv: parsePreview(o.preview) }));
  const has = (x: (typeof opts)[number]) => x.pv.shots.length > 0 || x.pv.text !== "";
  const at = opts.findIndex((x) => chosen.includes(x.o.label) && has(x));
  const [shown, setShown] = useState(at >= 0 ? at : Math.max(0, opts.findIndex(has)));
  const [tab, setTab] = useState(0);
  const [zoom, setZoom] = useState<number | null>(null);
  const [gone, setGone] = useState<Set<string>>(() => new Set());
  const [dims, setDims] = useState<Record<string, [number, number]>>({});
  const [W, H] = frameOf(opts.flatMap((x) => x.pv.shots).filter((s) => !gone.has(s.path)).map((s) => dims[s.path]));
  const cur = opts[shown] ?? opts[0];
  const t = Math.min(tab, Math.max(cur.pv.shots.length - 1, 0));
  const shot = cur.pv.shots[t];
  // Every option's shots in order (A1 A2 B1 …), named, for the viewer.
  const all = opts.flatMap((x, oi) => x.pv.shots.map((s, k) => ({
    oi, k, src: api.attachmentUrl(s.path), tag: x.key,
    name: [`${x.key} · ${x.name}`, x.pv.shots.length > 1 ? `${k + 1}/${x.pv.shots.length}` : "", s.alt].filter(Boolean).join(" · "),
  })));
  const open = () => setZoom(all.findIndex((a) => a.oi === shown && a.k === t));
  const pick = (oi: number) => { if (has(opts[oi])) setShown(oi); onPick?.(opts[oi].o.label); };
  return (
    <div className="qstage-wrap">
      <div className="qstage">
        <div className="qstage-list">
          {opts.map((x, oi) => {
            const on = chosen.includes(x.o.label);
            return (
              <button
                key={x.o.label}
                type="button"
                disabled={sending}
                onClick={() => (onPick ? pick(oi) : has(x) && setShown(oi))}
                aria-pressed={on}
                className={`qopt${on ? " qopt-on" : ""} rounded-lg px-3 py-2 text-left text-sm active:opacity-70 ${
                  on ? "bg-[var(--tg-button)] text-[var(--tg-button-text)]"
                     : `bg-[var(--tg-bg)]${onPick ? "" : " opacity-60"}`
                }${oi === shown && !on ? " qopt-shown" : ""}`}
              >
                <span className="flex min-w-0 items-center gap-2 font-medium">
                  <span className={`qkey rounded-md${on ? " qkey-on" : ""}`}>{on ? <Check size={12} strokeWidth={3} aria-hidden /> : x.key}</span>
                  <span className="min-w-0 truncate">{x.name}</span>
                  {on && !onPick ? <span className="qsug rounded-full">YOUR PICK</span> : x.rec && <span className="qsug rounded-full">SUGGESTED</span>}
                </span>
                {x.o.description && (
                  <span className={`mt-0.5 block text-xs ${on ? "opacity-80" : "text-[var(--tg-hint)]"}`}>{x.o.description}</span>
                )}
              </button>
            );
          })}
        </div>
        <div className="qstage-view rounded-lg">
          <div className="qstage-head">
            <span className="qkey qkey-on rounded-md">{cur.key}</span>
            <b className="min-w-0 truncate">{cur.name}</b>
            {cur.pv.shots.length > 1 && (
              <span className="qstage-tabs" role="tablist" aria-label={`${cur.name} shots`}>
                {cur.pv.shots.map((s, k) => (
                  <button key={k} type="button" role="tab" aria-selected={k === t} onClick={() => setTab(k)} className="qstage-tab rounded-full">
                    <i>{k + 1}</i>{s.alt || `Shot ${k + 1}`}
                  </button>
                ))}
              </span>
            )}
            {shot && (
              <button type="button" title="Open full size" aria-label="Open full size" onClick={open}
                className={`qstage-zoom rounded-md${cur.pv.shots.length > 1 ? "" : " ml-auto"}`}>
                <Maximize2 size={11} aria-hidden />
              </button>
            )}
          </div>
          {/* Every pictured option's every shot sits stacked in one frame, the
              question's largest shot, and the shown one fades in: switching
              options or tabs never resizes the card or zooms the picture, and
              nothing waits on a load you asked for — they all loaded with the card. */}
          <div className="qstage-shots" style={{ "--W": W, "--H": H } as React.CSSProperties}>
            {opts.flatMap((x, oi) => !has(x) ? [] : (x.pv.shots.length ? x.pv.shots : [null]).map((s, k) => (
              <div key={`${oi}.${k}`} className="qstage-layer" data-on={oi === shown && k === t}
                style={{ "--w": (s && dims[s.path]?.[0]) || W } as React.CSSProperties}>
                {s ? (gone.has(s.path)
                  ? <p className="qstage-text">{s.alt || "This picture is gone."}</p>
                  : (
                    <button type="button" className="qstage-pic" title="Open full size" onClick={open}>
                      <img src={api.attachmentUrl(s.path)} alt={`${x.key} · ${x.name}${s.alt ? ` · ${s.alt}` : ""}`}
                        onLoad={(e) => { const im = e.currentTarget; setDims((d) => ({ ...d, [s.path]: [im.naturalWidth, im.naturalHeight] })); }}
                        onError={() => setGone((g) => new Set(g).add(s.path))} />
                    </button>
                  ))
                  : <pre className="qstage-text">{x.pv.text}</pre>}
              </div>
            )))}
          </div>
        </div>
      </div>
      {zoom !== null && all[zoom] && (
        <ImageLightbox
          src={all[zoom].src}
          all={all}
          onClose={() => setZoom(null)}
          action={onPick ? (i) => {
            const a = all[i];
            return a ? { label: `PICK ${opts[a.oi].key}`, onClick: () => { pick(a.oi); setTab(a.k); setZoom(null); } } : null;
          } : undefined}
        />
      )}
    </div>
  );
}

/** Options whose previews are text alone (lib/qpreview previewTexts): the rows
 *  stay rows, and this one panel under them shows the picked option's preview,
 *  else the suggested one's, else the first there is
 *  (.mystical/design-drafts/task-flow). Every option's text sits stacked in the
 *  panel's one cell and only the shown one is visible, so switching options
 *  never resizes the card. The prompt-box dock and its records use it too. */
export function TextPreview({ q, texts, picked }: { q: Question; texts: string[]; picked?: string }) {
  const at = q.options.findIndex((o) => o.label === picked);
  const rec = q.options.findIndex((o, i) => texts[i] && REC.test(o.label));
  const shown = at >= 0 ? at : rec >= 0 ? rec : texts.findIndex(Boolean);
  return (
    <div className="qpv">
      {q.options.map((o, i) => {
        const k = optionKey(o.label, i);
        return (
          <div key={o.label} className="qpv-layer" data-on={i === shown ? "" : undefined} aria-hidden={i !== shown}>
            <div className="qpv-head"><span className="qpv-key">{k.key}</span><b>{k.name}</b><em>PREVIEW</em></div>
            {texts[i] ? <pre className="qpv-pre">{texts[i]}</pre> : <p className="qpv-none">No preview for this option.</p>}
          </div>
        );
      })}
    </div>
  );
}

// Mirrors bridge/miniapp/web/src/components/QuestionCard.tsx (shared design):
// full-width option rows with descriptions, not cramped wrapping chips.
// Live only: once answered (or never answered) a question is drawn as AskDock's
// AskRecord, and where the prompt box can take it, it docks there instead (AskDock).
export function QuestionCard({
  questions,
  requestId,
  onSubmit,
}: {
  questions: Question[];
  requestId: string;
  /** Resolves when the answer has reached the bridge; `false` means it didn't. */
  onSubmit: (answers: AnswerSelection[]) => void | Promise<boolean | void>;
}) {
  const [restored] = useState(() => readDraft(requestId));
  const task = isTask(questions);
  const [sel, setSel] = useState<Record<string, string[]>>(() => {
    const rec = task && !Object.keys(restored.sel).length && questions[0].options.find((o) => REC.test(o.label));
    return rec ? { 0: [rec.label] } : restored.sel;
  });
  const [notes, setNotes] = useState<Record<string, string>>(restored.notes);
  // The free-text fold per question. A restored note opens it by default (or the
  // draft reads as lost); your own toggling overrides that — `restored` is static.
  const [openNotes, setOpenNotes] = useState<Record<string, boolean>>({});
  const noteRefs = useRef<Record<string, HTMLTextAreaElement | null>>({});
  // The answer travels to the bridge and only comes back on the next transcript
  // poll, so without this the card sits there looking untouched — the click
  // reads as dropped and people press it again.
  const [sending, setSending] = useState(false);

  // Hold the draft while the question is still open, so leaving the session (or
  // closing the tab) doesn't cost the answers already picked; dropped once the
  // answer reaches the bridge (submit).
  useEffect(() => { saveDraft(requestId, { sel, notes }); }, [requestId, sel, notes]);

  // Picks and notes are keyed by the question's position: headers can repeat.
  function toggle(q: Question, qi: number, label: string) {
    setSel((prev) => {
      const cur = prev[qi] ?? [];
      if (q.multiSelect) {
        return {
          ...prev,
          [qi]: cur.includes(label)
            ? cur.filter((l) => l !== label)
            : [...cur, label],
        };
      }
      return { ...prev, [qi]: [label] };
    });
  }

  // The options are Claude's guesses; when none fits, free text counts as the answer.
  const ready = questions.every(
    (_, qi) => (sel[qi]?.length ?? 0) > 0 || (notes[qi] ?? "").trim() !== "",
  );
  const multi = questions.some((q) => q.multiSelect);
  // One staged question: the button names what goes back ("Send · B HEADER").
  const solo = questions.length === 1 && staged(questions[0]) && sel[0]?.[0];
  const soloIx = solo ? questions[0].options.findIndex((o) => o.label === solo) : -1;
  const soloKey = soloIx >= 0 ? optionKey(questions[0].options[soloIx].label, soloIx) : null;

  async function submit() {
    if (sending) return;
    setSending(true);
    const ok = await onSubmit(
      questions.map((q, qi) => ({
        header: q.header,
        labels: sel[qi] ?? [],
        notes: (notes[qi] ?? "").trim() || undefined,
      })),
    );
    // Delivered: stay disabled until the poll swaps in the answered record. Failed:
    // hand the button back rather than stranding them on a dead spinner.
    if (ok === false) setSending(false);
    else clearDraft(requestId);
  }

  return (
    <Card className={`chatcard qcard qcard-live${task ? " tcard" : ""} space-y-3 border border-[var(--tg-button)]/30`}>
      {questions.map((q, qi) => {
        const open = openNotes[qi] ?? (restored.notes[qi] ?? "") !== "";
        // Typed text counts as the answer (see `ready`), so the frame says so.
        const frame = (notes[qi] ?? "").trim()
          ? "border-[var(--tg-button)]"
          : "border-[var(--tg-hint)]/40";
        const texts = previewTexts(q);
        return (
        <div key={qi} className="space-y-1.5">
          {task ? <TaskQuestion text={q.question} /> : <div className="text-sm font-medium">{q.question}</div>}
          <div className="flex flex-col gap-1.5">
            {staged(q) && <Stage q={q} chosen={sel[qi] ?? []} onPick={(l) => toggle(q, qi, l)} sending={sending} />}
            {!staged(q) && q.options.map((o) => {
              const picked = (sel[qi] ?? []).includes(o.label);
              return (
                <button
                  key={o.label}
                  onClick={() => toggle(q, qi, o.label)}
                  disabled={sending}
                  className={`qopt${picked ? " qopt-on" : ""} rounded-lg px-3 py-2 text-left text-sm active:opacity-70 ${
                    picked
                      ? "bg-[var(--tg-button)] text-[var(--tg-button-text)]"
                      : "bg-[var(--tg-bg)]"
                  }`}
                >
                  <div className="font-medium">{task ? taskLabel(o.label, true) : o.label}</div>
                  {o.description && (
                    <div
                      className={`text-xs ${picked ? "opacity-80" : "text-[var(--tg-hint)]"}`}
                    >
                      {o.description}
                    </div>
                  )}
                </button>
              );
            })}
            {texts && <TextPreview q={q} texts={texts} picked={sel[qi]?.[0]} />}
            {/* The free-text escape hatch rides *inside* the option list at option
                weight: as a footnote under the buttons it got scrolled straight past.
                Not a <details>: its content is display:none while closed, so it can
                only snap open. A 0fr→1fr grid row transitions everywhere, and a
                button's click handler can focus the textarea synchronously — which is
                what lets phones raise the keyboard on that same tap. */}
            <div className={`overflow-hidden rounded-lg border border-dashed ${frame}`}>
              <button
                type="button"
                aria-expanded={open}
                disabled={sending}
                onClick={() => {
                  // flushSync: the textarea is inert while closed, so the open render
                  // has to commit before focus() — and focus has to stay inside this
                  // tap's task or iOS won't raise the keyboard.
                  flushSync(() => setOpenNotes((prev) => ({ ...prev, [qi]: !open })));
                  if (!open) noteRefs.current[qi]?.focus({ preventScroll: true });
                }}
                className="w-full px-3 py-2 text-left text-sm active:opacity-70"
              >
                <span className="flex items-center gap-2 font-medium">
                  <span
                    className={`shrink-0 text-[10px] transition-transform motion-reduce:transition-none ${open ? "rotate-90" : ""}`}
                  >
                    ▶
                  </span>
                  None of these
                </span>
                <span className="block pl-[18px] text-xs text-[var(--tg-hint)]">
                  Answer in your own words
                </span>
              </button>
              <div
                className={`grid transition-[grid-template-rows] duration-200 ease-out motion-reduce:transition-none ${
                  open ? "grid-rows-[1fr]" : "grid-rows-[0fr]"
                }`}
              >
                <div className="min-h-0 overflow-hidden" inert={!open}>
                  <textarea
                    ref={(el) => { noteRefs.current[qi] = el; }}
                    rows={2}
                    value={notes[qi] ?? ""}
                    onChange={(e) => setNotes((prev) => ({ ...prev, [qi]: e.target.value }))}
                    // Enter sends (same as the composer); shift+Enter for a newline.
                    onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && ready && !sending) { e.preventDefault(); void submit(); } }}
                    placeholder="Your own answer, or extra context for this question"
                    className={`block w-full resize-y border-t border-dashed bg-[var(--tg-bg)] px-3 py-2 text-sm outline-none ${frame}`}
                  />
                </div>
              </div>
            </div>
          </div>
        </div>
        );
      })}
      <Button className="w-full" disabled={!ready || sending} onClick={() => void submit()}>
        {sending ? (
          <span className="inline-flex items-center gap-1.5">
            <Spinner className="h-3 w-3 border" /> Sending…
          </span>
        ) : (task && taskVerb(questions[0], sel[0]?.[0]))
          || (soloKey ? `Send · ${soloKey.key} ${soloKey.name}` : multi ? "Submit" : "Send answer")}
      </Button>
    </Card>
  );
}
