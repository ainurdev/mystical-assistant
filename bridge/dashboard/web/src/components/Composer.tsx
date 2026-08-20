import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { ChevronRight, ChevronsRight, Merge, Paperclip, Pause, Square } from "lucide-react";
import { api, type EffortLevel, type GraphState, type ModelId, type SlashCommand, type UsageInfo } from "../api";
import { modelRows, type AgentOption } from "../models";
import { ago } from "../lib/surfaces";
import { ImageLightbox, ZoomButton } from "./ImageLightbox";
import { FileIcon } from "../lib/fileicon";
import { applyMention, mentionAt, rankPaths, type Mention } from "../lib/mention";
import { isExact, rankCommands, slashAt } from "../lib/slash";
import { Tip } from "./ui/Tip";

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
// The context readout is a segmented instrument, not a track: eight lamps read
// as fast as a bar at a tenth of the width, and the width is the point — the
// old full-bleed bar spent a whole row of the composer to render "1%".
const CTX_SEGMENTS = 8;
const PONYTAIL_TIP = "PONYTAIL — code-minimalism for this session's runs.\n\nClaude answers as a lazy senior dev: reuse what's already in the repo, stdlib or native platform before a new dependency, shortest diff that works, no speculative abstractions.\n\nOff = normal. Lite → Full → Ultra = increasing pressure to write less code. Default keeps whatever the bridge is configured with.";

// Exported for the status bar, which offers the same AGENT pick from the footer.
export function Drop<T extends string>({
  label, code, value, options, open, onToggle, onPick, minWidth = 78,
}: {
  label: string;
  // A 3-letter field code printed inside the chip. The name of the field then
  // travels with the control instead of sitting beside it as a separate span,
  // which is what let the layout ladder shed it exactly when the row got tight
  // enough that you could no longer tell the five dropdowns apart.
  code?: string;
  value: T;
  // short → what the chip shows; group → a heading printed once above each run
  // of rows sharing it; tail → right-aligned decoration (the model meters)
  options: { id: T; label: string; short?: string; group?: string; tail?: ReactNode; title?: string }[];
  open: boolean;
  onToggle: () => void;
  onPick: (id: T) => void;
  minWidth?: number;
}) {
  const cur = options.find((o) => o.id === value) ?? options[0];
  if (!cur) return null;                 // nothing to pick from yet (still loading)
  // min-width rides a custom property so the tight end of the layout ladder can
  // drop it to 0 (inline styles win over any stylesheet rule otherwise).
  const btn: CSSProperties = {
    appearance: "none", cursor: "pointer", border: "1px solid color-mix(in srgb, var(--acc) 25%, transparent)",
    background: "color-mix(in srgb, var(--panel2) 60%, transparent)", color: "var(--txh)", fontFamily: "inherit",
    fontSize: "var(--t95)", letterSpacing: ".3px", display: "flex",
    alignItems: "center", gap: code ? 7 : 10, justifyContent: code ? "flex-start" : "space-between",
    padding: code ? "4px 8px 4px 5px" : "4px 9px",
    ["--dw" as string]: `${minWidth}px`,
  };
  return (
    <div style={{ position: "relative", display: "flex", alignItems: "center", gap: 6 }}>
      <button className="drop-btn" onClick={onToggle} title={`${label} — ${cur.label}`} style={btn}>
        {code && <span className="ctrl-fld">{code}</span>}
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: code ? 1 : undefined }}>{cur.short ?? cur.label}</span>
        <span style={{ color: code ? "var(--txl)" : "var(--txd)", fontSize: "var(--t8)", flex: "none" }}>▾</span>
      </button>
      {open && (
        <div
          style={{
            // max-content: the menu sizes to its longest row instead of wrapping
            // labels inside the chip-wide box that positions it.
            position: "absolute", bottom: "calc(100% + 5px)", left: 0, minWidth: 132, width: "max-content",
            zIndex: 30, border: "1px solid color-mix(in srgb, var(--acc) 35%, transparent)", background: "color-mix(in srgb, var(--panel2) 98%, transparent)",
            boxShadow: "0 -8px 26px var(--shadow-pop)", animation: "mpop .12s ease",
          }}
        >
          {options.map((o, i) => {
            const on = o.id === value;
            const heading = o.group && o.group !== options[i - 1]?.group ? o.group : null;
            return (
              <Fragment key={o.id}>
                {heading && (
                  <div style={{
                    fontSize: "var(--t8)", letterSpacing: 1, color: "var(--txd)", whiteSpace: "nowrap",
                    padding: i ? "10px 11px 4px" : "8px 11px 4px",
                    borderBottom: "1px solid color-mix(in srgb, var(--acc) 8%, transparent)",
                  }}>
                    {heading}
                  </div>
                )}
                <button
                  onClick={() => onPick(o.id)}
                  title={o.title}
                  style={{
                    width: "100%", appearance: "none", cursor: "pointer", border: 0,
                    borderBottom: "1px solid color-mix(in srgb, var(--acc) 8%, transparent)",
                    background: on ? "color-mix(in srgb, var(--acc) 10%, transparent)" : "transparent",
                    color: on ? "var(--txb)" : "var(--txm)", fontFamily: "inherit", fontSize: "var(--t105)",
                    letterSpacing: ".3px", textAlign: "left", padding: "8px 11px",
                    display: "flex", alignItems: "center", gap: 8, whiteSpace: "nowrap",
                  }}
                >
                  <span style={{ width: 8, color: "var(--acc)", flex: "none" }}>{on ? "✓" : ""}</span>
                  <span style={{ flex: 1 }}>{o.label}</span>
                  {o.tail}
                </button>
              </Fragment>
            );
          })}
        </div>
      )}
    </div>
  );
}

// A model row's fuel gauge in the MODEL menu: how much of its tightest usage
// window is still unspent (fill = left, so a full bar is a full tank), in the
// same track/fill idiom as the status bar's USED meter.
function LeftMeter({ left, severity }: { left: number; severity?: string }) {
  const c = severity === "critical" || severity === "exceeded" ? "var(--err)"
    : severity && severity !== "normal" ? "var(--warn)" : "var(--acc)";
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 7, marginLeft: 18, color: c, flex: "none" }}>
      <span style={{ width: 44, height: 3, background: "color-mix(in srgb, var(--acc) 12%, transparent)", position: "relative", overflow: "hidden" }}>
        <span style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: `${left}%`, background: c }} />
      </span>
      <span style={{ minWidth: 30, textAlign: "right", fontSize: "var(--t9)", letterSpacing: .5 }}>{left}%</span>
    </span>
  );
}

function fmtTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k`;
  return `${n}`;
}

// Shared look for the small action chips (REVIEW / AUDIT / MAP, and COMPACT on the context line).
const chip: CSSProperties = {
  appearance: "none", cursor: "pointer", border: "1px solid color-mix(in srgb, var(--acc) 20%, transparent)",
  background: "transparent", color: "var(--txd)", fontFamily: "inherit", fontSize: "var(--t9)",
  letterSpacing: 1, padding: "3px 8px",
};

// Steering folds text into the turn already in flight. Merge rotated a quarter
// turn: two strands come in from the left and leave as one, pointing forward.
export function SteerIcon({ size = 13 }: { size?: number }) {
  return <Merge size={size} strokeWidth={1.8} style={{ transform: "rotate(90deg)", flex: "none" }} aria-hidden />;
}

export function Composer({
  disabled, running, model, models, usage, agent, agents, onAgent, effort, perm, onPerm, ponytail, onPonytail, showPonytail, injectedText, injectNonce, sessionId,
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
  // The ambient login's usage meter — the MODEL menu shows what each model has left.
  usage?: UsageInfo | null;
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
  onSteer?: (text: string, images: string[]) => void;
  onStop: () => void;
  onCompact?: (instructions?: string) => void;
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
  const [openDrop, setOpenDrop] = useState<"" | "agent" | "model" | "effort" | "mode" | "pony" | "verbs">("");
  // A free agent brings its own model and has no effort knob, so those two
  // dropdowns would be lying about what runs — swap them for what actually will.
  const activeAgent = agents.find((a) => a.id === agent);
  // MODEL rows grouped by usage pool, each with what it has left. The meter is
  // the ambient login's, so it only decorates the rows while that login is the
  // one running the turns; another account gets the plain list.
  const modelOpts = useMemo(
    () => modelRows(models, !activeAgent || activeAgent.def ? usage : null).map((r) => ({
      ...r, tail: r.left === undefined ? undefined : <LeftMeter left={r.left} severity={r.severity} />,
    })),
    [models, usage, activeAgent],
  );
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

  /** Splice `ins` over the word under the caret (an `@query` or a `/command`)
   *  and put the caret after it. */
  function splice(m: Mention, ins: string) {
    const next = applyMention(text, m, caret, ins);
    setText(next.text);
    requestAnimationFrame(() => {
      const el = taRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(next.caret, next.caret);
      setCaret(next.caret);
    });
  }
  function takeMention(path: string) {
    if (mention) splice(mention, path);
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

  // --- /commands -----------------------------------------------------------
  // A leading `/` opens the command list, as the CLI's own input does — skills,
  // custom commands, plugins, the CLI's bundled ones. Re-read each time it
  // opens: a local scan of a few dozen files, and a skill installed from the
  // SKILLS tab a moment ago should already be in it.
  const [cmds, setCmds] = useState<SlashCommand[]>([]);
  // A bridge still running pre-restart code has no commands route; with nothing
  // ever loaded the list says so rather than silently never opening.
  const [cmdsStale, setCmdsStale] = useState(false);
  const [slashPick, setSlashPick] = useState(0);
  const [slashDismissed, setSlashDismissed] = useState(false);
  const slash = slashAt(text, caret);
  const slashOn = slash !== null;
  useEffect(() => {
    if (!slashOn) { setSlashDismissed(false); return; }
    let live = true;
    void api.commands(project)
      .then((r) => { if (live) { setCmds(r.commands); setCmdsStale(false); } })
      .catch(() => { if (live) setCmdsStale(true); });
    return () => { live = false; };
  }, [slashOn, project]);
  const shits = slash ? rankCommands(cmds, slash.q) : [];
  const slashOpen = !!slash && !slashDismissed && (shits.length > 0 || cmdsStale);
  useEffect(() => { setSlashPick(0); }, [slash?.q]);
  const slashListRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    slashListRef.current?.querySelector<HTMLElement>('[data-on="1"]')?.scrollIntoView({ block: "nearest" });
  }, [slashPick, slashOpen]);

  /** Arrow/Tab belong to the command list while it's open. Enter takes the
   *  highlighted command unless it's already what you typed — then it sends,
   *  as `/compact` + Enter should. Escape closes it until the `/` is gone. */
  function slashKey(e: React.KeyboardEvent): boolean {
    if (!slashOpen) return false;
    if (e.key === "Escape") { e.preventDefault(); setSlashDismissed(true); return true; }
    if (!shits.length) return false;          // only the restart note is showing
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      setSlashPick((p) => (p + (e.key === "ArrowDown" ? 1 : shits.length - 1)) % shits.length);
      return true;
    }
    const pick = shits[slashPick] ?? shits[0];
    if (e.key === "Tab" || (e.key === "Enter" && !isExact(pick, slash!.q))) {
      e.preventDefault();
      splice(slash!, `/${pick.name}`);
      return true;
    }
    return false;
  }

  // --- Ctrl+R: reverse prompt search ---------------------------------------
  // Shell muscle memory, over every session's prompts rather than this one's:
  // the prompt worth re-running is usually one you wrote somewhere else. Re-read
  // on each open, not once per mount: a few hundred short strings off localhost,
  // and anything else would miss the prompt you sent a minute ago.
  const [rsearch, setRsearch] = useState<string | null>(null);
  const [rpick, setRpick] = useState(0);
  const [history, setHistory] = useState<string[]>([]);
  const rOpen = rsearch !== null;
  useEffect(() => {
    if (!rOpen) return;
    void api.promptHistory().then((r) => setHistory(r.prompts)).catch(() => { /* keep the last list */ });
  }, [rOpen]);
  const rhits = rsearch === null
    ? []
    : history.filter((p) => p.toLowerCase().includes(rsearch.toLowerCase())).slice(0, 8);
  useEffect(() => { setRpick(0); }, [rsearch]);

  /** Put a past prompt in the box — to edit before sending, as `!!` would. */
  function takeHistory(p: string) {
    setText(p);
    setRsearch(null);
    requestAnimationFrame(() => taRef.current?.focus());
  }

  function rsearchKey(e: React.KeyboardEvent) {
    const step = (d: number) => {
      e.preventDefault();
      setRpick((p) => (rhits.length ? (p + d + rhits.length) % rhits.length : 0));
    };
    if (e.key === "Escape") { e.preventDefault(); setRsearch(null); taRef.current?.focus(); return; }
    if (e.key === "Enter") { e.preventDefault(); if (rhits[rpick]) takeHistory(rhits[rpick]); return; }
    // Ctrl+R again walks the matches, the way holding it in a shell does.
    if (e.key === "ArrowDown" || (e.key === "r" && e.ctrlKey)) return step(1);
    if (e.key === "ArrowUp") return step(-1);
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

  // Land the text — and anything in the attachment tray — in the turn that's
  // already running.
  function steer() {
    const t = text.trim();
    if (!t || !onSteer) return;
    onSteer(t, images);
    setText("");
    setImages([]);
  }

  const ctx = contextTokens ?? 0;
  const ctxPct = Math.min(100, Math.round((ctx / CONTEXT_MAX_TOKENS) * 100));
  const suggest = ctx >= COMPACT_SUGGEST_TOKENS;
  const ctxSegs = Math.min(CTX_SEGMENTS, Math.ceil((ctxPct / 100) * CTX_SEGMENTS));
  // The meter is teal until the window is actually filling. Colour that is
  // always on is colour that says nothing.
  const ctxColor = ctxPct >= 85 ? "var(--err)" : suggest ? "var(--warn)" : "var(--acc)";

  // The verb tier as data, so the row and the ··· overflow it collapses into
  // render the same list from the same handlers.
  const verbs: {
    key: string; label: string; stamp?: string; stampTone?: string; hot?: boolean;
    tip: string; anchor?: "right"; disabled?: boolean; onClick: () => void;
  }[] = [
    {
      key: "grill",
      label: "GRILL",
      tip: "GRILL — a relentless interview before any code gets written.\n\nIt asks one question at a time until every open branch of the decision is closed, then you have something worth building from.\n\nType first to grill a specific idea; leave the box empty to grill the conversation so far.\n\nNeeds a grill skill installed — SKILLS ▸ PLUGINS.",
      disabled,
      onClick: () => { const t = text.trim(); setText(""); onSend(t ? `/grill-me ${t}` : "/grill-me", []); },
    },
    {
      key: "design",
      label: "DESIGN",
      tip: "DESIGN — design before code.\n\nSends the box to /design-first: Claude drafts the screens with the design system, screenshots them into the transcript, pushes the draft to the linked Claude Design project, and waits for your approval before implementing.\n\nNeeds text in the box; syncing needs a linked design project (◇ DESIGN SYSTEM in the chat header).",
      disabled: disabled || !text.trim(),
      onClick: () => { const t = text.trim(); if (!t) return; onSend(`/design-first ${t}`, images); setText(""); setImages([]); },
    },
    ...(showPonytail ? [
      { key: "review", label: "REVIEW", tip: "REVIEW — /ponytail-review over the working tree: what in this diff can be deleted, reused, or replaced by stdlib.", disabled, onClick: () => onSend("/ponytail-review", []) },
      { key: "audit", label: "AUDIT", tip: "AUDIT — /ponytail-audit over the whole repo: a ranked list of what to delete, simplify, or replace with a native equivalent.", disabled, onClick: () => onSend("/ponytail-audit", []) },
    ] : []),
    ...(onOpenMap && graph?.available ? [{
      key: "map",
      label: "MAP",
      stamp: graph.building ? "LEARNING…" : graph.exists ? ago(graph.built_at) : "—",
      stampTone: graph.stale && !graph.building ? "var(--warn)" : undefined,
      hot: graph.building,
      anchor: "right" as const,
      tip: graph.building
        ? "Learning your project for better and faster responses. Opens the MAP tab."
        : graph.exists
        ? `Project map — built ${ago(graph.built_at)} ago${graph.stale ? ", stale" : ""}. Opens the MAP tab.`
        : "No project map yet — it builds itself after the first turn. Opens the MAP tab.",
      onClick: onOpenMap,
    }] : []),
  ];

  return (
    <div style={{ flex: "none", borderTop: "1px solid color-mix(in srgb, var(--acc) 14%, transparent)", padding: "11px 16px" }}>
      {/* Paused: shown even when idle, because that's exactly when you can't tell
          from the transcript that the queue and the goal loop are being held. */}
      {paused && (
        <div style={{ display: "flex", alignItems: "center", gap: 9, marginBottom: 9, padding: "5px 9px", border: "1px solid color-mix(in srgb, var(--warn) 34%, transparent)", background: "color-mix(in srgb, var(--warn) 8%, transparent)" }}>
          <Pause size={11} strokeWidth={0} fill="var(--warn)" aria-hidden style={{ flex: "none" }} />
          <span style={{ fontSize: "var(--t10)", letterSpacing: 1, color: "var(--warn)", flex: "none" }}>PAUSED</span>
          <span style={{ fontSize: "var(--t105)", color: "var(--txl)", flex: 1, minWidth: 0 }}>
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
          <span style={{ fontSize: "var(--t10)", letterSpacing: 1, color: "var(--purple)", flex: "none" }}>QUEUED · {queued.length}</span>
          {queued.map((q) => (
            <span key={q.id} title={q.text}
              style={{ display: "inline-flex", alignItems: "center", gap: 6, maxWidth: 240, border: "1px solid color-mix(in srgb, var(--purple) 30%, transparent)", background: "color-mix(in srgb, var(--purple) 8%, transparent)", color: "var(--purple-h)", fontSize: "var(--t10)", letterSpacing: 0.5, padding: "2px 6px" }}>
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{q.text}</span>
              {onEjectQueued && (
                <button onClick={() => onEjectQueued(q.id)} title="Run in a new session"
                  style={{ appearance: "none", cursor: "pointer", border: 0, background: "transparent", color: "var(--purple)", fontSize: "var(--t11)", lineHeight: 1, padding: 0, flex: "none" }}>↗</button>
              )}
              {onCancelQueued && (
                <button onClick={() => onCancelQueued(q.id)} title="Remove from queue"
                  style={{ appearance: "none", cursor: "pointer", border: 0, background: "transparent", color: "var(--purple)", fontSize: "var(--t11)", lineHeight: 1, padding: 0, flex: "none" }}>✕</button>
              )}
            </span>
          ))}
        </div>
      )}
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
                style={{ position: "absolute", right: -6, top: -6, width: 18, height: 18, display: "flex", alignItems: "center", justifyContent: "center", border: "1px solid color-mix(in srgb, var(--acc) 40%, transparent)", background: "var(--panel3)", color: "var(--txd)", fontSize: "var(--t11)", lineHeight: 1, cursor: "pointer" }}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}

      {/* session controls — one line, two tiers. SETTINGS (what the next turn
          *is*) keep a box and carry their own field code, so no width can shed
          the name off a control. VERBS (things that fire now) have no box at
          all: bare tracked text reads as a command, a box reads as a setting,
          which is the distinction the old 12%-alpha fences were failing to
          make. The context meter closes the row as an instrument rather than
          spending a whole row of its own on a track that is empty most of the
          time. Layout ladder lives in index.css. */}
      {openDrop && <div onClick={() => setOpenDrop("")} style={{ position: "fixed", inset: 0, zIndex: 25 }} />}
      <div className="ctrl-cq" style={{ marginBottom: 9, position: "relative", zIndex: 26 }}>
        <div className="ctrl-row">
          <div className="ctrl-set">
            <Drop label="AGENT" code="ACT" value={agent} options={agents} minWidth={104} open={openDrop === "agent"}
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
                <Drop label="MODEL" code="MDL" value={model} options={modelOpts} open={openDrop === "model"}
                  onToggle={() => setOpenDrop((d) => (d === "model" ? "" : "model"))}
                  onPick={(id) => { onModel(id); setOpenDrop(""); }} />
                <Drop label="EFFORT" code="EFF" value={effort} options={EFFORTS} open={openDrop === "effort"}
                  onToggle={() => setOpenDrop((d) => (d === "effort" ? "" : "effort"))}
                  onPick={(id) => { onEffort(id); setOpenDrop(""); }} />
              </>
            )}
            <Drop label="MODE" code="MOD" value={perm} options={PERMS} open={openDrop === "mode"} minWidth={104}
              onToggle={() => setOpenDrop((d) => (d === "mode" ? "" : "mode"))}
              onPick={(id) => { onPerm(id); setOpenDrop(""); }} />
            {showPonytail && (
              <Tip text={PONYTAIL_TIP} pin={false}>
                <Drop label="PONYTAIL" code="PNY" value={ponytail} options={PONYTAILS} open={openDrop === "pony"}
                  onToggle={() => setOpenDrop((d) => (d === "pony" ? "" : "pony"))}
                  onPick={(id) => { onPonytail(id); setOpenDrop(""); }} />
              </Tip>
            )}
          </div>
          {/* One verb list, rendered twice: inline across the row, and inside
              the ··· popover the container query swaps in once the row runs out
              of width. A narrow composer loses where the verbs sit, never what
              they are called — five unlabelled icons would be worse than none. */}
          <div className="ctrl-verbs">
            {verbs.map((v) => (
              <Tip key={v.key} text={v.tip} anchor={v.anchor} pin={false}>
                <button className="ctrl-verb" onClick={v.onClick} disabled={v.disabled}
                  style={v.hot ? { color: "var(--acc)" } : undefined}>
                  {v.label}
                  {v.stamp && <span className="stamp" style={v.stampTone ? { color: v.stampTone } : undefined}>{v.stamp}</span>}
                </button>
              </Tip>
            ))}
            <button className="ctrl-more" onClick={() => setOpenDrop((d) => (d === "verbs" ? "" : "verbs"))}
              title="More actions">···</button>
            {openDrop === "verbs" && (
              <div style={{
                position: "absolute", bottom: "calc(100% + 6px)", left: 0, minWidth: 158, width: "max-content", zIndex: 30,
                border: "1px solid color-mix(in srgb, var(--acc) 35%, transparent)",
                background: "color-mix(in srgb, var(--panel2) 98%, transparent)",
                boxShadow: "0 -8px 26px var(--shadow-pop)", animation: "mpop .12s ease",
              }}>
                {verbs.map((v) => (
                  <button key={v.key} onClick={() => { setOpenDrop(""); v.onClick(); }} disabled={v.disabled} title={v.tip}
                    style={{
                      width: "100%", appearance: "none", cursor: v.disabled ? "not-allowed" : "pointer", border: 0,
                      borderBottom: "1px solid color-mix(in srgb, var(--acc) 8%, transparent)",
                      background: "transparent", color: "var(--txm)", fontFamily: "inherit", fontSize: "var(--t105)",
                      letterSpacing: 1.4, textAlign: "left", padding: "7px 11px", opacity: v.disabled ? 0.4 : 1,
                      display: "flex", alignItems: "center", gap: 10, whiteSpace: "nowrap",
                    }}>
                    <span style={{ flex: 1 }}>{v.label}</span>
                    {v.stamp && <span style={{ color: v.stampTone ?? "var(--txl)", letterSpacing: .6 }}>{v.stamp}</span>}
                  </button>
                ))}
              </div>
            )}
          </div>
          {/* CONTEXT as an instrument: eight segments that only recolour when
              the window is actually filling, and a COMPACT that only exists
              past the point where pressing it is the right call. */}
          <div className="ctrl-ctx" title={`Context — ${ctxPct}% of ${CONTEXT_MAX_TOKENS / 1000}k${ctx > 0 ? ` (~${fmtTokens(ctx)} tokens)` : ""}`}>
            <span className="lbl">CTX</span>
            <span className="seg">
              {Array.from({ length: CTX_SEGMENTS }, (_, i) => (
                <i key={i} style={i < ctxSegs ? { background: ctxColor } : undefined} />
              ))}
            </span>
            <span style={{ color: suggest ? ctxColor : "var(--txd)", fontSize: "var(--t10)", letterSpacing: .5, flex: "none" }}>{ctxPct}%</span>
            {suggest && ctx > 0 && <span style={{ flex: "none" }}>~{fmtTokens(ctx)}</span>}
            {suggest && onCompact && (
              // Whatever is in the box rides along as compaction instructions ("keep
              // the auth work, drop the log spelunking") — Piebald opens a dialog for
              // this; we already have a text box right there.
              <button onClick={() => { onCompact(text.trim()); setText(""); }} disabled={disabled || running}
                title={text.trim()
                  ? "Compact the context, keeping what you've typed in mind"
                  : "Compact context (/compact) — type first to steer what the summary keeps"}
                style={{ ...chip, flex: "none", cursor: disabled || running ? "not-allowed" : "pointer",
                         opacity: disabled || running ? 0.4 : 1, border: `1px solid ${ctxColor}`, color: ctxColor }}>
                COMPACT
              </button>
            )}
          </div>
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
        <span style={{ color: "var(--purple)", fontSize: "var(--t13)", flex: "none", marginTop: 2 }}>~ ❯</span>
        {rsearch !== null && (
          <div style={{ position: "absolute", left: 11, right: 11, bottom: "calc(100% + 6px)", zIndex: 31, border: "1px solid color-mix(in srgb, var(--purple) 34%, transparent)", background: "var(--panel3)", boxShadow: "0 -8px 24px rgba(0,0,0,.35)" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 7, padding: "6px 10px", borderBottom: "1px solid color-mix(in srgb, var(--acc) 10%, transparent)" }}>
              <span style={{ flex: "none", fontSize: "var(--t9)", letterSpacing: 1, color: "var(--purple)" }}>REVERSE-I-SEARCH</span>
              <input
                autoFocus
                value={rsearch}
                onChange={(e) => setRsearch(e.target.value)}
                onKeyDown={rsearchKey}
                onBlur={() => setRsearch(null)}
                placeholder="a prompt you wrote before…"
                style={{ flex: 1, minWidth: 0, background: "transparent", border: 0, outline: "none", color: "var(--txb)", fontFamily: "'JetBrains Mono',monospace", fontSize: "var(--t12)" }}
              />
              <span style={{ flex: "none", fontSize: "var(--t9)", color: "var(--txd)" }}>
                {rhits.length ? `${rpick + 1}/${rhits.length}` : "no match"}
              </span>
            </div>
            <div style={{ maxHeight: 210, overflowY: "auto" }}>
              {rhits.map((p, i) => (
                <button
                  key={p}
                  type="button"
                  onMouseDown={(e) => { e.preventDefault(); takeHistory(p); }}
                  onMouseEnter={() => setRpick(i)}
                  title={p}
                  style={{ appearance: "none", cursor: "pointer", display: "block", width: "100%", textAlign: "left", border: 0, borderLeft: `2px solid ${i === rpick ? "var(--purple)" : "transparent"}`, background: i === rpick ? "color-mix(in srgb, var(--purple) 10%, transparent)" : "transparent", color: i === rpick ? "var(--txb)" : "var(--txh)", fontFamily: "'JetBrains Mono',monospace", fontSize: "var(--t115)", padding: "5px 10px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                >
                  {p.replace(/\s+/g, " ")}
                </button>
              ))}
            </div>
          </div>
        )}
        {slashOpen && (
          <div ref={slashListRef} style={{ position: "absolute", left: 11, right: 11, bottom: "calc(100% + 6px)", zIndex: 30, maxHeight: 240, overflowY: "auto", border: "1px solid color-mix(in srgb, var(--acc) 26%, transparent)", background: "var(--panel3)", boxShadow: "0 -8px 24px rgba(0,0,0,.35)" }}>
            {shits.length === 0 ? (
              <div style={{ padding: "6px 10px", fontSize: "var(--t10)", letterSpacing: .5, color: "var(--txd)" }}>
                the bridge needs a restart before it can list commands
              </div>
            ) : shits.map((c, i) => (
              <button
                key={c.name}
                type="button"
                data-on={i === slashPick ? 1 : 0}
                onMouseDown={(e) => { e.preventDefault(); splice(slash!, `/${c.name}`); }}
                onMouseEnter={() => setSlashPick(i)}
                title={c.description}
                style={{ appearance: "none", cursor: "pointer", display: "flex", alignItems: "center", gap: 10, width: "100%", textAlign: "left", border: 0, borderLeft: `2px solid ${i === slashPick ? "var(--acc)" : "transparent"}`, background: i === slashPick ? "color-mix(in srgb, var(--acc) 10%, transparent)" : "transparent", color: i === slashPick ? "var(--txb)" : "var(--txh)", fontFamily: "'JetBrains Mono',monospace", fontSize: "var(--t115)", padding: "5px 10px" }}
              >
                <span style={{ flex: "none", color: "var(--acc)" }}>/{c.name}</span>
                <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--txl)" }}>{c.description}</span>
                <span style={{ flex: "none", fontSize: "var(--t8)", letterSpacing: 1, color: "var(--txd)" }}>{c.scope === "builtin" ? "CLI" : c.scope.toUpperCase()}</span>
              </button>
            ))}
          </div>
        )}
        {mentionOpen && (
          <div style={{ position: "absolute", left: 11, right: 11, bottom: "calc(100% + 6px)", zIndex: 30, maxHeight: 210, overflowY: "auto", border: "1px solid color-mix(in srgb, var(--acc) 26%, transparent)", background: "var(--panel3)", boxShadow: "0 -8px 24px rgba(0,0,0,.35)" }}>
            {hits.map((p, i) => (
              <button
                key={p}
                type="button"
                onMouseDown={(e) => { e.preventDefault(); takeMention(p); }}
                onMouseEnter={() => setMentionPick(i)}
                style={{ appearance: "none", cursor: "pointer", display: "flex", alignItems: "center", gap: 7, width: "100%", textAlign: "left", border: 0, borderLeft: `2px solid ${i === mentionPick ? "var(--acc)" : "transparent"}`, background: i === mentionPick ? "color-mix(in srgb, var(--acc) 10%, transparent)" : "transparent", color: i === mentionPick ? "var(--txb)" : "var(--txh)", fontFamily: "'JetBrains Mono',monospace", fontSize: "var(--t115)", padding: "5px 10px" }}
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
            if (mentionKey(e) || slashKey(e)) return;
            // Ctrl+R is the browser's reload; in the command line it's the shell's
            // history search, which is what the hands in this box expect.
            if (e.key === "r" && e.ctrlKey) { e.preventDefault(); setRsearch(""); return; }
            if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); }
          }}
          onPaste={(e) => { const imgs = imagesFrom(e.clipboardData?.items); if (imgs.length) { e.preventDefault(); addFiles(imgs); } }}
          placeholder={disabled ? "working…" : running ? "queue a prompt — runs after the current turn…" : "message claude — describe a change, paste an error…"}
          rows={1}
          style={{ flex: 1, minWidth: 0, display: "block", maxHeight: 180, overflowY: "auto", resize: "none", background: "transparent", border: 0, outline: "none", color: "var(--txb)", fontFamily: "'JetBrains Mono',monospace", fontSize: "var(--t13)", lineHeight: 1.5 }}
        />
        <input ref={fileRef} type="file" accept="image/*" multiple style={{ display: "none" }}
          onChange={(e) => { addFiles(e.target.files); e.target.value = ""; }} />
        <button onClick={() => fileRef.current?.click()} title="Attach image"
          style={{ appearance: "none", cursor: "pointer", border: 0, background: "transparent", color: "var(--txd)", display: "flex", flex: "none", marginTop: 3 }}>
          <Paperclip size={14} strokeWidth={1.8} aria-hidden /></button>
        {/* Exactly one primary. STOP and PAUSE are rare and modal and one of
            them is destructive, so they sit as recessive glyphs and only take
            their colour when you reach for them — their labels live in the
            tooltip. STEER is the alternate target for the same text, so it
            stays an outline. QUEUE/SEND is what Enter does, so it is the only
            filled control on the line. */}
        {running ? (
          <>
            <button className="act-glyph stop" onClick={onStop} aria-label="Stop"
              title="STOP — interrupt this turn now">
              <Square size={11} strokeWidth={0} fill="currentColor" aria-hidden /></button>
            {/* The graceful counterpart to STOP: no interrupt, no half-written
                file — the turn lands, then the loop holds. It keeps its armed
                state here so the banner is confirmation, not the only tell. */}
            {onTogglePause && (
              <button className={`act-glyph hold${paused ? " armed" : ""}`} onClick={onTogglePause}
                aria-label={paused ? "Resume" : "Pause"}
                title={paused
                  ? "PAUSED — nothing starts after this turn. Click to resume."
                  : "PAUSE — let this turn finish, then hold; no queued prompt or goal nudge starts after it"}>
                <Pause size={11} strokeWidth={0} fill="currentColor" aria-hidden /></button>
            )}
            <span className="act-fence" aria-hidden />
            {onSteer && (
              <button className="act-alt" onClick={steer} disabled={!text.trim()}
                title="STEER — fold this into the turn that's running now (falls back to queueing if the run just ended)">
                STEER <SteerIcon /></button>
            )}
            <button className="act-pri queue" onClick={submit} disabled={disabled || !text.trim()}
              title="QUEUE — run this prompt after the current turn (Enter)">
              QUEUE <ChevronsRight size={13} strokeWidth={1.8} aria-hidden /></button>
          </>
        ) : (
          <button className="act-pri" onClick={submit} disabled={disabled || !text.trim()}>
            SEND <ChevronRight size={13} strokeWidth={1.8} aria-hidden /></button>
        )}
      </div>
    </div>
  );
}
