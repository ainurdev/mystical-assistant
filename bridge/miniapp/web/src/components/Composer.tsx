import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Paperclip, ArrowUp, X, Sparkles, ChevronDown, Square, Minimize2 } from "lucide-react";
import { useChat } from "../lib/chat";
import { api, type EffortLevel, type ModelId } from "../lib/api";
import { isExact, rankCommands, slashQuery } from "../lib/slash";
import { Button } from "./ui";
import { Textarea } from "./ui/textarea";
import { UsageStrip } from "./UsageStrip";
import { ImageLightbox } from "./ImageLightbox";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuSeparator,
} from "./ui/dropdown-menu";

const EFFORTS: { id: EffortLevel | ""; label: string }[] = [
  { id: "", label: "Auto" },
  { id: "low", label: "Low" },
  { id: "medium", label: "Medium" },
  { id: "high", label: "High" },
  { id: "xhigh", label: "Extra high" },
  { id: "max", label: "Max" },
];

// Per-message operating mode ("" keeps the session's). These are Claude Code's
// own permission modes — the CLI's ids, in its own least-authority-first order —
// so a phone can't pick a posture `claude --permission-mode` would reject. (It
// also takes "manual", but that is only its alias for "default".) The Mini App
// has no free-agent picker, so this list is Claude's alone; the dashboard's
// composer carries opencode's shorter one.
const PERMS: { id: string; label: string }[] = [
  { id: "", label: "Session default" },
  { id: "plan", label: "Plan only" },
  { id: "default", label: "Ask each time" },
  { id: "dontAsk", label: "Never ask" },
  { id: "acceptEdits", label: "Accept edits" },
  { id: "auto", label: "Auto" },
  { id: "bypassPermissions", label: "Full autonomy" },
];

/** One setting as a wrapped row of chips — three of these fit on a phone
 *  screen at once, where three stacked radio lists meant scrolling to find
 *  the group you wanted. Picking doesn't close the menu: you're usually here
 *  to change more than one thing. */
function OptionRow({
  label,
  value,
  options,
  onPick,
}: {
  label: string;
  value: string;
  options: { id: string; label: string }[];
  onPick: (id: string) => void;
}) {
  return (
    <div className="px-1 pb-1.5">
      <div className="px-1 py-1 text-[10px] tracking-[1.5px] text-muted-foreground">{label}</div>
      <div role="radiogroup" aria-label={label} className="flex flex-wrap gap-1">
        {options.map((o) => (
          <button
            key={o.id}
            type="button"
            role="radio"
            aria-checked={o.id === value}
            onClick={() => onPick(o.id)}
            className={`rounded-lg border px-2 py-1.5 text-xs transition-colors ${
              o.id === value
                ? "border-[var(--brand-soft)] text-[var(--brand-soft)]"
                : "border-border text-foreground/70 active:opacity-70"
            }`}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}

const chipClass =
  "inline-flex items-center gap-1.5 rounded-lg border border-border bg-secondary/60 px-2.5 py-1.5 text-xs font-medium text-foreground outline-none transition-colors active:opacity-70 focus-visible:ring-2 focus-visible:ring-ring";

export function Composer() {
  const {
    draft,
    setDraft,
    draftAttachments,
    addAttachments,
    removeAttachment,
    send,
    compact,
    stop,
    isRunning,
    pending,
    model,
    setModel,
    models,
    effort,
    setEffort,
    perm,
    setPerm,
    sessionId,
  } = useChat();
  const fileRef = useRef<HTMLInputElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState<{ src: string; alt: string } | null>(null);
  const qc = useQueryClient();
  const { data: queues } = useQuery({
    queryKey: ["queues"],
    queryFn: () => api.getQueues(),
    refetchInterval: 5000,
  });
  const queued = (queues?.queues.find((q) => q.session_id === sessionId)?.items ?? []).filter(
    (i) => i.status === "queued",
  ).length;

  // This bar is fixed, so the transcript can't see how much room it takes —
  // attachments, the queue hint and a grown textarea all move it. Publish the
  // measured height; run.tsx pads by it instead of guessing.
  useEffect(() => {
    const el = barRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() =>
      document.documentElement.style.setProperty("--composer-h", `${el.offsetHeight}px`),
    );
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Grow the textarea with its content, up to ~6 rows.
  useEffect(() => {
    const el = taRef.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = `${Math.min(el.scrollHeight, 168)}px`;
  }, [draft]);

  const blocked = isRunning || pending.length > 0;
  const sendDisabled = blocked || draft.trim().length === 0;

  // --- / commands ----------------------------------------------------------
  // A draft that is just `/word` opens the command list, as the CLI's input
  // does — skills, custom commands, plugins, the CLI's bundled ones. Fetched
  // when it opens (a local scan), so a skill you just installed is in it.
  const slashQ = slashQuery(draft);
  const slashOn = slashQ !== null;
  const [slashDismissed, setSlashDismissed] = useState(false);
  useEffect(() => { if (!slashOn) setSlashDismissed(false); }, [slashOn]);
  // No retries: a bridge still running pre-restart code 404s this, and the
  // list should say so now rather than after three backoffs.
  const cmdsQ = useQuery({ queryKey: ["commands"], queryFn: () => api.getCommands(), enabled: slashOn, retry: false });
  const hits = slashQ === null ? [] : rankCommands(cmdsQ.data?.commands ?? [], slashQ);
  const slashOpen = slashOn && !slashDismissed && (hits.length > 0 || cmdsQ.isError);
  function takeSlash(name: string) {
    setDraft(`/${name} `);
    taRef.current?.focus();
  }

  // A run in flight no longer costs you the thought: the prompt goes on this
  // session's queue (bridge/queue_manager.py) and sends itself when the chat
  // frees up, instead of waiting on you to come back and press Send.
  async function queue() {
    const text = draft.trim();
    if (!text || !sessionId) return;
    try {
      await api.queueOp({
        op: "enqueue",
        session_id: sessionId,
        prompt: text,
        // A screenshot queues with its prompt — otherwise it sat in the tray
        // while the prompt that needed it ran without it.
        images: draftAttachments.map((a) => a.dataUrl ?? "").filter(Boolean),
        model,
        effort: effort || undefined,
        permission_mode: perm || undefined,
      });
      setDraft("");
      draftAttachments.forEach((a) => removeAttachment(a.id));
      void qc.invalidateQueries({ queryKey: ["queues"] });
    } catch {
      /* the poll reconciles; the draft stays put */
    }
  }
  // "Claude Opus 5" is the header of a menu, not a chip — the chip says Opus 5,
  // then only what you've moved off default.
  const modelLabel = (models.find((m) => m.id === model)?.label ?? model).replace(/^Claude /, "");
  const settingsLabel = [
    modelLabel,
    effort && EFFORTS.find((e) => e.id === effort)?.label,
    perm && PERMS.find((p) => p.id === perm)?.label,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <div
      ref={barRef}
      className="fixed inset-x-0 z-10 mx-auto max-w-screen-sm border-t border-border bg-[var(--tg-bg)] px-3 pb-3 pt-2"
      style={{ bottom: "var(--tabbar-h)" }}
    >
      <UsageStrip />

      {zoom && <ImageLightbox src={zoom.src} alt={zoom.alt} onClose={() => setZoom(null)} />}
      {draftAttachments.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-2">
          {draftAttachments.map((a) => (
            <div key={a.id} className="relative">
              <button
                type="button"
                onClick={() => a.dataUrl && setZoom({ src: a.dataUrl, alt: a.name })}
                aria-label={`Open ${a.name}`}
                className="block"
              >
                <img
                  src={a.dataUrl}
                  alt={a.name}
                  className="h-12 w-12 rounded-lg object-cover"
                />
              </button>
              <button
                onClick={() => removeAttachment(a.id)}
                className="absolute -right-1.5 -top-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-black/70 text-white"
                aria-label={`Remove ${a.name}`}
              >
                <X size={12} aria-hidden />
              </button>
            </div>
          ))}
        </div>
      )}

      {slashOpen && (
        <div className="mb-2 max-h-[40vh] overflow-y-auto rounded-xl border border-border bg-secondary/60">
          {hits.length === 0 ? (
            <div className="p-3 text-center text-xs text-[var(--tg-hint)]">
              the bridge needs a restart before it can list commands
            </div>
          ) : hits.map((c) => (
            <button
              key={c.name}
              type="button"
              // keep the keyboard up: the tap must not move focus off the textarea
              onPointerDown={(e) => e.preventDefault()}
              onClick={() => takeSlash(c.name)}
              className="flex w-full items-baseline gap-2 border-b border-border/60 px-3 py-2 text-left last:border-b-0 active:bg-secondary"
            >
              <span className="shrink-0 font-mono text-xs text-[var(--brand-soft)]">/{c.name}</span>
              <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{c.description}</span>
            </button>
          ))}
        </div>
      )}
      <Textarea
        ref={taRef}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape" && slashOpen) { e.preventDefault(); setSlashDismissed(true); return; }
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            // Enter completes the command unless it's already typed out — then
            // it sends, as `/compact` + Enter should.
            if (slashOpen && hits.length && !isExact(hits[0], slashQ!)) { takeSlash(hits[0].name); return; }
            void (blocked ? queue() : send());
          }
        }}
        placeholder={blocked ? "Type the next one — it queues…" : "Message Claude…"}
        rows={1}
        className="max-h-[168px] resize-none overflow-y-auto"
      />
      {(blocked || queued > 0) && (
        <div className="mt-1.5 px-1 text-[10px] tracking-wide text-[var(--muted-2)]">
          QUEUED PROMPTS SEND WHEN THE RUN ENDS
          {queued > 0 ? ` · ${queued} IN QUEUE` : ""}
        </div>
      )}

      <div className="mt-2 flex items-center gap-1">
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          multiple
          className="hidden"
          onChange={(e) => {
            void addAttachments(e.target.files);
            e.target.value = "";
          }}
        />
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-9 w-9 shrink-0 rounded-full text-muted-foreground"
          onClick={() => fileRef.current?.click()}
          aria-label="Attach images"
        >
          <Paperclip size={18} aria-hidden />
        </Button>

        {/* Model, effort and operating mode are one decision ("how should this
            run go?") and were three chips on their own row — now one chip that
            only spells out what you've overridden. */}
        <DropdownMenu>
          <DropdownMenuTrigger className={`${chipClass} min-w-0`} aria-label="Run settings">
            <Sparkles size={13} className="shrink-0 text-[var(--brand-soft)]" aria-hidden />
            <span className="truncate">{settingsLabel}</span>
            <ChevronDown size={13} className="shrink-0 text-muted-foreground" aria-hidden />
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="start"
            collisionPadding={12}
            className="max-h-[70vh] w-[min(23rem,calc(100vw-1.5rem))] overflow-y-auto p-1.5"
          >
            <OptionRow
              label="MODEL"
              value={model}
              options={models.map((m) => ({ id: m.id, label: m.label.replace(/^Claude /, "") }))}
              onPick={(v) => setModel(v as ModelId)}
            />
            <DropdownMenuSeparator />
            <OptionRow
              label="REASONING EFFORT"
              value={effort}
              options={EFFORTS}
              onPick={(v) => setEffort(v as EffortLevel | "")}
            />
            <DropdownMenuSeparator />
            <OptionRow
              label="OPERATING MODE · THIS RUN"
              value={perm}
              options={PERMS}
              onPick={setPerm}
            />
          </DropdownMenuContent>
        </DropdownMenu>

        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-9 w-9 shrink-0 rounded-full text-muted-foreground disabled:opacity-40"
          onClick={() => void compact()}
          disabled={blocked}
          title="Compact the conversation to reclaim context"
          aria-label="Compact conversation"
        >
          <Minimize2 size={16} aria-hidden />
        </Button>

        <span className="flex-1" />

        {blocked ? (
          <>
            <button
              type="button"
              onClick={() => void queue()}
              disabled={draft.trim().length === 0}
              className="h-10 shrink-0 border border-border-bright px-3 text-[11px] tracking-[1.5px] text-[var(--brand-soft)] active:opacity-70 disabled:opacity-40"
            >
              ↥ QUEUE
            </button>
            {isRunning && (
              <Button
                type="button"
                variant="destructive"
                size="icon"
                className="h-10 w-10 rounded-full"
                onClick={() => void stop()}
                aria-label="Stop"
              >
                <Square size={15} fill="currentColor" aria-hidden />
              </Button>
            )}
          </>
        ) : (
          <Button
            type="button"
            size="icon"
            className="h-10 w-10 rounded-full shadow-[0_0_18px_var(--brand-glow)] disabled:shadow-none"
            disabled={sendDisabled}
            onClick={() => void send()}
            aria-label="Send"
          >
            <ArrowUp size={18} aria-hidden />
          </Button>
        )}
      </div>
    </div>
  );
}
