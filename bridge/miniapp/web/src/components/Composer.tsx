import { useEffect, useRef } from "react";
import { Paperclip, ArrowUp, X, Sparkles, ChevronDown, Square, Minimize2 } from "lucide-react";
import { useChat } from "../lib/chat";
import type { EffortLevel, ModelId } from "../lib/api";
import { Button } from "./ui";
import { Textarea } from "./ui/textarea";
import { UsageStrip } from "./UsageStrip";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
} from "./ui/dropdown-menu";

const MODELS: { id: ModelId; label: string }[] = [
  { id: "opus", label: "Opus 4.8" },
  { id: "sonnet", label: "Sonnet 4.6" },
  { id: "haiku", label: "Haiku 4.5" },
];

const EFFORTS: { id: EffortLevel | ""; label: string }[] = [
  { id: "", label: "Auto" },
  { id: "low", label: "Low" },
  { id: "medium", label: "Medium" },
  { id: "high", label: "High" },
  { id: "xhigh", label: "Extra high" },
  { id: "max", label: "Max" },
];

// Per-message operating mode ("" keeps the session's). Mirrors the CLI's
// permission modes so you can flip a single run from your phone.
const PERMS: { id: string; label: string }[] = [
  { id: "", label: "Session default" },
  { id: "default", label: "Ask each time" },
  { id: "acceptEdits", label: "Accept edits" },
  { id: "plan", label: "Plan only" },
  { id: "auto", label: "Auto" },
  { id: "bypassPermissions", label: "Full autonomy" },
];

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
    effort,
    setEffort,
    perm,
    setPerm,
  } = useChat();
  const fileRef = useRef<HTMLInputElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);

  // Grow the textarea with its content, up to ~6 rows.
  useEffect(() => {
    const el = taRef.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = `${Math.min(el.scrollHeight, 168)}px`;
  }, [draft]);

  const blocked = isRunning || pending.length > 0;
  const sendDisabled = blocked || draft.trim().length === 0;
  const modelLabel = MODELS.find((m) => m.id === model)?.label ?? model;
  const effortLabel = EFFORTS.find((e) => e.id === effort)?.label ?? "Auto";
  const permLabel = PERMS.find((p) => p.id === perm)?.label ?? "Session default";

  return (
    <div className="fixed inset-x-0 bottom-0 z-10 mx-auto max-w-screen-sm border-t border-border bg-[var(--tg-bg)] px-3 pb-3 pt-2">
      <UsageStrip />
      {/* model / effort toolbar */}
      <div className="mb-2 flex items-center gap-2">
        <DropdownMenu>
          <DropdownMenuTrigger className={chipClass} aria-label="Model">
            <Sparkles size={13} className="text-[var(--brand-soft)]" aria-hidden />
            {modelLabel}
            <ChevronDown size={13} className="text-muted-foreground" aria-hidden />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuLabel>Model</DropdownMenuLabel>
            <DropdownMenuRadioGroup
              value={model}
              onValueChange={(v) => setModel(v as ModelId)}
            >
              {MODELS.map((m) => (
                <DropdownMenuRadioItem key={m.id} value={m.id}>
                  {m.label}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>

        <DropdownMenu>
          <DropdownMenuTrigger className={chipClass} aria-label="Effort">
            Effort: {effortLabel}
            <ChevronDown size={13} className="text-muted-foreground" aria-hidden />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuLabel>Reasoning effort</DropdownMenuLabel>
            <DropdownMenuRadioGroup
              value={effort || "auto"}
              onValueChange={(v) => setEffort(v === "auto" ? "" : (v as EffortLevel))}
            >
              {EFFORTS.map((e) => (
                <DropdownMenuRadioItem key={e.id || "auto"} value={e.id || "auto"}>
                  {e.label}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>

        <DropdownMenu>
          <DropdownMenuTrigger className={chipClass} aria-label="Permission mode">
            {permLabel}
            <ChevronDown size={13} className="text-muted-foreground" aria-hidden />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuLabel>Operating mode (this run)</DropdownMenuLabel>
            <DropdownMenuRadioGroup value={perm || "session"} onValueChange={(v) => setPerm(v === "session" ? "" : v)}>
              {PERMS.map((p) => (
                <DropdownMenuRadioItem key={p.id || "session"} value={p.id || "session"}>
                  {p.label}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>

        <button
          type="button"
          onClick={() => void compact()}
          disabled={blocked}
          className={`${chipClass} disabled:opacity-40`}
          title="Compact the conversation to reclaim context"
        >
          <Minimize2 size={13} className="text-[var(--brand-soft)]" aria-hidden />
          Compact
        </button>
      </div>

      {draftAttachments.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-2">
          {draftAttachments.map((a) => (
            <div key={a.id} className="relative">
              <img
                src={a.dataUrl}
                alt={a.name}
                className="h-12 w-12 rounded-lg object-cover"
              />
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

      <Textarea
        ref={taRef}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey && !blocked) {
            e.preventDefault();
            void send();
          }
        }}
        placeholder={isRunning ? "Add details, then Stop to send…" : "Message Claude…"}
        rows={1}
        className="max-h-[168px] resize-none overflow-y-auto"
      />

      <div className="mt-2 flex items-center justify-between">
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
          className="h-9 w-9 rounded-full text-muted-foreground"
          onClick={() => fileRef.current?.click()}
          aria-label="Attach images"
        >
          <Paperclip size={18} aria-hidden />
        </Button>

        {isRunning ? (
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
