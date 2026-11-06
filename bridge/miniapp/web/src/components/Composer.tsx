import { Fragment, useEffect, useRef, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Paperclip, ArrowUp, X, Sparkles, ChevronDown, Square, Minimize2 } from "lucide-react";
import { useChat } from "../lib/chat";
import { loginSlot, loginWindows, useAccounts } from "../lib/accounts";
import { api, type EffortLevel, type HandoffPreview, type ModelId, type Profile, type SlashCommand, type SwitchScope } from "../lib/api";
import { isExact, rankCommands, slashQuery } from "../lib/slash";
import { atQuery, insertName, isWholeName, rankNames } from "../lib/mention";
import { providerName, useChannel } from "../lib/multi";
import { HelpersRow } from "./HelpersRow";
import { SwitchSheet } from "./SwitchSheet";
import { Banner, Button } from "./ui";
import { Textarea } from "./ui/textarea";
import { UsageStrip } from "./UsageStrip";
import { ImageLightbox, MediaThumb, isFileUrl } from "./ImageLightbox";
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

// The session's operating mode. These are Claude Code's own permission modes —
// the CLI's ids, in its own least-authority-first order — so a phone can't pick
// a posture `claude --permission-mode` would reject. (It also takes "manual",
// but that is only its alias for "default".) The Mini App has no free-agent
// picker, so this list is Claude's alone; the dashboard's composer carries
// opencode's shorter one.
const PERMS: { id: string; label: string }[] = [
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
 *  to change more than one thing. Options with a note (PROFILE: what each
 *  sets) stack as full-width rows instead, the note under the label. */
function OptionRow({
  label,
  value,
  options,
  onPick,
  locked,
}: {
  label: string;
  value: string;
  /** Why this can't be changed right now: greys the row and says so. */
  locked?: string;
  // hint: a reading after the label (a profile's "5H 64% · WK 88% left");
  // note: a line under it (what the profile sets)
  options: { id: string; label: string; title?: string; hint?: ReactNode; note?: string }[];
  onPick: (id: string) => void;
}) {
  const stack = options.some((o) => o.note);
  return (
    <div className="px-1 pb-1.5">
      <div className="px-1 py-1 text-[10px] tracking-[1.5px] text-muted-foreground">{label}</div>
      {locked && <div className="px-1 pb-1 text-[11px] leading-snug text-amber-400">{locked}</div>}
      <div role="radiogroup" aria-label={label} className={`flex gap-1 ${stack ? "flex-col" : "flex-wrap"}`}>
        {options.map((o) => (
          <button
            key={o.id}
            type="button"
            role="radio"
            aria-checked={o.id === value}
            title={o.title}
            disabled={!!locked}
            onClick={() => onPick(o.id)}
            className={`rounded-lg border px-2 py-1.5 text-left text-xs transition-colors disabled:opacity-40 ${
              o.id === value
                ? "border-[var(--brand-soft)] text-[var(--brand-soft)]"
                : "border-border text-foreground/70 active:opacity-70"
            }`}
          >
            {o.label}
            {o.hint}
            {o.note && <span className="mt-0.5 block text-[10px] tracking-[.5px] text-muted-foreground">{o.note}</span>}
          </button>
        ))}
      </div>
    </div>
  );
}

// What a profile's Claude login has left in each window, after its name: a
// window reads amber once past normal, red when it's spent.
function leftHint(ws: { tag: string; left: number; severity: string }[]): ReactNode {
  if (!ws.length) return undefined;
  const tone = (s: string) => s === "critical" || s === "exceeded" ? "text-red-400"
    : s && s !== "normal" ? "text-amber-400" : undefined;
  return (
    <span className="ml-1.5 tabular-nums text-muted-foreground">
      {ws.map((w, i) => (
        <Fragment key={w.tag}>{i > 0 && " · "}<span className={tone(w.severity)}>{w.tag} {w.left}%</span></Fragment>
      ))} left
    </span>
  );
}

// A knob set by hand in a session bound to a profile: its value wins over the
// profile's until you pick the profile's own again (bridge profiles.save_pick).
// Mirrors bridge/dashboard/web/src/components/Composer.tsx's OVERRIDE_TIP.
const OVERRIDE_TIP = "set in this session; pick the profile's value to follow it again";

/** Dots the selected option's label — the composer's only tell that a knob is
 *  this session's own, over its bound profile's. `on` is whether the caller's
 *  knob is listed in the session's `overrides`; untouched when false, so the
 *  shared EFFORTS/PERMS arrays below are never mutated. */
function dotSelected<T extends { id: string; label: string; title?: string }>(
  options: T[], value: string, on: boolean,
): T[] {
  if (!on) return options;
  return options.map((o) => (o.id === value ? { ...o, label: `${o.label} •`, title: OVERRIDE_TIP } : o));
}

// "FABLE-5-1 · PLAN · HIGH" — what a session bound to this profile runs with,
// the line under each PROFILE row. Mirrors bridge/dashboard/web/src/lib/profiles.ts
// describe() (hand-kept copy — the two web apps don't share source).
function describeProfile(p: Profile): string {
  const bits = [p.agent !== "claude" ? `◇ ${p.agent}` : p.account && `A${p.account}`, p.model.replace(/^claude-/, ""),
    p.mode.replace(/([a-z])([A-Z])/g, "$1 $2"), p.effort, p.tools && `${p.tools.length} off`];
  return (bits.filter(Boolean).join(" · ") || "defaults").toUpperCase();
}

const chipClass =
  "mcomp-chip inline-flex items-center gap-1.5 rounded-lg border border-border bg-secondary/60 px-2.5 py-1.5 text-xs font-medium text-foreground outline-none transition-colors active:opacity-70 focus-visible:ring-2 focus-visible:ring-ring";

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
    profiles,
    profileId,
    pickProfile,
    profilesError,
    overrides,
    sessionAgent,
    sessionSlot,
    sessionId,
    experimental,
    openBrief,
  } = useChat();
  const onAgent = sessionAgent !== "claude";
  // With the switch on the capability table answers what the agent's id used to.
  const caps = experimental ? openBrief?.caps : undefined;
  const canCompact = caps ? caps.compact : !onAgent;
  const helperName = caps && openBrief?.parent_session ? openBrief.title || "this helper" : null;
  const agentWord = !caps ? "Claude" : helperName ?? providerName(sessionAgent);
  const channel = useChannel(sessionId, experimental);
  const helpersCfg = experimental ? channel.data?.config ?? openBrief?.helpers : undefined;
  // Each PROFILE row says what its Claude login has left in each window; NO
  // PROFILE runs on the default login.
  const logins = useAccounts().data?.accounts;
  const leftOf = (agent?: string, account?: string) =>
    leftHint(loginWindows(logins?.find((a) => a.slot === loginSlot(agent, account))));
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

  // --- picking a profile ---------------------------------------------------
  // With the switch on, a provider change moves the chat's history, so it's asked
  // about first (handoff.preview), and it can't happen during a turn.
  const [menuOpen, setMenuOpen] = useState(false);
  const [askSwitch, setAskSwitch] = useState<{ pid: string; preview: HandoffPreview } | null>(null);
  const [switching, setSwitching] = useState(false);
  const [switchErr, setSwitchErr] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);
  useEffect(() => { setRefusal(null); setAskSwitch(null); setSwitchErr(null); }, [sessionId]);
  const profileLock = !experimental ? undefined
    : openBrief?.parent_session ? "A helper stays on the provider it was started on."
    : isRunning ? "A turn is running. Change this after it finishes." : undefined;
  async function choose(pid: string) {
    if (!experimental) return void pickProfile(pid);
    if (pid === profileId || !sessionId) return;
    setRefusal(null);
    try {
      const preview = await api.handoffPreview(sessionId, pid);
      if (preview.refusal) { setRefusal(preview.refusal); return; }
      if (!preview.needs_dialog) { await pickProfile(pid); return; }
      setSwitchErr(null);
      setMenuOpen(false);
      setAskSwitch({ pid, preview });
    } catch (e) {
      setRefusal(e instanceof Error ? e.message : "Couldn't check this switch.");
    }
  }
  async function confirmSwitch(scope: SwitchScope) {
    if (!askSwitch) return;
    setSwitching(true);
    setSwitchErr(null);
    const done = await pickProfile(askSwitch.pid, scope);
    setSwitching(false);
    if (done) setAskSwitch(null);
    else setSwitchErr("The switch didn't go through. Try again once this chat is idle.");
  }

  // --- @ profiles ----------------------------------------------------------
  // Off the switch this list never opens, so an @ is plain text as it always was.
  const [caret, setCaret] = useState(0);
  const [atDismissed, setAtDismissed] = useState(false);
  const at = experimental && profiles?.length ? atQuery(draft, caret) : null;
  const atHits = at ? rankNames(profiles ?? [], at.q).slice(0, 6) : [];
  const atOpen = !!at && !atDismissed && atHits.length > 0;
  useEffect(() => { if (!at) setAtDismissed(false); }, [!!at]); // eslint-disable-line react-hooks/exhaustive-deps
  function takeMention(name: string) {
    if (!at) return;
    const r = insertName(draft, at, caret, name);
    setDraft(r.text);
    setCaret(r.caret);
    const el = taRef.current;
    if (el) {
      el.focus();
      requestAnimationFrame(() => el.setSelectionRange(r.caret, r.caret));
    }
  }

  // --- steering ------------------------------------------------------------
  // In through the channel, addressed to whoever this session is: the Mini App has
  // no steer route of its own, and channel._reach steers a busy agent. Text only.
  const steerMode = caps?.steer === "native" || caps?.steer === "soft" ? caps.steer : null;
  const [steerErr, setSteerErr] = useState<string | null>(null);
  const [steering, setSteering] = useState(false);
  async function steerNow() {
    const text = draft.trim();
    if (!text || !sessionId) return;
    setSteering(true);
    setSteerErr(null);
    try {
      await api.channelSend(sessionId, helperName ?? "main", text);
      setDraft("");
    } catch (e) {
      setSteerErr(e instanceof Error ? e.message : "That didn't reach it. Your words are still here.");
    } finally {
      setSteering(false);
    }
  }
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
  // Claude's commands and skills: an agent session's / runs none of them.
  const cmdsQ = useQuery({ queryKey: ["commands"], queryFn: () => api.getCommands(), enabled: slashOn && (!onAgent || !!caps), retry: false });
  // On another agent with the switch on, / offers the skills shared with it, written
  // the way it takes them (caps.skills_prefix: Kimi's is /skill:name).
  const agentSkills = !!caps && onAgent;
  const sharedQ = useQuery({
    queryKey: ["skill-share", openBrief?.cwd ?? ""],
    queryFn: () => api.skillShare(openBrief?.cwd),
    enabled: slashOn && agentSkills,
    retry: false,
  });
  const prefix = caps?.skills_prefix ?? "/";
  const offered: SlashCommand[] = agentSkills
    ? (sharedQ.data?.skills ?? []).filter((k) => k.on && !k.conflict).map((k) => ({
        name: k.name,
        description: cmdsQ.data?.commands.find((c) => c.name === k.name)?.description ?? "",
        scope: "project" as const,
      }))
    : cmdsQ.data?.commands ?? [];
  const slashBody = agentSkills ? slashQ?.replace(/^skill:/, "") ?? null : slashQ;
  const slashUsable = !onAgent || agentSkills;
  const hits = slashBody === null || !slashUsable ? [] : rankCommands(offered, slashBody);
  const listFailed = agentSkills ? sharedQ.isError : cmdsQ.isError;
  const slashOpen = slashOn && slashUsable && !slashDismissed && (hits.length > 0 || listFailed);
  function takeSlash(name: string) {
    setDraft(`${agentSkills ? prefix : "/"}${name} `);
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
        // No model or mode: it runs on the session's when it starts. Nor
        // effort on another agent, whose ids aren't this phone's.
        effort: (!onAgent && effort) || undefined,
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
  const settingsLabel = onAgent ? `◇ ${sessionAgent.toUpperCase()}` : [
    modelLabel,
    effort && EFFORTS.find((e) => e.id === effort)?.label,
    perm && PERMS.find((p) => p.id === perm)?.label,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <div
      ref={barRef}
      className="mcomp fixed inset-x-0 z-10 mx-auto max-w-screen-sm border-t border-border bg-[var(--tg-bg)] px-3 pb-3 pt-2"
      style={{ bottom: "var(--tabbar-h)" }}
    >
      <UsageStrip slot={sessionSlot} />

      {askSwitch && (
        <SwitchSheet
          preview={askSwitch.preview}
          busy={switching}
          error={switchErr && (profilesError ?? switchErr)}
          onPick={(scope) => void confirmSwitch(scope)}
          onCancel={() => setAskSwitch(null)}
        />
      )}
      {helperName && (
        <div className="mb-1.5 truncate px-1 text-[10px] tracking-[1px] text-[var(--brand-soft)]">
          TALKING TO {helperName.toUpperCase()} · {providerName(sessionAgent).toUpperCase()}
        </div>
      )}
      {steerErr && isRunning && <div className="mb-2"><Banner tone="error">{steerErr}</Banner></div>}

      {zoom && (
        <ImageLightbox
          src={zoom.src}
          alt={zoom.alt}
          all={draftAttachments.flatMap((a) => (a.dataUrl ? [{ src: a.dataUrl }] : []))}
          onClose={() => setZoom(null)}
        />
      )}
      {draftAttachments.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-2">
          {draftAttachments.map((a) => (
            <div key={a.id} className="relative">
              <button
                type="button"
                onClick={() => a.dataUrl && !isFileUrl(a.dataUrl) && setZoom({ src: a.dataUrl, alt: a.name })}
                aria-label={`Open ${a.name}`}
                className="block"
              >
                <MediaThumb
                  src={a.dataUrl as string}
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

      {atOpen && (
        <div className="mb-2 max-h-[40vh] overflow-y-auto rounded-xl border border-border bg-secondary/60" role="listbox" aria-label="Profiles">
          {atHits.map((p) => (
            <button
              key={p.id}
              type="button"
              role="option"
              aria-selected={false}
              // keep the keyboard up, like the command list
              onPointerDown={(e) => e.preventDefault()}
              onClick={() => takeMention(p.name)}
              className="flex min-h-[44px] w-full items-baseline gap-2 border-b border-border/60 px-3 py-2 text-left last:border-b-0 active:bg-secondary"
            >
              <span className="shrink-0 font-mono text-xs text-[var(--brand-soft)]">@{p.name}</span>
              <span className="min-w-0 flex-1 truncate text-[10px] tracking-[.5px] text-muted-foreground">{describeProfile(p)}</span>
            </button>
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
              <span className="shrink-0 font-mono text-xs text-[var(--brand-soft)]">{agentSkills ? prefix : "/"}{c.name}</span>
              <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{c.description}</span>
            </button>
          ))}
        </div>
      )}
      <Textarea
        ref={taRef}
        value={draft}
        onChange={(e) => { setDraft(e.target.value); setCaret(e.target.selectionStart); }}
        onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
        onKeyDown={(e) => {
          if (e.key === "Escape" && atOpen) { e.preventDefault(); setAtDismissed(true); return; }
          if (e.key === "Escape" && slashOpen) { e.preventDefault(); setSlashDismissed(true); return; }
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            if (atOpen && at && !isWholeName(atHits[0].name, at.q)) { takeMention(atHits[0].name); return; }
            // Enter completes the command unless it's already typed out — then
            // it sends, as `/compact` + Enter should.
            if (slashOpen && hits.length && !isExact(hits[0], slashQ!)) { takeSlash(hits[0].name); return; }
            void (blocked ? queue() : send());
          }
        }}
        placeholder={blocked
          ? (steerMode && isRunning ? "Steer it now, or queue the next one…" : "Type the next one — it queues…")
          : `Message ${agentWord}…`}
        rows={1}
        className="max-h-[168px] resize-none overflow-y-auto"
      />
      {(blocked || queued > 0) && (
        <div className="mt-1.5 px-1 text-[10px] tracking-wide text-[var(--muted-2)]">
          QUEUED PROMPTS SEND WHEN THE RUN ENDS
          {queued > 0 ? ` · ${queued} IN QUEUE` : ""}
          {steerMode === "soft" && isRunning ? ` · A STEER REACHES ${agentWord.toUpperCase()} AT ITS NEXT STEP` : ""}
          {steerMode && isRunning && draftAttachments.length > 0 ? " · QUEUE TO SEND FILES" : ""}
        </div>
      )}

      <div className="mt-2 flex items-center gap-1">
        <input
          ref={fileRef}
          type="file"
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
          aria-label="Attach a file"
        >
          <Paperclip size={18} aria-hidden />
        </Button>

        {/* Model, effort and operating mode are one decision ("how should this
            run go?") and were three chips on their own row — now one chip that
            only spells out what you've overridden. */}
        <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
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
            {profilesError && <Banner tone="error">{profilesError}</Banner>}
            {refusal && <Banner tone="error">{refusal}</Banner>}
            {profiles && (
              <>
                <OptionRow
                  label="PROFILE"
                  value={profileId}
                  options={[
                    { id: "", label: "NO PROFILE", hint: leftOf() },
                    ...profiles.map((p) => ({ id: p.id, label: p.name, note: describeProfile(p),
                                              hint: leftOf(p.agent, p.account) })),
                  ]}
                  onPick={(v) => void choose(v)}
                  locked={profileLock}
                />
                {(!onAgent || helpersCfg) && <DropdownMenuSeparator />}
              </>
            )}
            {helpersCfg && sessionId && (
              <>
                <HelpersRow sessionId={sessionId} config={helpersCfg} />
                {!onAgent && <DropdownMenuSeparator />}
              </>
            )}
            {/* Another agent's models and modes are its own: picked on the dashboard. */}
            {!onAgent && <>
            <OptionRow
              label="MODEL"
              value={model}
              options={dotSelected(
                models.map((m) => ({ id: m.id, label: m.label.replace(/^Claude /, "") })),
                model, overrides.includes("model"),
              )}
              onPick={(v) => setModel(v as ModelId)}
            />
            <DropdownMenuSeparator />
            <OptionRow
              label="REASONING EFFORT"
              value={effort}
              options={dotSelected(EFFORTS, effort, overrides.includes("effort"))}
              onPick={(v) => setEffort(v as EffortLevel | "")}
            />
            <DropdownMenuSeparator />
            <OptionRow
              label="OPERATING MODE"
              value={perm}
              options={dotSelected(PERMS, perm, overrides.includes("permission_mode"))}
              onPick={setPerm}
            />
            </>}
          </DropdownMenuContent>
        </DropdownMenu>

        {canCompact && <Button
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
        </Button>}

        <span className="flex-1" />

        {blocked ? (
          <>
            {steerMode && isRunning && (
              <button
                type="button"
                onClick={() => void steerNow()}
                disabled={steering || draft.trim().length === 0 || draftAttachments.length > 0}
                title={steerMode === "soft" ? "Reaches it at its next step" : "Folds into the running turn"}
                className="h-10 shrink-0 border border-border-bright px-3 text-[11px] tracking-[1.5px] text-[var(--brand-soft)] active:opacity-70 disabled:opacity-40"
              >
                ⇄ STEER
              </button>
            )}
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
            className="mcomp-send h-10 w-10 rounded-full shadow-[0_0_18px_var(--brand-glow)] disabled:shadow-none"
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
