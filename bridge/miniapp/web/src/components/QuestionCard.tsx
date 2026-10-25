import { useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { Maximize2 } from "lucide-react";
import { Button, Card, Spinner } from "./ui";
import type { AnswerSelection, Question } from "../lib/api";
import { optionKey, parsePreview, previewTexts, staged } from "../lib/qpreview";
import { clearDraft, readDraft, saveDraft } from "../lib/questionDraft";
import { ImageLightbox } from "./ImageLightbox";
import { ToolImage } from "./RunStream";

/** The pictures of the option on show, above the option rows: the phone's half
 *  of the dashboard's Stage (QuestionCard.tsx there), stacked, so a tapped row
 *  swaps the picture right above it. The tabs page that option's shots and keep
 *  their place when you switch options. Its viewer has no PICK: closing it puts
 *  the rows back under your thumb. */
function StageView({ q, shown }: { q: Question; shown: number }) {
  const [tab, setTab] = useState(0);
  const [zoom, setZoom] = useState<string | null>(null);
  const [srcs, setSrcs] = useState<Record<string, string>>({});
  const opts = q.options.map((o, i) => ({ ...optionKey(o.label, i), pv: parsePreview(o.preview) }));
  const cur = opts[shown] ?? opts[0];
  const t = Math.min(tab, Math.max(cur.pv.shots.length - 1, 0));
  const shot = cur.pv.shots[t];
  return (
    <div className="border border-border bg-[var(--tg-bg)]">
      <div className="flex items-center gap-2 border-b border-border px-2.5 py-2">
        <span className="inline-flex h-[21px] w-[21px] shrink-0 items-center justify-center bg-[var(--brand-soft)] font-mono text-[11px] font-bold text-[var(--tg-bg)]">{cur.key}</span>
        <span className="min-w-0 truncate text-sm font-medium text-foreground-bright">{cur.name}</span>
        <span className="ml-auto flex min-w-0 gap-1 overflow-x-auto">
          {cur.pv.shots.length > 1 && cur.pv.shots.map((s, k) => (
            <button key={k} type="button" role="tab" aria-selected={k === t} onClick={() => setTab(k)}
              className={`shrink-0 rounded-full border px-2 py-0.5 text-[11px] ${k === t
                ? "border-[var(--brand-soft)] bg-[var(--ac-12)] text-foreground-bright" : "border-border text-[var(--tg-hint)]"}`}>
              {k + 1} {s.alt || `Shot ${k + 1}`}
            </button>
          ))}
          {shot && srcs[shot.path] && (
            <button type="button" aria-label="Open full size" onClick={() => setZoom(srcs[shot.path])}
              className="shrink-0 border border-border px-1.5 text-[var(--tg-hint)]">
              <Maximize2 size={11} aria-hidden />
            </button>
          )}
        </span>
      </div>
      {/* Every option's every shot stacked in one cell, the shown one fading in
          (the dashboard Stage's way): the cell holds the tallest, each capped in
          height, so a tap never resizes the card or waits on a fetch. */}
      <div className="grid grid-cols-[minmax(0,1fr)]">
        {opts.flatMap((x, oi) => (x.pv.shots.length ? x.pv.shots : [null]).map((s, k) => {
          const on = oi === shown && k === t;
          return (
            <div key={`${oi}.${k}`} className={`col-start-1 row-start-1 flex min-w-0 flex-col justify-center transition-[opacity,visibility] duration-150 motion-reduce:transition-none ${on ? "" : "invisible opacity-0"}`}>
              {s && (
                <ToolImage
                  path={s.path}
                  alt={`${x.key} · ${x.name}${s.alt ? ` · ${s.alt}` : ""}`}
                  className="block h-auto max-h-[min(56vh,440px)] w-full object-contain"
                  fallback={<p className="px-3 py-2 text-xs text-[var(--tg-hint)]">{s.alt || "This picture is gone."}</p>}
                  onZoom={(src) => setZoom(src)}
                  onSrc={(src) => setSrcs((m) => ({ ...m, [s.path]: src }))}
                />
              )}
              {x.pv.text && (
                <pre className="m-0 max-h-80 overflow-auto whitespace-pre-wrap px-3 py-2 font-mono text-xs text-[var(--tg-hint)]">{x.pv.text}</pre>
              )}
              {!s && !x.pv.text && <p className="px-3 py-3 text-center text-xs text-[var(--tg-hint)]">No picture for this option</p>}
            </div>
          );
        }))}
      </div>
      {zoom && (
        <ImageLightbox
          src={zoom}
          alt={`${cur.key} · ${cur.name}`}
          all={cur.pv.shots.flatMap((s) => (srcs[s.path] ? [{ src: srcs[s.path] }] : []))}
          onClose={() => setZoom(null)}
        />
      )}
    </div>
  );
}

/** Options whose previews are text alone (lib/qpreview previewTexts): the
 *  dashboard's TextPreview (QuestionCard.tsx there). One panel under the rows
 *  with the picked option's preview, else the suggested one's, else the first;
 *  every option's text stacked in one cell, so a tap never resizes the card. */
function TextPreview({ q, texts, picked }: { q: Question; texts: string[]; picked?: string }) {
  const at = q.options.findIndex((o) => o.label === picked);
  const rec = q.options.findIndex((o, i) => texts[i] && optionKey(o.label, i).rec);
  const shown = at >= 0 ? at : rec >= 0 ? rec : texts.findIndex(Boolean);
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] border border-border bg-[var(--tg-bg)]">
      {q.options.map((o, i) => {
        const k = optionKey(o.label, i);
        return (
          <div key={o.label} aria-hidden={i !== shown} className={`col-start-1 row-start-1 flex min-w-0 flex-col ${i === shown ? "" : "invisible"}`}>
            <div className="flex items-center gap-2 border-b border-border px-2.5 py-2">
              <span className="inline-flex h-[21px] w-[21px] shrink-0 items-center justify-center bg-[var(--brand-soft)] font-mono text-[11px] font-bold text-[var(--tg-bg)]">{k.key}</span>
              <span className="min-w-0 truncate text-sm font-medium text-foreground-bright">{k.name}</span>
              <span className="ml-auto shrink-0 text-[9.5px] tracking-[1.5px] text-[var(--tg-hint)]">PREVIEW</span>
            </div>
            {texts[i]
              ? <pre className="m-0 max-h-60 overflow-auto whitespace-pre-wrap px-3 py-2 font-mono text-xs text-[var(--tg-hint)]">{texts[i]}</pre>
              : <p className="px-3 py-3 text-xs text-[var(--tg-hint)]">No preview for this option.</p>}
          </div>
        );
      })}
    </div>
  );
}

export function QuestionCard({
  questions,
  requestId,
  active,
  answered,
  stale,
  onSubmit,
}: {
  questions: Question[];
  requestId: string;
  active: boolean;
  answered?: AnswerSelection[];
  /** Asked, never answered, and the run has since ended (see PermissionCard). */
  stale?: boolean;
  /** Resolves when the answer has reached the bridge; `false` means it didn't. */
  onSubmit: (answers: AnswerSelection[]) => void | Promise<boolean | void>;
}) {
  const [restored] = useState(() => readDraft(requestId));
  const [sel, setSel] = useState<Record<string, string[]>>(restored.sel);
  const [notes, setNotes] = useState<Record<string, string>>(restored.notes);
  // The free-text fold per question. A restored note opens it by default (or the
  // draft reads as lost); your own toggling overrides that — `restored` is static.
  const [openNotes, setOpenNotes] = useState<Record<string, boolean>>({});
  const noteRefs = useRef<Record<string, HTMLTextAreaElement | null>>({});
  // The answer travels to the bridge and only comes back on the next transcript
  // poll, so without this the card sits there looking untouched — the click
  // reads as dropped and people press it again.
  const [sending, setSending] = useState(false);
  // Which option's pictures are on show, per staged question: the last one tapped.
  const [shownAt, setShownAt] = useState<Record<string, number>>({});

  // Hold the draft while the question is still open, so leaving the session (or
  // closing the webview) doesn't cost the answers already picked. Cleared on
  // `answered` rather than on `!active`, because a read-only render of the same
  // question — history, another surface — is inactive while the draft is live.
  useEffect(() => {
    if (answered) clearDraft(requestId);
    else if (active) saveDraft(requestId, { sel, notes });
  }, [requestId, active, answered, sel, notes]);

  if (!active) {
    // Resolved / historical: still show the prepared answers as buttons, with the
    // chosen one(s) highlighted (matches Claude Code's answered-question look).
    return (
      <Card className="chatcard space-y-3 border border-[var(--tg-button)]/30">
        {questions.map((q, qi) => {
          // Headers can repeat (one "Task" question per repo), so pair by position first.
          const given = answered?.[qi]?.header === q.header ? answered[qi] : answered?.find((x) => x.header === q.header);
          const chosen = given?.labels ?? [];
          return (
            <div key={qi} className="space-y-1.5">
              <div className="text-sm font-medium">{q.question}</div>
              {staged(q) && <StageView q={q} shown={Math.max(0, q.options.findIndex((o) => chosen.includes(o.label)))} />}
              <div className="flex flex-col gap-1.5">
                {q.options.map((o) => {
                  const picked = chosen.includes(o.label);
                  return (
                    <div
                      key={o.label}
                      className={`rounded-lg px-3 py-2 text-left text-sm ${
                        picked
                          ? "bg-[var(--tg-button)] text-[var(--tg-button-text)]"
                          : "bg-[var(--tg-bg)] opacity-60"
                      }`}
                    >
                      <div className="font-medium">{o.label}</div>
                      {o.description && (
                        <div className={`text-xs ${picked ? "opacity-80" : "text-[var(--tg-hint)]"}`}>
                          {o.description}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
              {previewTexts(q) && <TextPreview q={q} texts={previewTexts(q)!} picked={chosen[0]} />}
              {given?.notes && (
                <div className="text-xs text-[var(--tg-hint)]">Note: {given.notes}</div>
              )}
            </div>
          );
        })}
        {stale && (
          <div className="text-xs text-amber-400">Never answered — the run ended.</div>
        )}
      </Card>
    );
  }

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
    // Delivered: stay disabled until the poll swaps in the answered card. Failed:
    // hand the button back rather than stranding them on a dead spinner.
    if (ok === false) setSending(false);
  }

  // An open question is the one thing in the transcript that is blocking you —
  // it wears the amber corner-tick frame so it reads as such at a glance.
  return (
    <div className="panel space-y-3 border border-amber-400/45 bg-[var(--card)] p-3.5">
      <div className="text-[9.5px] tracking-[2px] text-amber-400">? QUESTION // NEEDS YOU</div>
      {questions.map((q, qi) => {
        const open = openNotes[qi] ?? (restored.notes[qi] ?? "") !== "";
        // Typed text counts as the answer (see `ready`), so the frame says so.
        const frame = (notes[qi] ?? "").trim() ? "border-[var(--brand-soft)]" : "border-border";
        const stage = staged(q);
        const texts = previewTexts(q);
        const lettered = stage || !!texts;      // the stage and the text panel name options by their key
        return (
        <div key={qi} className="space-y-1.5">
          <div className="text-sm font-medium text-foreground-bright">{q.question}</div>
          {stage && (
            <StageView q={q} shown={shownAt[qi] ?? Math.max(0, q.options.findIndex((o) => (sel[qi] ?? []).includes(o.label)))} />
          )}
          <div className="flex flex-col gap-1.5">
            {q.options.map((o, i) => {
              const picked = (sel[qi] ?? []).includes(o.label);
              const k = optionKey(o.label, i);
              return (
                <button
                  key={o.label}
                  onClick={() => { toggle(q, qi, o.label); setShownAt((m) => ({ ...m, [qi]: i })); }}
                  disabled={sending}
                  className={`border px-3 py-2.5 text-left text-sm active:opacity-70 ${
                    picked
                      ? "border-[var(--brand-soft)] bg-[var(--ac-12)] text-foreground-bright"
                      : "border-border bg-[var(--tg-bg)]"
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <span
                      className={`shrink-0 text-[10px] tracking-wider ${
                        picked ? "text-[var(--brand-soft)]" : "text-[var(--tg-hint)]"
                      }`}
                    >
                      {lettered ? k.key : i + 1}
                    </span>
                    <span className="font-medium">{lettered ? k.name : o.label}</span>
                    {lettered && k.rec && <span className="ml-auto text-[9.5px] tracking-[1.5px] text-[var(--brand-soft)]">SUGGESTED</span>}
                  </div>
                  {o.description && (
                    <div className={`pl-[17px] text-xs ${picked ? "opacity-80" : "text-[var(--tg-hint)]"}`}>
                      {o.description}
                    </div>
                  )}
                </button>
              );
            })}
            {texts && <TextPreview q={q} texts={texts} picked={sel[qi]?.[0]} />}
            {/* The free-text escape hatch rides *inside* the option list at option
                weight, on the numbered gutter: as a footnote it got scrolled past.
                Not a <details>: its content is display:none while closed, so it can
                only snap open. A 0fr→1fr grid row transitions everywhere, and a
                button's click handler can focus the textarea synchronously — which is
                what lets phones raise the keyboard on that same tap. */}
            <div className={`overflow-hidden border border-dashed ${frame}`}>
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
                className="w-full px-3 py-2.5 text-left text-sm active:opacity-70"
              >
                <span className="flex items-center gap-2">
                  <span
                    className={`shrink-0 text-[10px] tracking-wider text-[var(--tg-hint)] transition-transform motion-reduce:transition-none ${open ? "rotate-90" : ""}`}
                  >
                    ▶
                  </span>
                  <span className="font-medium">None of these</span>
                </span>
                <span className="block pl-[17px] text-xs text-[var(--tg-hint)]">
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
      <Button
        className="w-full shadow-[0_0_18px_var(--brand-glow)]"
        disabled={!ready || sending}
        onClick={() => void submit()}
      >
        {sending ? (
          <span className="inline-flex items-center gap-1.5">
            <Spinner className="h-3 w-3 border" /> Sending…
          </span>
        ) : multi ? "Submit" : "Send answer"}
      </Button>
    </div>
  );
}
