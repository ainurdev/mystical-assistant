import { createRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { rootRoute } from "./root";
import { api } from "../lib/api";
import { useSpentUsage } from "../lib/accounts";
import { useChat } from "../lib/chat";
import { useState, type ReactNode } from "react";
import { ThemeCards } from "../components/ThemePicker";
import { useFoldsOpen } from "../lib/folds";
import { CHAT_BGS, useChatBg } from "../lib/toolwidget";
import {
  applyHeaderStyle, applyLayout, loadHeaderStyle, loadLayout,
  type ChatLayout, type HeaderStyle,
} from "../lib/theme";

/* SYSTEM — the controls that belong to the app rather than to one chat: what's
   left of the Claude limits this phone is spending (the login the open chat
   runs on, which a profile pick or a fallback handover changes), then the
   dashboard's appearance and transcript picks, phone-sized: the theme, how the
   header sits over the chat, and how the chat reads. */

function fmtReset(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function sevColor(sev: string | undefined): string {
  if (sev === "critical" || sev === "exceeded") return "text-red-400";
  if (sev && sev !== "normal") return "text-amber-400";
  return "text-[var(--brand-soft)]";
}

function Bucket({
  label,
  bucket,
}: {
  label: string;
  bucket: { percent: number; resets_at: string | null; severity: string } | null | undefined;
}) {
  if (!bucket) return null;
  return (
    <div className="border border-border bg-[var(--tg-secondary-bg)] px-3 py-2.5">
      <div className="flex items-baseline gap-2">
        <span className="text-[10px] tracking-[1.5px] text-[var(--tg-hint)]">{label}</span>
        <span className={`ml-auto text-sm ${sevColor(bucket.severity)}`}>{bucket.percent}%</span>
      </div>
      <div className="mt-1.5 h-1 w-full bg-[var(--ac-06)]">
        <div
          className="h-1 bg-[var(--brand-soft)]"
          style={{ width: `${Math.min(100, Math.max(0, bucket.percent))}%` }}
        />
      </div>
      {bucket.resets_at && (
        <div className="mt-1.5 text-[10px] tracking-wider text-[var(--muted-2)]">
          RESETS {fmtReset(bucket.resets_at).toUpperCase()}
        </div>
      )}
    </div>
  );
}

function SystemPage() {
  const { sessionSlot } = useChat();
  const { usage, tag, who } = useSpentUsage(sessionSlot);
  const { data: state } = useQuery({ queryKey: ["state"], queryFn: () => api.getState() });

  return (
    <div className="space-y-5 pb-6">
      <div className="flex items-baseline gap-2.5">
        <span className="glow text-[13px] tracking-[3px] text-foreground-bright">SYSTEM</span>
        <span className="text-[10px] tracking-wider text-[var(--tg-hint)]">LIMITS · THEME · TRANSCRIPT</span>
      </div>

      <div className="space-y-2">
        <div className="flex min-w-0 items-baseline gap-2">
          <span className="sset-head">Limits</span>
          {tag && (
            <span className="truncate text-[10px] tracking-wider text-[var(--tg-hint)]">
              {[tag, who].filter(Boolean).join(" · ")}
            </span>
          )}
        </div>
        {usage?.available ? (
          <div className="space-y-1.5">
            <Bucket label="5 HOUR" bucket={usage.five_hour} />
            <Bucket label="WEEK" bucket={usage.seven_day} />
          </div>
        ) : (
          <div className="text-xs text-[var(--tg-hint)]">
            {sessionSlot === null ? "This chat runs on another agent: no Claude limits." : "Usage unavailable."}
          </div>
        )}
      </div>

      <div className="space-y-2">
        <div className="sset-head">Theme</div>
        <ThemeCards />
      </div>

      <div className="space-y-2">
        <div className="sset-head">Header</div>
        <HeaderRow />
      </div>

      <div className="space-y-2">
        <div className="sset-head">Transcript</div>
        <div className="sset">
          <LayoutRow />
          <FoldsRow />
        </div>
        <GroundPicker />
      </div>

      <div className="space-y-1 text-[10px] tracking-wider text-[var(--muted-2)]">
        <div>PROJECT · {(state?.project?.rel ?? "none").toUpperCase()}</div>
        <div>MODE · {(state?.permission_mode ?? "default").toUpperCase()}</div>
      </div>
    </div>
  );
}

export const systemRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/system",
  component: SystemPage,
});

/** One settings row: the name and what the current pick does, the control
 *  under it — a phone is too narrow to put a three-way switch beside prose. */
function Row({ name, desc, children, inline }: { name: string; desc: ReactNode; children: ReactNode; inline?: boolean }) {
  return (
    <div className={`px-3 py-2.5 ${inline ? "flex items-center gap-3" : "space-y-2"}`}>
      <div className="min-w-0 flex-1">
        <div className="sset-key">{name}</div>
        <div className="sset-desc">{desc}</div>
      </div>
      {children}
    </div>
  );
}

function Seg<T extends string>({ label, options, value, onPick }: {
  label: string; options: { value: T; label: string }[]; value: T; onPick: (v: T) => void;
}) {
  return (
    <div className="sseg" role="group" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} type="button" aria-pressed={value === o.value} onClick={() => onPick(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

const HEADER_DESC: Record<HeaderStyle, string> = {
  frost: "Glass the transcript blurs through; its buttons at half ink until you touch it.",
  veil: "No bar at all: the top of the screen fades the transcript out under the title.",
  tuck: "An island folded to the title; the marks and the spend unfold while you touch it.",
};

/** How the chat's header sits over the transcript — the dashboard's HEADER. */
function HeaderRow() {
  const [h, setH] = useState<HeaderStyle>(loadHeaderStyle);
  return (
    <div className="sset">
      <Row name="Header" desc={HEADER_DESC[h]}>
        <Seg label="Header" value={h}
          options={[{ value: "frost", label: "Frost" }, { value: "veil", label: "Veil" }, { value: "tuck", label: "Tuck" }]}
          onPick={(v) => { applyHeaderStyle(v); setH(v); }} />
      </Row>
    </div>
  );
}

/** DEFAULT or COMPACT — the dashboard's CHAT LAYOUT. */
function LayoutRow() {
  const [l, setL] = useState<ChatLayout>(loadLayout);
  return (
    <Row name="Chat layout" desc={l === "compact"
      ? "Reads as a chat: your prompt a bubble on the right, the reply one on the left."
      : "Your prompt is a plate across the column; the reply sits flush under it."}>
      <Seg label="Chat layout" value={l}
        options={[{ value: "default", label: "Default" }, { value: "compact", label: "Compact" }]}
        onPick={(v) => { applyLayout(v); setL(v); }} />
    </Row>
  );
}

/** Between two things the agent says or thinks, its steps sit under one row.
 *  On (the default) that row mounts shut, so the words are what you see; off,
 *  it mounts open and a turn reads as the whole ledger. A tap on any one row
 *  still moves only that row. Thoughts are never folded (lib/segments). */
function FoldsRow() {
  const [open, setOpen] = useFoldsOpen();
  const on = !open;
  return (
    <Row inline name="Collapse steps" desc={on ? "The work sits under one row until you open it." : "Every step mounts open."}>
      <button type="button" onClick={() => setOpen(!open)} aria-pressed={on} aria-label="Collapse steps"
        className="stoggle" data-on={on ? "" : undefined}>
        <i />
      </button>
    </Row>
  );
}

/** THE GROUND — the texture under the words. Each tile is drawn with the real
 *  ground (data-bg) on the live theme, so what you pick is what you get. */
function GroundPicker() {
  const [bg, setBg] = useChatBg();
  const cur = CHAT_BGS.find((b) => b.key === bg) ?? CHAT_BGS[0];
  return (
    <div className="sset">
      <Row name="The ground" desc={cur.hint}>
        <div className="grid grid-cols-4 gap-1.5">
          {CHAT_BGS.map((b) => (
            <button key={b.key} type="button" onClick={() => setBg(b.key)} aria-pressed={bg === b.key}
              className="gtile" data-bg={b.key}>
              <span>{b.label}</span>
            </button>
          ))}
        </div>
      </Row>
    </div>
  );
}
