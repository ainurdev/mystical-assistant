import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { ChevronRight, ChevronsRight, Merge, Paperclip, Pause, Square } from "lucide-react";
import { api, type EffortLevel, type GraphState, type ModelId } from "../api";
import type { AgentOption } from "../models";
import { ago } from "../lib/surfaces";
import { ImageLightbox, ZoomButton } from "./ImageLightbox";
import { FileIcon } from "../lib/fileicon";
import { applyMention, mentionAt, rankPaths } from "../lib/mention";

export const EFFORTS: { id: EffortLevel | ""; label: string }[] = [
  { id: "", label: "Auto" },
  { id: "low", label: "Low" },
  { id: "medium", label: "Medium" },
  { id: "high", label: "High" },
  { id: "xhigh", label: "XHigh" },
  { id: "max", label: "Max" },
];
// Per-message operating mode ("" keeps the session's). Mirrors the CLI permission
// modes so you can flip a single run (ask / plan / full autonomy) remotely.
export const PERMS: { id: string; label: string }[] = [
  { id: "", label: "Session" },
  { id: "default", label: "Ask" },
  { id: "acceptEdits", label: "Accept Edits" },
  { id: "plan", label: "Plan" },
  { id: "auto", label: "Auto-run" },
  { id: "bypassPermissions", label: "Full Auto" },
];
// Per-run code-minimalism intensity, threaded to the runner's env (Task 4/8).
export const PONYTAILS: { id: string; label: string }[] = [
  { id: "", label: "Default" },
  { id: "off", label: "Off" },
  { id: "lite", label: "Lite" },
  { id: "full", label: "Full" },
  { id: "ultra", label: "Ultra" },
];

const COMPACT_SUGGEST_TOKENS = 100_000;
const CONTEXT_MAX_TOKENS = 200_000;

// Exported for the status bar, which offers the same AGENT pick from the footer.
export function Drop<T extends string>({
  label, value, options, open, onToggle, onPick, minWidth = 78, showLabel = true,
}: {
  label: string;
  value: T;
  options: { id: T; label: string; short?: string }[]; // short → what the chip shows
  open: boolean;
  onToggle: () => void;
  onPick: (id: T) => void;
  minWidth?: number;
  showLabel?: boolean; // off when the cluster tag already names the field
}) {
  const cur = options.find((o) => o.id === value) ?? options[0];
  if (!cur) return null;                 // nothing to pick from yet (still loading)
  // min-width rides a custom property so the tight end of the layout ladder can
  // drop it to 0 (inline styles win over any stylesheet rule otherwise).
  const btn: CSSProperties = {
    appearance: "none", cursor: "pointer", border: "1px solid color-mix(in srgb, var(--acc) 25%, transparent)",
    background: "color-mix(in srgb, var(--panel2) 60%, transparent)", color: "var(--txh)", fontFamily: "inherit",
    fontSize: 9.5, letterSpacing: ".3px", padding: "4px 9px", display: "flex",
    alignItems: "center", gap: 10, justifyContent: "space-between",
    ["--dw" as string]: `${minWidth}px`,
  };
  return (
    <div style={{ position: "relative", display: "flex", alignItems: "center", gap: 6 }}>
      {showLabel && (
        <span className="ctrl-label" style={{ fontSize: 8, letterSpacing: 1, color: "var(--txl)", flex: "none" }}>{label}</span>
      )}
      <button className="drop-btn" onClick={onToggle} title={`${label} — ${cur.label}`} style={btn}>
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{cur.short ?? cur.label}</span>
        <span style={{ color: "var(--txd)", fontSize: 8 }}>▾</span>
      </button>
      {open && (
        <div
          style={{
            position: "absolute", bottom: "calc(100% + 5px)", left: 0, minWidth: 132,
            zIndex: 30, border: "1px solid color-mix(in srgb, var(--acc) 35%, transparent)", background: "color-mix(in srgb, var(--panel2) 98%, transparent)",
            boxShadow: "0 -8px 26px var(--shadow-pop)", animation: "mpop .12s ease",
          }}
        >
          {options.map((o) => {
            const on = o.id === value;
            return (
              <button
                key={o.id}
                onClick={() => onPick(o.id)}
                style={{
                  width: "100%", appearance: "none", cursor: "pointer", border: 0,
                  borderBottom: "1px solid color-mix(in srgb, var(--acc) 8%, transparent)",
                  background: on ? "color-mix(in srgb, var(--acc) 10%, transparent)" : "transparent",
                  color: on ? "var(--txb)" : "var(--txm)", fontFamily: "inherit", fontSize: 10.5,
                  letterSpacing: ".3px", textAlign: "left", padding: "8px 11px",
                  display: "flex", alignItems: "center", gap: 8,
                }}
              >
                <span style={{ width: 8, color: "var(--acc)", flex: "none" }}>{on ? "✓" : ""}</span>
                {o.label}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function fmtTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k`;
  return `${n}`;
}

// Shared look for the small action chips (REVIEW / AUDIT / MAP, and COMPACT on the context line).
const chip: CSSProperties = {
  appearance: "none", cursor: "pointer", border: "1px solid color-mix(in srgb, var(--acc) 20%, transparent)",
  background: "transparent", color: "var(--txd)", fontFamily: "inherit", fontSize: 9,
  letterSpacing: 1, padding: "3px 8px",
};

// The row's explanations, in the HUD's own type instead of the browser's yellow
// box: hover settles for a beat before it opens (so sweeping across the row
// doesn't strobe), click pins it open, Escape and blur close it. Touch has no
// hover at all, which is the other half of why `title` had to go.
// ponytail: one absolutely-positioned span, no floating-ui, no portal.
function Tip({ text, anchor = "center", pin = true, children }: {
  text: string;
  anchor?: "center" | "right"; // "right" for the last cluster — a centred box would hang off the edge
  pin?: boolean; // off when the trigger does something of its own — the click closes the tip instead
  children: ReactNode;
}) {
  const [hover, setHover] = useState(false);
  const [pinned, setPinned] = useState(false);
  const timer = useRef(0);
  const open = () => { window.clearTimeout(timer.current); timer.current = window.setTimeout(() => setHover(true), 400); };
  const close = () => { window.clearTimeout(timer.current); setHover(false); };
  useEffect(() => () => window.clearTimeout(timer.current), []);
  return (
    <span
      style={{ position: "relative", display: "inline-flex", flex: "none" }}
      onMouseEnter={open}
      onMouseLeave={close}
      onFocus={() => setHover(true)}
      onBlur={() => { close(); setPinned(false); }}
      onClick={() => { close(); setPinned((p) => pin && !p); }}
      onKeyDown={(e) => { if (e.key === "Escape") { close(); setPinned(false); } }}
    >
      {children}
      {(hover || pinned) && (
        <span role="tooltip"
          style={{ position: "absolute", bottom: "100%", paddingBottom: 7, zIndex: 40, pointerEvents: "none",
                   ...(anchor === "right" ? { right: 0 } : { left: "50%", transform: "translateX(-50%)" }) }}>
          <span style={{ display: "block", width: "max-content", maxWidth: 300, whiteSpace: "pre-line",
                         border: "1px solid color-mix(in srgb, var(--acc) 35%, transparent)",
                         background: "color-mix(in srgb, var(--panel2) 98%, transparent)",
                         boxShadow: "0 -8px 26px var(--shadow-pop)", animation: "mpop .12s ease",
                         color: "var(--txm)", fontSize: 10.5, lineHeight: 1.65, letterSpacing: ".2px", padding: "9px 11px" }}>
            {text}
          </span>
        </span>
      )}
    </span>
  );
}

// Shared look for the command-line action buttons (STOP / STEER / QUEUE / SEND).
const actBtn: CSSProperties = {
  appearance: "none", cursor: "pointer", fontFamily: "inherit", fontSize: 11, letterSpacing: 2,
  padding: "6px 14px", flex: "none", display: "inline-flex", alignItems: "center", gap: 6,
};

// Steering folds text into the turn already in flight. Merge rotated a quarter
// turn: two strands come in from the left and leave as one, pointing forward.
export function SteerIcon({ size = 13 }: { size?: number }) {
  return <Merge size={size} strokeWidth={1.8} style={{ transform: "rotate(90deg)", flex: "none" }} aria-hidden />;
}

export function Composer({
  disabled, running, model, models, agent, agents, onAgent, effort, perm, onPerm, ponytail, onPonytail, showPonytail, injectedText, injectNonce, sessionId,
  draft, onDraft, contextTokens, onModel, onEffort, onSend, onSteer, onStop, onCompact,
  queued, onCancelQueued, onEjectQueued, project, onOpenMap, paused, onTogglePause,
}: {
  disabled: boolean;
  running: boolean;
  // What you've typed, owned by the session it's for — switching sessions swaps
  // the text rather than carrying it into the next one.
  draft: string;
  onDraft: (text: string) => void;
  project?: string | null;
  // Both clusters are switched off from SETTINGS · SESSION: no handler, no GRAPH.
  onOpenMap?: () => void;
  model: ModelId;
  models: { id: ModelId; label: string }[];
  // Which platform runs the turn — a Claude login or a free-agent provider.
  agent: string;
  agents: AgentOption[];
  onAgent: (id: string) => void;
  effort: EffortLevel | "";
  perm: string;
  onPerm: (p: string) => void;
  ponytail: string;
  onPonytail: (v: string) => void;
  showPonytail: boolean;
  injectedText?: string;
  injectNonce?: number;
  sessionId?: string | null;
  contextTokens?: number;
  onModel: (m: ModelId) => void;
  onEffort: (e: EffortLevel | "") => void;
  onSend: (text: string, images: string[]) => void;
  onSteer?: (text: string) => void;
  onStop: () => void;
  onCompact?: () => void;
  queued?: { id: string; text: string }[];
  onCancelQueued?: (id: string) => void;
  onEjectQueued?: (id: string) => void; // pull it out and run it in a fresh session
  // Paused = the turn in flight finishes, but nothing starts on its own after it:
  // no queued prompt, no goal nudge. Your own SEND still runs (and unpauses).
  paused?: boolean;
  onTogglePause?: () => void;
}) {
  const text = draft;
  const setText = onDraft;
  const [images, setImages] = useState<string[]>([]);
  const [zoom, setZoom] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [openDrop, setOpenDrop] = useState<"" | "agent" | "model" | "effort" | "mode" | "pony">("");
  // A free agent brings its own model and has no effort knob, so those two
  // dropdowns would be lying about what runs — swap them for what actually will.
  const activeAgent = agents.find((a) => a.id === agent);
  const fileRef = useRef<HTMLInputElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (injectNonce) {
      setText(injectedText ?? "");
      taRef.current?.focus();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [injectNonce]);

  // Focus the command line whenever a session is opened or switched (and on
  // first mount) so you can start typing immediately without clicking in.
  useEffect(() => {
    taRef.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  // Project map freshness for the MAP button. Re-read when the project changes
  // and when a turn ends — that's when the bridge rebuilds the graph — then
  // follow the build so the age lands on the new map, not the one it replaced.
  // Nothing to poll for when the cluster is switched off.
  const [graph, setGraph] = useState<GraphState | null>(null);
  const mapOn = !!onOpenMap;
  useEffect(() => {
    if (!project || !mapOn) { setGraph(null); return; }
    let live = true;
    let t = 0;
    const poll = () => api.graphState(project)
      .then((s) => {
        if (!live) return;
        setGraph(s);
        if (s.building) t = window.setTimeout(poll, 3000);
      })
      .catch(() => { if (live) setGraph(null); });
    void poll();
    return () => { live = false; if (t) window.clearTimeout(t); };
  }, [project, running, mapOn]);

  // --- @-mentions ----------------------------------------------------------
  // The project's file list, fetched once per project and kept for the session.
  // A repo's tree is a few thousand short strings; re-fetching it per keystroke
  // to save that memory would be the expensive choice.
  const [tree, setTree] = useState<string[]>([]);
  useEffect(() => {
    if (!project) { setTree([]); return; }
    let live = true;
    void api.filesTree(project)
      .then((r) => { if (live) setTree(r.files); })
      .catch(() => { if (live) setTree([]); });
    return () => { live = false; };
  }, [project]);

  const [caret, setCaret] = useState(0);
  const [mentionPick, setMentionPick] = useState(0);
  // Escape dismisses the `@` you're on, not mentions in general: the next `@`
  // sits at a different index and opens normally.
  const [dismissed, setDismissed] = useState(-1);
  const mention = tree.length ? mentionAt(text, caret) : null;
  const hits = mention ? rankPaths(tree, mention.q) : [];
  // A query that matches nothing closes the list rather than showing an empty
  // box — you're writing an email address or a handle, not picking a file.
  const mentionOpen = !!mention && hits.length > 0 && mention.start !== dismissed;
  useEffect(() => { setMentionPick(0); }, [mention?.q, mention?.start]);

  /** Splice the highlighted path over the `@query` and put the caret after it. */
  function takeMention(path: string) {
    if (!mention) return;
    const next = applyMention(text, mention, caret, path);
    setText(next.text);
    requestAnimationFrame(() => {
      const el = taRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(next.caret, next.caret);
      setCaret(next.caret);
    });
  }

  /** Arrow/Tab/Enter belong to the mention list while it's open; Escape closes
   *  it without touching the draft. Returns true when the key was consumed. */
  function mentionKey(e: React.KeyboardEvent): boolean {
    if (!mentionOpen) return false;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      setMentionPick((p) => (p + (e.key === "ArrowDown" ? 1 : hits.length - 1)) % hits.length);
      return true;
    }
    if (e.key === "Enter" || e.key === "Tab") {
      e.preventDefault();
      takeMention(hits[mentionPick]);
      return true;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      setDismissed(mention!.start);
      return true;
    }
    return false;
  }

  // Auto-grow the input with its content (1 line → up to ~9 lines, then scroll).
  useLayoutEffect(() => {
    const el = taRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 180)}px`;
  }, [text]);

  function addFiles(files: FileList | File[] | null) {
    if (!files) return;
    Array.from(files).forEach((f) => {
      const r = new FileReader();
      r.onload = () => setImages((prev) => [...prev, r.result as string]);
      r.readAsDataURL(f);
    });
  }
  function imagesFrom(items: DataTransferItemList | undefined): File[] {
    return Array.from(items ?? [])
      .filter((it) => it.kind === "file" && it.type.startsWith("image/"))
      .map((it) => it.getAsFile())
      .filter((f): f is File => f !== null);
  }
  function submit() {
    const t = text.trim();
    if (!t || disabled) return;
    onSend(t, images);
    setText("");
    setImages([]);
  }

  // Land the text in the turn that's already running. Images can't fold into a
  // live turn, so they stay in the tray for the next send.
  function steer() {
    const t = text.trim();
    if (!t || !onSteer) return;
    onSteer(t);
    setText("");
  }

  const ctx = contextTokens ?? 0;
  const ctxPct = Math.min(100, Math.round((ctx / CONTEXT_MAX_TOKENS) * 100));
  const suggest = ctx >= COMPACT_SUGGEST_TOKENS;

  return (
    <div style={{ flex: "none", borderTop: "1px solid color-mix(in srgb, var(--acc) 14%, transparent)", padding: "11px 16px" }}>
      {/* Paused: shown even when idle, because that's exactly when you can't tell
          from the transcript that the queue and the goal loop are being held. */}
      {paused && (
        <div style={{ display: "flex", alignItems: "center", gap: 9, marginBottom: 9, padding: "5px 9px", border: "1px solid color-mix(in srgb, var(--warn) 34%, transparent)", background: "color-mix(in srgb, var(--warn) 8%, transparent)" }}>
          <Pause size={11} strokeWidth={0} fill="var(--warn)" aria-hidden style={{ flex: "none" }} />
          <span style={{ fontSize: 10, letterSpacing: 1, color: "var(--warn)", flex: "none" }}>PAUSED</span>
          <span style={{ fontSize: 10.5, color: "var(--txl)", flex: 1, minWidth: 0 }}>
            {running ? "this turn finishes; nothing starts after it" : "nothing starts on its own"}
            {queued && queued.length > 0 ? ` — ${queued.length} held` : ""}
          </span>
          {onTogglePause && (
            <button onClick={onTogglePause} title="Let queued prompts and goal nudges run again"
              style={{ ...chip, flex: "none", cursor: "pointer", border: "1px solid var(--warn)", color: "var(--warn)" }}>
              RESUME
            </button>
          )}
        </div>
      )}
      {/* queued prompts — waiting to run after the current turn */}
      {queued && queued.length > 0 && (
        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 6, marginBottom: 9 }}>
          <span style={{ fontSize: 10, letterSpacing: 1, color: "var(--purple)", flex: "none" }}>QUEUED · {queued.length}</span>
          {queued.map((q) => (
            <span key={q.id} title={q.text}
              style={{ display: "inline-flex", alignItems: "center", gap: 6, maxWidth: 240, border: "1px solid color-mix(in srgb, var(--purple) 30%, transparent)", background: "color-mix(in srgb, var(--purple) 8%, transparent)", color: "var(--purple-h)", fontSize: 10, letterSpacing: 0.5, padding: "2px 6px" }}>
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{q.text}</span>
              {onEjectQueued && (
                <button onClick={() => onEjectQueued(q.id)} title="Run in a new session"
                  style={{ appearance: "none", cursor: "pointer", border: 0, background: "transparent", color: "var(--purple)", fontSize: 11, lineHeight: 1, padding: 0, flex: "none" }}>↗</button>
              )}
              {onCancelQueued && (
                <button onClick={() => onCancelQueued(q.id)} title="Remove from queue"
                  style={{ appearance: "none", cursor: "pointer", border: 0, background: "transparent", color: "var(--purple)", fontSize: 11, lineHeight: 1, padding: 0, flex: "none" }}>✕</button>
              )}
            </span>
          ))}
        </div>
      )}
      {/* context meter — full-width status line above the controls */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 10, letterSpacing: 1, color: "var(--txl)", marginBottom: 10 }}>
        CONTEXT
        <span style={{ flex: 1, height: 4, background: "color-mix(in srgb, var(--acc) 12%, transparent)", position: "relative", overflow: "hidden" }}>
          <span style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: `${ctxPct}%`, background: "linear-gradient(90deg,var(--acc),var(--purple))", transition: "width .4s ease" }} />
        </span>
        <span style={{ color: suggest ? "var(--warn)" : "var(--acc)", flex: "none" }}>{ctxPct}%</span>
        {ctx > 0 && <span style={{ flex: "none" }}>~{fmtTokens(ctx)}</span>}
        {onCompact && (
          <button onClick={() => onCompact()} disabled={disabled || running} title="Compact context (/compact)"
            style={{ ...chip, flex: "none", cursor: disabled || running ? "not-allowed" : "pointer", opacity: disabled || running ? 0.4 : 1, ...(suggest ? { border: "1px solid var(--warn)", color: "var(--warn)" } : null) }}>
            COMPACT
          </button>
        )}
      </div>

      {/* image attachments */}
      {zoom && <ImageLightbox src={zoom} onClose={() => setZoom(null)} />}
      {images.length > 0 && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 9 }}>
          {images.map((src, i) => (
            <div key={i} style={{ position: "relative", width: 48, height: 48 }}>
              <ZoomButton onOpen={() => setZoom(src)}>
                <img src={src} alt="" style={{ width: 48, height: 48, border: "1px solid color-mix(in srgb, var(--acc) 16%, transparent)", objectFit: "cover" }} />
              </ZoomButton>
              <button
                type="button"
                onClick={() => setImages((p) => p.filter((_, j) => j !== i))}
                aria-label="Remove image"
                style={{ position: "absolute", right: -6, top: -6, width: 18, height: 18, display: "flex", alignItems: "center", justifyContent: "center", border: "1px solid color-mix(in srgb, var(--acc) 40%, transparent)", background: "var(--panel3)", color: "var(--txd)", fontSize: 11, lineHeight: 1, cursor: "pointer" }}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}

      {/* session controls — three fenced clusters: what runs the turn (AI), how
          much code it writes (PONYTAIL, with its two review commands), and the
          project map (GRAPH). Layout ladder lives in index.css. */}
      {openDrop && <div onClick={() => setOpenDrop("")} style={{ position: "fixed", inset: 0, zIndex: 25 }} />}
      <div className="ctrl-cq" style={{ marginBottom: 9, position: "relative", zIndex: 26 }}>
        <div className="ctrl-row">
          <div className="ctrl-group">
            <span className="ctrl-tag">AI</span>
            <Drop label="AGENT" value={agent} options={agents} minWidth={104} open={openDrop === "agent"}
              onToggle={() => setOpenDrop((d) => (d === "agent" ? "" : "agent"))}
              onPick={(id) => { onAgent(id); setOpenDrop(""); }} />
            {activeAgent?.free ? (
              <Tip text="This turn runs on opencode, not your Claude subscription — the provider's own model, no effort setting, and its work is worth reviewing.">
                <span
                  style={{ ...chip, flex: "none", cursor: "help", color: "var(--warn)",
                           borderColor: "color-mix(in srgb, var(--warn) 40%, transparent)" }}
                >
                  {activeAgent.label.replace("⚡ ", "")}
                </span>
              </Tip>
            ) : (
              <>
                <Drop label="MODEL" value={model} options={models} open={openDrop === "model"}
                  onToggle={() => setOpenDrop((d) => (d === "model" ? "" : "model"))}
                  onPick={(id) => { onModel(id); setOpenDrop(""); }} />
                <Drop label="EFFORT" value={effort} options={EFFORTS} open={openDrop === "effort"}
                  onToggle={() => setOpenDrop((d) => (d === "effort" ? "" : "effort"))}
                  onPick={(id) => { onEffort(id); setOpenDrop(""); }} />
              </>
            )}
            <Drop label="MODE" value={perm} options={PERMS} open={openDrop === "mode"} minWidth={104}
              onToggle={() => setOpenDrop((d) => (d === "mode" ? "" : "mode"))}
              onPick={(id) => { onPerm(id); setOpenDrop(""); }} />
          </div>
          {showPonytail && (
            <div className="ctrl-group">
              <span className="ctrl-tag">PONYTAIL</span>
              <Drop label="PONYTAIL" showLabel={false} value={ponytail} options={PONYTAILS} open={openDrop === "pony"}
                onToggle={() => setOpenDrop((d) => (d === "pony" ? "" : "pony"))}
                onPick={(id) => { onPonytail(id); setOpenDrop(""); }} />
              <Tip text={"PONYTAIL — code-minimalism for this session's runs.\n\nClaude answers as a lazy senior dev: reuse what's already in the repo, stdlib or native platform before a new dependency, shortest diff that works, no speculative abstractions.\n\nOff = normal. Lite → Full → Ultra = increasing pressure to write less code. Default keeps whatever the bridge is configured with."}>
                <button type="button" aria-label="About ponytail"
                  style={{ ...chip, flex: "none", cursor: "help", padding: "3px 6px", marginLeft: -5 }}>ⓘ</button>
              </Tip>
              <button onClick={() => onSend("/ponytail-review", [])} disabled={disabled} title="ponytail review of the working tree"
                style={{ ...chip, flex: "none", cursor: disabled ? "not-allowed" : "pointer", opacity: disabled ? 0.4 : 1 }}>
                REVIEW
              </button>
              <button onClick={() => onSend("/ponytail-audit", [])} disabled={disabled} title="ponytail repo audit"
                style={{ ...chip, flex: "none", cursor: disabled ? "not-allowed" : "pointer", opacity: disabled ? 0.4 : 1 }}>
                AUDIT
              </button>
            </div>
          )}
          {onOpenMap && graph?.available && (
            <div className="ctrl-group">
              <span className="ctrl-tag">GRAPH</span>
              <Tip anchor="right" pin={false}
                text={graph.building
                  ? "Learning your project for better and faster responses. Opens the MAP tab."
                  : graph.exists
                  ? `Project map — built ${ago(graph.built_at)} ago${graph.stale ? ", stale" : ""}. Opens the MAP tab.`
                  : "No project map yet — it builds itself after the first turn. Opens the MAP tab."}>
                <button onClick={onOpenMap}
                  style={{ ...chip, flex: "none", display: "flex", alignItems: "center", gap: 6, ...(graph.building ? { border: "1px solid var(--acc)", color: "var(--acc)" } : null) }}>
                  MAP
                  <span style={{ color: graph.stale && !graph.building ? "var(--warn)" : "inherit" }}>
                    {graph.building ? "LEARNING…" : graph.exists ? ago(graph.built_at) : "—"}
                  </span>
                </button>
              </Tip>
            </div>
          )}
        </div>
      </div>

      {/* command line */}
      <div
        style={{ position: "relative", display: "flex", alignItems: "flex-start", gap: 11, border: `1px solid ${dragging ? "var(--acc)" : "color-mix(in srgb, var(--acc) 18%, transparent)"}`, background: "color-mix(in srgb, var(--panel2) 70%, transparent)", padding: "10px 13px", fontFamily: "'JetBrains Mono',monospace" }}
        onDragOver={(e) => { e.preventDefault(); if (!dragging) setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          const imgs = Array.from(e.dataTransfer.files).filter((f) => f.type.startsWith("image/"));
          if (imgs.length) addFiles(imgs);
        }}
      >
        <span style={{ color: "var(--purple)", fontSize: 13, flex: "none", marginTop: 2 }}>~ ❯</span>
        {mentionOpen && (
          <div style={{ position: "absolute", left: 11, right: 11, bottom: "calc(100% + 6px)", zIndex: 30, maxHeight: 210, overflowY: "auto", border: "1px solid color-mix(in srgb, var(--acc) 26%, transparent)", background: "var(--panel3)", boxShadow: "0 -8px 24px rgba(0,0,0,.35)" }}>
            {hits.map((p, i) => (
              <button
                key={p}
                type="button"
                onMouseDown={(e) => { e.preventDefault(); takeMention(p); }}
                onMouseEnter={() => setMentionPick(i)}
                style={{ appearance: "none", cursor: "pointer", display: "flex", alignItems: "center", gap: 7, width: "100%", textAlign: "left", border: 0, borderLeft: `2px solid ${i === mentionPick ? "var(--acc)" : "transparent"}`, background: i === mentionPick ? "color-mix(in srgb, var(--acc) 10%, transparent)" : "transparent", color: i === mentionPick ? "var(--txb)" : "var(--txh)", fontFamily: "'JetBrains Mono',monospace", fontSize: 11.5, padding: "5px 10px" }}
              >
                <FileIcon name={p} size={12} />
                <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", direction: "rtl", textAlign: "left" }}>{p}</span>
              </button>
            ))}
          </div>
        )}
        <textarea
          ref={taRef}
          value={text}
          onChange={(e) => { setText(e.target.value); setCaret(e.target.selectionStart); }}
          onSelect={(e) => setCaret((e.target as HTMLTextAreaElement).selectionStart)}
          onKeyDown={(e) => {
            if (mentionKey(e)) return;
            if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); }
          }}
          onPaste={(e) => { const imgs = imagesFrom(e.clipboardData?.items); if (imgs.length) { e.preventDefault(); addFiles(imgs); } }}
          placeholder={disabled ? "working…" : running ? "queue a prompt — runs after the current turn…" : "message claude — describe a change, paste an error…"}
          rows={1}
          style={{ flex: 1, minWidth: 0, display: "block", maxHeight: 180, overflowY: "auto", resize: "none", background: "transparent", border: 0, outline: "none", color: "var(--txb)", fontFamily: "'JetBrains Mono',monospace", fontSize: 13, lineHeight: 1.5 }}
        />
        <input ref={fileRef} type="file" accept="image/*" multiple style={{ display: "none" }}
          onChange={(e) => { addFiles(e.target.files); e.target.value = ""; }} />
        <button onClick={() => fileRef.current?.click()} title="Attach image"
          style={{ appearance: "none", cursor: "pointer", border: 0, background: "transparent", color: "var(--txd)", display: "flex", flex: "none", marginTop: 3 }}>
          <Paperclip size={14} strokeWidth={1.8} aria-hidden /></button>
        {running ? (
          <>
            <button onClick={onStop}
              style={{ ...actBtn, border: "1px solid var(--err)", background: "color-mix(in srgb, var(--err) 12%, transparent)", color: "var(--err)" }}>
              STOP <Square size={10} strokeWidth={0} fill="currentColor" aria-hidden /></button>
            {/* The graceful counterpart to STOP: no interrupt, no half-written
                file — the turn lands, then the loop holds. */}
            {onTogglePause && !paused && (
              <button onClick={onTogglePause} title="Let this turn finish, then hold — no queued prompt or goal nudge starts after it"
                style={{ ...actBtn, border: "1px solid var(--warn)", background: "color-mix(in srgb, var(--warn) 10%, transparent)", color: "var(--warn)" }}>
                PAUSE <Pause size={10} strokeWidth={0} fill="currentColor" aria-hidden /></button>
            )}
            {onSteer && (
              <button onClick={steer} disabled={!text.trim()} title="Fold this into the turn that's running now (text only — falls back to queueing if the run just ended)"
                style={{ ...actBtn, cursor: !text.trim() ? "not-allowed" : "pointer", border: "1px solid var(--warn)", background: "color-mix(in srgb, var(--warn) 12%, transparent)", color: "var(--warn)", opacity: !text.trim() ? 0.4 : 1 }}>
                STEER <SteerIcon /></button>
            )}
            <button onClick={submit} disabled={disabled || !text.trim()} title="Queue this prompt to run after the current turn"
              style={{ ...actBtn, cursor: disabled || !text.trim() ? "not-allowed" : "pointer", border: "1px solid var(--purple)", background: "color-mix(in srgb, var(--purple) 12%, transparent)", color: "var(--purple-b)", opacity: disabled || !text.trim() ? 0.4 : 1 }}>
              QUEUE <ChevronsRight size={13} strokeWidth={1.8} aria-hidden /></button>
          </>
        ) : (
          <button onClick={submit} disabled={disabled || !text.trim()}
            style={{ ...actBtn, cursor: disabled || !text.trim() ? "not-allowed" : "pointer", border: "1px solid var(--acc)", background: "color-mix(in srgb, var(--acc) 12%, transparent)", color: "var(--txb)", opacity: disabled || !text.trim() ? 0.4 : 1 }}>
            SEND <ChevronRight size={13} strokeWidth={1.8} aria-hidden /></button>
        )}
      </div>
    </div>
  );
}
