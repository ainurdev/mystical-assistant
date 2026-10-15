/** MOVE's progress dock: one card per export, read or import job, floating in a
 *  corner over the whole dashboard (bridge/movejob.py runs them). A card folds
 *  to a PILL, an EDGE line along the window's top, or a FRAME square, and its
 *  bar draws as LINE, BLOCKS, ASCII or SWEEP — all per MOVE ▸ PROGRESS.
 *
 *  The jobs live in the bridge, so the dock only reads: once on load (a reload
 *  reattaches to a running job), every second while one runs, and whenever the
 *  MOVE tab says it started or dismissed one (MOVE_EVENT). A bridge older than
 *  this bundle has no /local/move routes, so the first read fails and the dock
 *  stays empty rather than drawing a broken card.
 *
 *  ponytail: polling, not the SSE stream. One small GET a second, and only while
 *  a job runs; move it onto pubsub if a second consumer ever wants these events. */
import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import {
  Ban, CircleCheck, CircleX, FileSearch, HardDriveDownload, HardDriveUpload, Minus, X,
  type LucideIcon,
} from "lucide-react";
import { api, MOVE_EVENT, type MoveJob, type MoveNext } from "../../api";
import type { HudSettings } from "../../lib/theme";
import { notify } from "./Notifications";
import { chime, push } from "../../lib/push";
import { openSettings } from "../../lib/opensettings";
import { restartBridge } from "../../lib/restart";
import { askConfirm } from "../ui/Ask";

// How the dock draws. These were thirteen Settings rows (MOVE ▸ PROGRESS) that
// nobody moved off their defaults; the defaults are the dock now.
export type MoveBar = "line" | "blocks" | "ascii" | "sweep";
export type MoveThick = "thin" | "regular" | "thick";
export type MoveColor = "acc" | "ok" | "purple" | "info" | "warn";
export interface MovePrefs {
  bar: MoveBar; thick: MoveThick; exportColor: MoveColor; importColor: MoveColor;
  corner: "tl" | "tr" | "bl" | "br"; mini: "pill" | "edge" | "frame";
  steps: boolean; log: boolean; eta: boolean; speed: boolean;
  startMin: boolean; autoHide: boolean; motion: boolean;
}
const PREFS: MovePrefs = {
  bar: "line", thick: "regular", exportColor: "acc", importColor: "purple", corner: "br",
  mini: "pill", steps: true, log: true, eta: true, speed: true,
  startMin: false, autoHide: true, motion: true,
};

export const MOVE_COLORS: Record<MoveColor, string> = {
  acc: "var(--acc)", ok: "var(--ok)", purple: "var(--purple)", info: "var(--info)", warn: "var(--warn)",
};
export const THICK: Record<MoveThick, number> = { thin: 2, regular: 5, thick: 9 };

export function fmtBytes(n: number | null | undefined): string {
  if (!n) return "0 B";
  const u = ["B", "KB", "MB", "GB"];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${i < 2 ? Math.round(n) : n.toFixed(n < 10 ? 1 : 0)} ${u[i]}`;
}
export function fmtDur(s: number): string {
  s = Math.max(0, Math.round(s));
  return s < 60 ? `${s} s` : s < 3600 ? `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`
    : `${Math.floor(s / 3600)} h ${Math.round((s % 3600) / 60)} min`;
}
const about = (s: number) => (s < 60 ? `${Math.max(5, Math.round(s / 5) * 5)} s` : `${Math.round(s / 60)} min`);

/** The bar, in whichever of the four styles PROGRESS picked. */
export function Bar({ style, pct, color, h, cells = 32, chars = 28, motion = true }: {
  style: MoveBar; pct: number; color: string; h: number; cells?: number; chars?: number; motion?: boolean;
}) {
  const p = Math.max(0, Math.min(100, pct));
  const track = `color-mix(in srgb, ${color} 10%, transparent)`;
  if (style === "blocks") {
    const full = Math.floor((p / 100) * cells);
    const half = (p / 100) * cells - full >= 0.35;
    return (
      <div role="progressbar" aria-valuenow={Math.round(p)} style={{ display: "flex", gap: 2, height: h, flex: 1, minWidth: 0 }}>
        {Array.from({ length: cells }, (_, i) => (
          <i key={i} style={{
            flex: 1,
            background: i < full ? color : i === full && half ? `color-mix(in srgb, ${color} 45%, transparent)` : track,
            boxShadow: i < full ? `0 0 5px color-mix(in srgb, ${color} 35%, transparent)` : undefined,
          }} />
        ))}
      </div>
    );
  }
  if (style === "ascii") {
    const n = Math.round((p / 100) * chars);
    return (
      <div role="progressbar" aria-valuenow={Math.round(p)} style={{
        fontFamily: "var(--mono)", fontSize: "var(--t11)", lineHeight: 1, whiteSpace: "pre",
        overflow: "hidden", flex: 1, minWidth: 0, color: "var(--txg)",
      }}>
        <span style={{ color: "var(--txd)" }}>[</span>
        <span style={{ color }}>{"█".repeat(n)}</span>{"·".repeat(chars - n)}
        <span style={{ color: "var(--txd)" }}>]</span>
      </div>
    );
  }
  return (
    <div role="progressbar" aria-valuenow={Math.round(p)} style={{ position: "relative", height: h, background: track, flex: 1, minWidth: 0 }}>
      <i
        className={style === "sweep" && motion ? "movesweep" : undefined}
        style={{
          position: "absolute", left: 0, top: 0, bottom: 0, width: `${p}%`, transition: "width .4s ease",
          background: style === "sweep"
            ? `linear-gradient(90deg, ${color} 0%, ${color} 35%, color-mix(in srgb, ${color} 35%, #fff) 50%, ${color} 65%, ${color} 100%) 40% 0 / 300% 100%`
            : color,
          boxShadow: `0 0 8px color-mix(in srgb, ${color} 45%, transparent)`,
        }}
      />
    </div>
  );
}

const ICON: Record<string, LucideIcon> = { export: HardDriveUpload, import: HardDriveDownload, read: FileSearch };
const STATE_ICON: Record<string, LucideIcon> = { done: CircleCheck, failed: CircleX, cancelled: Ban };
const HINT: Record<string, string> = {
  export: "deletes the partial file", import: "stops after this repo", read: "nothing here has changed yet",
};

export function jobColor(job: Pick<MoveJob, "kind" | "status">, prefs: MovePrefs): string {
  if (job.status === "failed") return "var(--err)";
  if (job.status === "cancelled") return "var(--txd)";
  if (job.status === "done") return "var(--ok)";
  return MOVE_COLORS[job.kind === "export" ? prefs.exportColor : prefs.importColor];
}

const BTN: CSSProperties = {
  appearance: "none", cursor: "pointer", border: "1px solid color-mix(in srgb, var(--acc) 25%, transparent)",
  background: "transparent", color: "var(--tx)", fontFamily: "inherit", fontSize: "var(--t9)",
  letterSpacing: 1, padding: "3px 8px", flex: "none", whiteSpace: "nowrap",
};
function Btn({ children, onClick, danger, ghost }: { children: ReactNode; onClick: () => void; danger?: boolean; ghost?: boolean }) {
  return (
    <button onClick={onClick} style={{
      ...BTN,
      ...(danger ? { borderColor: "color-mix(in srgb, var(--err) 45%, transparent)", color: "var(--err)" } : {}),
      ...(ghost ? { borderColor: "transparent", color: "var(--txd)" } : {}),
    }}>{children}</button>
  );
}

/** What a finished import leaves the user: its name, and the button that does
 *  it. Shared with MOVE ▸ IMPORT's WHAT'S LEFT so the two never disagree. */
export function nextLabel(n: MoveNext): string {
  const k = n.items?.length ?? 0;
  return {
    restart: "Restart the bridge",
    mcp: `Sign in to ${k} MCP server${k === 1 ? "" : "s"}`,
    rivendell: "Turn Rivendell on",
    delete: `Delete the move file${n.bytes ? ` (${fmtBytes(n.bytes)})` : ""}`,
    parked: "Some of it was parked",
  }[n.key];
}
export function nextAction(n: MoveNext): [string, () => void, boolean?] {
  return {
    restart: ["RESTART", () => void restartBridge()] as [string, () => void],
    mcp: ["OPEN MCP ▸", () => openSettings("mcp")] as [string, () => void],
    rivendell: ["OPEN PLUGINS ▸", () => openSettings("plugins")] as [string, () => void],
    delete: ["DELETE", () => {
      void askConfirm(`Delete ${n.path}? It holds your .env files and tokens; this can't be undone.`)
        .then((ok) => ok && api.moveDelete(n.path ?? "").then(() => window.dispatchEvent(new Event(MOVE_EVENT)),
          (e: Error) => notify("error", `Couldn't delete the move file — ${e.message}`)));
    }, true] as [string, () => void, boolean],
    parked: ["COPY PATH", () => void navigator.clipboard?.writeText(n.path ?? "")] as [string, () => void],
  }[n.key];
}

function NextRow({ n, i }: { n: MoveNext; i: number }) {
  const [label, act, danger] = nextAction(n);
  return (
    <div title={n.text} style={{ display: "flex", alignItems: "center", gap: 8, padding: "5px 0", borderTop: "1px solid color-mix(in srgb, var(--acc) 10%, transparent)" }}>
      <span style={{ fontFamily: "var(--mono)", fontSize: "var(--t9)", color: "var(--purple)", width: 10 }}>{i + 1}</span>
      <span style={{ fontSize: "var(--t95)", color: "var(--tx)", flex: 1, minWidth: 0 }}>{nextLabel(n)}</span>
      <Btn onClick={act} danger={danger}>{label.replace(" ▸", "")}</Btn>
    </div>
  );
}

/** One job, open. `preview` draws it without anything that acts (PROGRESS). */
export function JobCard({ job, prefs, onMin, onClose, preview }: {
  job: MoveJob; prefs: MovePrefs; onMin?: () => void; onClose?: () => void; preview?: boolean;
}) {
  const c = jobColor(job, prefs);
  const running = job.status === "running";
  const Icon = (running ? ICON[job.kind] : STATE_ICON[job.status]) ?? ICON[job.kind];
  const h = THICK[prefs.thick];
  const left = job.next ?? [];
  const retry = () => {
    const go = job.kind === "export" ? api.moveExport(job.out ?? "", job.skip ?? [])
      : job.kind === "read" ? api.moveStartRead(job.file ?? "") : api.moveImport(job.skip ?? []);
    void go.then(() => { onClose?.(); window.dispatchEvent(new Event(MOVE_EVENT)); },
      (e: Error) => notify("error", `Couldn't start it again — ${e.message}`));
  };
  const meta: string[] = [];
  if (prefs.speed && job.bytes) meta.push(`${fmtBytes(job.bytes)}${job.kind === "read" && job.total ? ` of ${fmtBytes(job.total)}` : job.kind === "export" ? " written" : ""}${job.rate ? ` · ${fmtBytes(job.rate)}/s` : ""}`);
  if (prefs.eta) meta.push(`${fmtDur(job.elapsed)} in${job.eta != null ? ` · about ${about(job.eta)} left` : ""}`);
  return (
    <div className="panel" style={{
      width: 330, border: "1px solid color-mix(in srgb, var(--acc) 32%, transparent)",
      background: "color-mix(in srgb, var(--panel2) 97%, transparent)",
      boxShadow: `0 -8px 26px rgba(0,0,0,.65), 0 0 26px color-mix(in srgb, ${c} 8%, transparent)`,
      animation: preview ? undefined : "mpop .3s cubic-bezier(.2,.8,.2,1)",
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "9px 9px 8px 12px", color: c }}>
        <Icon size={13} strokeWidth={1.7} aria-hidden style={{ flex: "none" }} />
        <span style={{ fontSize: "var(--t95)", letterSpacing: 2, flex: "none" }}>{job.kind.toUpperCase()}</span>
        <span title={job.title} style={{ fontFamily: "var(--mono)", fontSize: "var(--t9)", color: "var(--txd)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", minWidth: 0, flex: 1 }}>
          {job.title}
        </span>
        {!running && (
          <span style={{ fontSize: "var(--t8)", letterSpacing: 1, padding: "1px 6px", border: `1px solid color-mix(in srgb, ${c} 35%, transparent)`, background: `color-mix(in srgb, ${c} 11%, transparent)`, color: c, flex: "none" }}>
            {job.status.toUpperCase()}
          </span>
        )}
        {!preview && (running ? onMin : onClose) && (
          <button aria-label={running ? "minimize" : "dismiss"} onClick={running ? onMin : onClose} style={{ ...BTN, width: 20, height: 20, padding: 0, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--txd)", borderColor: "color-mix(in srgb, var(--acc) 16%, transparent)" }}>
            {running ? <Minus size={12} /> : <X size={12} />}
          </button>
        )}
      </div>
      <div style={{ padding: "0 12px 12px" }}>
        {running ? (
          <div style={{ display: "flex", alignItems: "baseline", gap: 8, margin: "2px 0 8px" }}>
            <span className="glow" style={{ fontSize: "var(--t26)", color: "var(--txb)", lineHeight: 1 }}>
              {Math.floor(job.pct)}<small style={{ fontSize: "var(--t12)", color: "var(--txd)", marginLeft: 1 }}>%</small>
            </span>
            <span style={{ marginLeft: "auto", fontSize: "var(--t9)", letterSpacing: 1, color: "var(--txd)", lineHeight: 1.6, textAlign: "right" }}>
              {meta.map((m) => <div key={m}>{m}</div>)}
            </span>
          </div>
        ) : (
          <div style={{ fontSize: "var(--t95)", color: "var(--txm)", lineHeight: 1.6, margin: "2px 0 10px" }}>
            {job.status === "failed" ? <><span style={{ color: "var(--err)" }}>{job.error}</span>{job.kind === "export" ? ". The partial file was deleted." : ""}</>
              : job.status === "cancelled" ? (job.kind === "import" ? "Stopped. What's in stays; importing the same file again skips it and finishes the rest." : "Stopped; nothing was kept.")
              : job.kind === "export" ? <>Saved {fmtBytes(job.result?.bytes)} to <span style={{ fontFamily: "var(--mono)" }}>{job.out}</span>, in {fmtDur(job.elapsed)}.</>
              : job.kind === "read" ? "Read. Pick what comes in on MOVE ▸ IMPORT."
              : `Done in ${fmtDur(job.elapsed)}.`}
          </div>
        )}
        <Bar style={prefs.bar} pct={job.status === "done" ? 100 : job.pct} color={c} h={running ? h : Math.min(h, 3)} motion={prefs.motion && running} />
        {running && prefs.steps && (
          <div style={{ marginTop: 11, display: "flex", flexDirection: "column", gap: 5 }}>
            {job.steps.filter((s) => s.state !== "skipped").map((s) => (
              <div key={s.key} style={{ display: "grid", gridTemplateColumns: "58px 1fr 40px", alignItems: "center", columnGap: 8 }}>
                <span style={{ fontSize: "var(--t9)", letterSpacing: 1.5, color: s.state === "queued" ? "var(--txl)" : s.state === "done" ? "var(--txm)" : "var(--txd)" }}>{s.key.toUpperCase()}</span>
                {s.state === "running" ? (
                  <Bar style={prefs.bar === "ascii" ? "line" : prefs.bar} pct={s.key === "unpack" ? job.pct / .85 : s.total ? (100 * s.done) / s.total : 0} color={c} h={3} cells={20} motion={prefs.motion} />
                ) : (
                  <span style={{ fontSize: "var(--t9)", letterSpacing: 1, color: s.state === "queued" ? "var(--txg)" : "var(--txd)", fontFamily: s.state === "done" ? "var(--mono)" : undefined }}>
                    {s.state === "queued" ? "QUEUED" : s.total ? `${s.done} of ${s.total}` : ""}
                  </span>
                )}
                <span style={{ fontFamily: "var(--mono)", fontSize: "var(--t9)", textAlign: "right", color: s.state === "done" ? "var(--ok)" : s.state === "queued" ? "var(--txl)" : "var(--txm)" }}>
                  {s.state === "done" ? "✓" : s.state === "queued" ? "—" : s.total ? `${s.done}/${s.total}` : ""}
                </span>
                {s.state === "running" && job.now.length > 0 && (
                  <span style={{ gridColumn: "2 / 4", fontFamily: "var(--mono)", fontSize: "var(--t9)", color: "var(--txd)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", marginTop: 3 }}>
                    <b style={{ fontWeight: 400, color: "var(--tx)" }}>{job.now[0]}</b>{job.now.length > 1 ? ` +${job.now.length - 1}` : ""}
                  </span>
                )}
              </div>
            ))}
          </div>
        )}
        {running && prefs.log && job.log.length > 0 && (
          <div style={{ marginTop: 10, borderTop: "1px dashed color-mix(in srgb, var(--acc) 14%, transparent)", paddingTop: 7, fontFamily: "var(--mono)", fontSize: "var(--t9)", lineHeight: 1.7 }}>
            {job.log.slice(-4).map((l, i, a) => (
              <div key={`${i}${l}`} style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", color: i === a.length - 1 ? "var(--tx)" : "var(--txd)" }}>
                {l}
                {i === a.length - 1 && prefs.motion && <span style={{ display: "inline-block", width: 5, height: 9, background: c, marginLeft: 3, verticalAlign: -1, animation: "blink 1s steps(1) infinite" }} />}
              </div>
            ))}
          </div>
        )}
        {!preview && (
          <div style={{ marginTop: 11 }}>
            {running ? (
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <Btn danger onClick={() => void api.moveCancel()}>CANCEL</Btn>
                <span style={{ fontSize: "var(--t9)", color: "var(--txl)" }}>{HINT[job.kind]}</span>
                <span style={{ flex: 1 }} />
              </div>
            ) : job.kind === "import" && job.status === "done" && left.length > 0 ? (
              <div>
                <div style={{ fontSize: "var(--t9)", letterSpacing: 2, color: "var(--txd)", marginBottom: 4 }}>
                  {left.length} THING{left.length === 1 ? "" : "S"} LEFT
                </div>
                {left.map((n, i) => <NextRow key={n.key} n={n} i={i} />)}
              </div>
            ) : (
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                {(job.status === "failed" || job.status === "cancelled") && (
                  <Btn onClick={retry}>{job.kind === "import" ? "▸ IMPORT AGAIN" : "↻ RETRY"}</Btn>
                )}
                {job.kind === "export" && job.status === "done" && job.out && (
                  <Btn onClick={() => void navigator.clipboard?.writeText(job.out ?? "")}>COPY PATH</Btn>
                )}
                {job.kind === "read" && job.status === "done" && <Btn onClick={() => openSettings("move")}>REVIEW ▸</Btn>}
                <span style={{ flex: 1 }} />
                <Btn ghost onClick={() => onClose?.()}>DISMISS</Btn>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/** A folded card as a chip in the dock. */
export function Pill({ job, prefs, onOpen }: { job: MoveJob; prefs: MovePrefs; onOpen?: () => void }) {
  const c = jobColor(job, prefs);
  const Icon = (job.status === "running" ? ICON[job.kind] : STATE_ICON[job.status]) ?? ICON[job.kind];
  return (
    <button onClick={onOpen} title="open" style={{
      appearance: "none", cursor: onOpen ? "pointer" : "default", display: "inline-flex", alignItems: "center", gap: 8,
      border: "1px solid color-mix(in srgb, var(--acc) 32%, transparent)", background: "color-mix(in srgb, var(--panel2) 97%, transparent)",
      padding: "6px 9px 6px 10px", color: c, fontFamily: "inherit",
      boxShadow: `0 -6px 20px rgba(0,0,0,.6), 0 0 18px color-mix(in srgb, ${c} 8%, transparent)`,
    }}>
      <Icon size={12} strokeWidth={1.7} aria-hidden />
      <span style={{ fontSize: "var(--t9)", letterSpacing: 2 }}>{job.kind.toUpperCase()}</span>
      <span style={{ fontFamily: "var(--mono)", fontSize: "var(--t10)", color: "var(--txb)" }}>
        {job.status === "running" ? `${Math.floor(job.pct)}%` : job.status === "done" ? "✓" : job.status.toUpperCase()}
      </span>
      {job.status === "running" && (
        <span style={{ width: 80, display: "flex" }}>
          <Bar style={prefs.bar === "ascii" ? "blocks" : prefs.bar} pct={job.pct} color={c} h={5} cells={12} motion={prefs.motion} />
        </span>
      )}
      {job.status === "running" && prefs.eta && job.eta != null && (
        <span style={{ fontFamily: "var(--mono)", fontSize: "var(--t9)", color: "var(--txd)" }}>~{about(job.eta)}</span>
      )}
    </button>
  );
}

/** A folded card as a square whose edge is the bar. */
export function Frame({ job, prefs, onOpen, size = 38 }: { job: MoveJob; prefs: MovePrefs; onOpen?: () => void; size?: number }) {
  const c = jobColor(job, prefs);
  const pct = job.status === "done" ? 100 : Math.floor(job.pct);
  const e = size - 3;
  return (
    <button onClick={onOpen} title={`${job.kind} ${pct}%`} aria-label={`${job.kind} ${pct}%`} style={{ appearance: "none", border: 0, padding: 0, background: "none", cursor: onOpen ? "pointer" : "default", display: "flex" }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        {/* Colours as style, not attributes: WebKit (Mystical.app) won't resolve var() in an SVG attribute. */}
        <rect x="1.5" y="1.5" width={e} height={e} strokeWidth="2" style={{ fill: "var(--panel2)", stroke: `color-mix(in srgb, ${c} 14%, transparent)` }} />
        <rect x="1.5" y="1.5" width={e} height={e} strokeWidth="2" pathLength={100} strokeDasharray={`${pct} 100`} style={{ fill: "none", stroke: c, filter: `drop-shadow(0 0 3px ${c})` }} />
        <text x={size / 2} y={size / 2 + 4} textAnchor="middle" fontFamily="JetBrains Mono, monospace" fontSize={size > 30 ? 11 : 9} style={{ fill: "var(--txb)" }}>
          {job.status === "running" ? pct : job.status === "done" ? "✓" : "!"}
        </text>
      </svg>
    </button>
  );
}

const MINI_KEY = "hud-move-mini";
function loadMini(): Record<string, boolean> {
  try { return JSON.parse(localStorage.getItem(MINI_KEY) || "{}") as Record<string, boolean>; } catch { return {}; }
}

const CORNER: Record<MovePrefs["corner"], CSSProperties> = {
  br: { right: 60, bottom: 44, alignItems: "flex-end" },
  bl: { left: 14, bottom: 44, alignItems: "flex-start" },
  tr: { right: 60, top: 56, alignItems: "flex-end" },
  tl: { left: 14, top: 56, alignItems: "flex-start" },
};

/** Mounted once by App. */
export function MoveDock({ settings }: { settings: HudSettings }) {
  const prefs = PREFS;
  const [jobs, setJobs] = useState<MoveJob[]>([]);
  const [mini, setMini] = useState<Record<string, boolean>>(loadMini);
  const seen = useRef<Map<string, string>>(new Map());
  const first = useRef(true);
  const timer = useRef<number | undefined>(undefined);
  const hiding = useRef<Set<string>>(new Set());

  const setFold = useCallback((id: string, v: boolean) => {
    setMini((m) => {
      const next = { ...m, [id]: v };
      try { localStorage.setItem(MINI_KEY, JSON.stringify(next)); } catch { /* ignore */ }
      return next;
    });
  }, []);
  const dismiss = useCallback((id: string) => {
    setJobs((js) => js.filter((j) => j.id !== id));
    void api.moveDismiss(id).catch(() => undefined);
  }, []);

  const poll = useCallback(() => {
    window.clearTimeout(timer.current);
    void api.moveJobs().then(({ jobs: js }) => {
      setJobs(js);
      if (js.some((j) => j.status === "running")) timer.current = window.setTimeout(poll, 1000);
    }, () => undefined);   // an older bridge: no routes, no dock
  }, []);

  useEffect(() => {
    poll();
    window.addEventListener(MOVE_EVENT, poll);
    return () => { window.removeEventListener(MOVE_EVENT, poll); window.clearTimeout(timer.current); };
  }, [poll]);

  // A job that ends while this tab watches is news: a toast, the OS banner and
  // the NOTIFY sound, the same channels a finished session uses. Jobs already
  // finished when the tab opened aren't.
  useEffect(() => {
    for (const j of jobs) {
      const was = seen.current.get(j.id);
      seen.current.set(j.id, j.status);
      if (first.current) continue;
      if (was === undefined && j.status === "running" && prefs.startMin && mini[j.id] === undefined) setFold(j.id, true);
      if (was !== "running" || j.status === "running") continue;
      const what = `${j.kind.toUpperCase()} ${j.status === "done" ? "finished" : j.status}`;
      const body = j.status === "failed" ? j.error ?? "" : j.title;
      notify(j.status === "failed" ? "error" : "info", `${what} — ${body}`, () => openSettings("move"));
      if (settings.push) push(`${j.status === "done" ? "✓" : "✘"} ${what}`, body, `move-${j.id}`, () => openSettings("move"));
      if (j.status === "done" && settings.pushSound) chime(settings.pushTone, settings.pushVolume);
    }
    first.current = false;
    // Hide-after-success: only a clean finish with nothing left for you to do.
    if (prefs.autoHide) {
      for (const j of jobs) {
        if (j.status === "done" && !(j.next?.length) && !hiding.current.has(j.id)) {
          hiding.current.add(j.id);
          window.setTimeout(() => dismiss(j.id), Math.max(0, 10000 - (Date.now() / 1000 - (j.ended ?? 0)) * 1000));
        }
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `mini` is read, not watched: folding is not news
  }, [jobs, prefs.autoHide, prefs.startMin, settings.push, settings.pushSound, settings.pushVolume, settings.pushTone, dismiss, setFold]);

  if (!jobs.length) return null;
  const folded = (j: MoveJob) => mini[j.id] ?? false;
  const edge = prefs.mini === "edge" ? jobs.find((j) => j.status === "running" && folded(j)) : undefined;
  const ec = edge ? jobColor(edge, prefs) : "";
  return (
    <>
      {edge && (
        <>
          <div style={{ position: "fixed", left: 0, top: 0, height: 2, width: `${edge.pct}%`, background: ec, boxShadow: `0 0 8px ${ec}`, zIndex: 96, transition: "width .4s ease", pointerEvents: "none" }} />
          <button onClick={() => setFold(edge.id, false)} style={{ position: "fixed", top: 2, right: 60, zIndex: 96, appearance: "none", cursor: "pointer", fontFamily: "inherit", fontSize: "var(--t8)", letterSpacing: 1.5, color: ec, border: `1px solid color-mix(in srgb, ${ec} 35%, transparent)`, borderTop: 0, padding: "1px 6px", background: "var(--panel2)" }}>
            {edge.kind.toUpperCase()} {Math.floor(edge.pct)}%
          </button>
        </>
      )}
      <div style={{ position: "fixed", zIndex: 72, display: "flex", flexDirection: "column", gap: 8, pointerEvents: "none", ...CORNER[prefs.corner] }}>
        {jobs.filter((j) => j !== edge).map((j) => (
          <div key={j.id} style={{ pointerEvents: "auto" }}>
            {!folded(j) ? (
              <JobCard job={j} prefs={prefs} onMin={() => setFold(j.id, true)} onClose={() => dismiss(j.id)} />
            ) : prefs.mini === "frame" ? (
              <Frame job={j} prefs={prefs} onOpen={() => setFold(j.id, false)} />
            ) : (
              <Pill job={j} prefs={prefs} onOpen={() => setFold(j.id, false)} />
            )}
          </div>
        ))}
      </div>
    </>
  );
}
