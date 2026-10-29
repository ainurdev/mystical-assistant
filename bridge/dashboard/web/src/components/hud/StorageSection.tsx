import { useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronRight, Lock, Minus, Trash2, TriangleAlert } from "lucide-react";
import { api, type StorageProject, type StorageScan } from "../../api";
import { ago, projectName } from "../../lib/surfaces";
import { ProjectTile } from "../ui/ProjectTile";
import { askConfirm } from "../ui/Ask";
import { fmtBytes } from "./MoveDock";
import { CARD, Section } from "./SettingsModal";

/* SETTINGS ▸ System ▸ Storage: what sessions left on this machine
   (bridge/storage.py), and deleting what you tick. Picked from
   .mystical/design-drafts/clear-caches as B · SYSTEM ▸ STORAGE; A put a row
   on each project's page instead.

   One block: the total, a bar split by project, a row per project with its
   own Clear…, and the move file an import left. Both dialogs list what goes
   with a tick each, biggest first. What the bridge keeps (lessons, reports,
   its own state) is named and never offered. A running session warns rather
   than blocks; in the every-project dialog its project starts unticked.

   Deletes name every entry the dialog showed, never "all": a screenshot a
   session saves after the scan isn't one you saw, so it stays. */

const TOP = 4;        // project rows before "n more"
const FOLD = 6;       // dialog rows before "n more"
const COLS = ["var(--acc)", "color-mix(in oklab, var(--acc) 62%, var(--panel))",
  "color-mix(in oklab, var(--acc) 38%, var(--panel))", "var(--l2)"];
const MOVE_COL = "color-mix(in oklab, var(--warn) 55%, var(--panel))";
const day = (t: number) => new Date(t * 1000).toLocaleDateString(undefined, { month: "short", day: "numeric" });
const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

type Line = { key: string; name: ReactNode; sub?: string; bytes: number; age?: string; tile?: string; chip?: string; mono?: boolean; icon?: boolean };

/** What one project's dialog lists: its .mystical/ entries, its turn pictures, its worktrees. */
function projectLines(p: StorageProject): Line[] {
  const out: Line[] = p.entries.map((e) => ({ key: `e:${e.name}`, name: e.name + (e.dir ? "/" : ""), mono: true, bytes: e.bytes, age: ago(e.mtime) }));
  if (p.pictures.bytes) out.push({ key: "pics", name: "Turn pictures", sub: `from ${plural(p.pictures.count, "turn")}`, bytes: p.pictures.bytes, age: ago(p.pictures.mtime) });
  if (p.worktrees.bytes) out.push({ key: "wt", name: `In ${plural(p.worktrees.count, "worktree")}`, sub: "their .mystical/", bytes: p.worktrees.bytes });
  return out.sort((a, b) => b.bytes - a.bytes);
}

function Tick({ on }: { on: boolean | "some" }) {
  return <span className="stg-tick" data-on={on || undefined}>{on === "some" ? <Minus size={11} strokeWidth={3.2} /> : on ? <Check size={11} strokeWidth={3.2} /> : null}</span>;
}

function LineRow({ l, on, max, onTick }: { l: Line; on: boolean; max: number; onTick: () => void }) {
  return (
    <button type="button" role="checkbox" aria-checked={on} className="stg-line" data-off={!on || undefined} data-tile={l.tile !== undefined || l.icon || undefined} onClick={onTick}>
      <Tick on={on} />
      {(l.tile !== undefined || l.icon) && <span className="stg-tile">{l.icon ? <Trash2 size={13} aria-hidden /> : <ProjectTile project={l.tile} />}</span>}
      <span className="stg-nm">{l.mono ? <code>{l.name}</code> : <span>{l.name}</span>}{l.sub && <small>{l.sub}</small>}</span>
      <span className="stg-rb"><i style={{ width: `${Math.max(2, (l.bytes / max) * 100)}%` }} /></span>
      <span className="stg-sz">{fmtBytes(l.bytes)}</span>
      {l.chip ? <span className="stg-chip">{l.chip}</span> : <span className="stg-ag">{l.age}</span>}
    </button>
  );
}

/** The tick list both deletes ask through: AskDialog's frame, a row per thing
 *  with its size, the long tail folded into one row you can open. */
function ClearDialog({ title, about, lines, after = [], start, stays, warn, onClose, onDelete }: {
  title: string; about: ReactNode; lines: Line[]; after?: Line[]; start: string[]; stays: ReactNode; warn?: string;
  onClose: () => void; onDelete: (keys: Set<string>) => Promise<void>;
}) {
  const [on, setOn] = useState(() => new Set(start));
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const all = [...lines, ...after];
  const max = Math.max(1, ...all.map((l) => l.bytes));
  const head = lines.length > FOLD + 1 && !open ? lines.slice(0, FOLD) : lines;
  const rest = lines.slice(head.length);
  const restOn = rest.filter((l) => on.has(l.key)).length;
  const tiled = lines.some((l) => l.tile !== undefined || l.icon);
  const flip = (keys: string[], to: boolean) => setOn((s) => { const n = new Set(s); keys.forEach((k) => (to ? n.add(k) : n.delete(k))); return n; });
  const sum = all.filter((l) => on.has(l.key)).reduce((s, l) => s + l.bytes, 0);
  const off = all.length - all.filter((l) => on.has(l.key)).length;
  const close = () => { if (!busy) onClose(); };
  const go = async () => {
    setBusy(true);
    try { await onDelete(on); } finally { setBusy(false); }
  };
  return createPortal(
    <div className="stg-back" onClick={close}>
      <div role="dialog" aria-modal aria-labelledby="stg-title" className="panel ask stg stg-dlg" onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); close(); } }}>
        <div>
          <div id="stg-title" className="stg-title">{title}</div>
          <div className="stg-about">{about}</div>
        </div>
        <div className="stg-list">
          {head.map((l) => <LineRow key={l.key} l={l} on={on.has(l.key)} max={max} onTick={() => flip([l.key], !on.has(l.key))} />)}
          {rest.length > 0 && (
            <div className="stg-line stg-more" data-off={!restOn || undefined} data-tile={tiled || undefined}>
              <button type="button" role="checkbox" aria-checked={restOn === rest.length ? true : restOn ? "mixed" : false} aria-label={`all ${rest.length} more`}
                onClick={() => flip(rest.map((l) => l.key), restOn < rest.length)}>
                <Tick on={restOn === rest.length ? true : restOn ? "some" : false} />
              </button>
              {tiled && <span className="stg-tile" />}
              <button type="button" className="stg-nm" aria-expanded={false} onClick={() => setOpen(true)} title="show each of them">
                <span>{rest.length} more</span><ChevronRight size={12} aria-hidden /><small>{rest.slice(0, 3).map((l) => (typeof l.name === "string" ? l.name : "")).join(" · ")} …</small>
              </button>
              <span className="stg-rb"><i style={{ width: `${Math.max(2, (rest.reduce((s, l) => s + l.bytes, 0) / max) * 100)}%` }} /></span>
              <span className="stg-sz">{fmtBytes(rest.reduce((s, l) => s + l.bytes, 0))}</span>
              <span className="stg-ag" />
            </div>
          )}
          {after.map((l) => <LineRow key={l.key} l={l} on={on.has(l.key)} max={max} onTick={() => flip([l.key], !on.has(l.key))} />)}
        </div>
        <div className="stg-kept"><Lock size={12} aria-hidden />{stays}</div>
        {warn && <div className="stg-warn"><TriangleAlert size={13} aria-hidden /><span>{warn}</span></div>}
        <div className="stg-foot">
          <span>{off ? `${off} unticked · ` : ""}deleted for good, not to the Trash</span>
          <button type="button" className="act-alt neutral caps" onClick={close} autoFocus>Cancel</button>
          <button type="button" className="act-pri caps danger" disabled={!sum || busy} onClick={() => void go()}>
            {busy ? "Deleting…" : `Delete ${fmtBytes(sum)}`}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/** SETTINGS ▸ System, above Bridge. */
export function StorageSection() {
  const [scan, setScan] = useState<StorageScan | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [more, setMore] = useState(false);
  const [dlg, setDlg] = useState<StorageProject | "all" | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const load = () => api.storage().then((r) => { setScan(r); setErr(null); }).catch((e: Error) => setErr(e.message));
  useEffect(() => { void load(); }, []);

  const clear = async (...args: Parameters<typeof api.clearStorage>) => {
    try {
      const r = await api.clearStorage(...args);
      setDone(`Freed ${fmtBytes(r.freed)}${r.errors.length ? ` · ${plural(r.errors.length, "thing")} couldn't go: ${r.errors[0]}` : ""}`);
    } catch (e) {
      setDone(`Nothing was deleted: ${(e as Error).message}`);
    }
    setDlg(null);
    await load();
  };

  let body: ReactNode;
  if (err === "not found") body = <div className="stg-note">Restart the bridge to read its storage: it is older than this page.</div>;
  else if (err) body = <div className="stg-note" data-k="warn">Couldn&apos;t read storage: {err}</div>;
  else if (!scan) body = <div className="stg-note">Reading what sessions left…</div>;
  else if (!scan.bytes) body = <div className="stg-note">Nothing to clear: no project has files from its sessions.{done && ` ${done}.`}</div>;
  else {
    const ps = scan.projects, rows = more || ps.length <= TOP + 1 ? ps : ps.slice(0, TOP), rest = ps.slice(rows.length);
    const max = Math.max(1, ...ps.map((p) => p.bytes), ...scan.move_files.map((f) => f.bytes));
    const restBytes = (n: number) => ps.slice(n).reduce((s, p) => s + p.bytes, 0);
    const moveBytes = scan.move_files.reduce((s, f) => s + f.bytes, 0);
    const parts: [string, number, string][] = [
      ...ps.slice(0, 3).map((p, i): [string, number, string] => [projectName(p.project), p.bytes, COLS[i]]),
      ...(ps.length > 3 ? [["the rest", restBytes(3), COLS[3]] as [string, number, string]] : []),
      ...(moveBytes ? [[scan.move_files.length > 1 ? "move files" : "the last move's file", moveBytes, MOVE_COL] as [string, number, string]] : []),
    ];
    const bar = (b: number, col: string) => <span className="stg-rb"><i style={{ width: `${Math.max(2, (b / max) * 100)}%`, background: col }} /></span>;
    body = (
      <>
        <div className="stg-sum">
          <b>{fmtBytes(scan.bytes)}</b>
          <span>in {plural(ps.length, "project")}{scan.move_files.length ? ` and ${plural(scan.move_files.length, "move file")}` : ""}</span>
          <button type="button" className="ps-btn" onClick={() => setDlg("all")}><Trash2 size={13} aria-hidden />Clear all…</button>
        </div>
        {done && <div className="stg-note" data-k="done">{done}</div>}
        <div className="stg-stack" aria-hidden>{parts.map(([n, b, c]) => <i key={n} style={{ width: `${(b / scan.bytes) * 100}%`, background: c }} />)}</div>
        <div className="stg-legend">{parts.map(([n, b, c]) => <span key={n}><i style={{ background: c }} />{n} {fmtBytes(b)}</span>)}</div>
        {rows.map((p, i) => (
          <div key={p.project} className="stg-row">
            <span className="stg-tile"><ProjectTile project={p.project} /></span>
            <span className="stg-nm"><span>{projectName(p.project)}</span>{p.running > 0 && <span className="stg-chip" title={`${plural(p.running, "session")} running here`}>RUNNING</span>}</span>
            {bar(p.bytes, COLS[Math.min(i, 3)])}
            <span className="stg-sz">{fmtBytes(p.bytes)}</span>
            <button type="button" className="ps-btn" onClick={() => setDlg(p)}>Clear…</button>
          </div>
        ))}
        {rest.length > 0 && (
          <div className="stg-row">
            <span className="stg-tile" />
            <span className="stg-nm"><span>{rest.length} more</span><small>{rest.slice(0, 3).map((p) => projectName(p.project)).join(" · ")} …</small></span>
            {bar(restBytes(rows.length), COLS[3])}
            <span className="stg-sz">{fmtBytes(restBytes(rows.length))}</span>
            <button type="button" className="ps-btn" onClick={() => setMore(true)}>Show</button>
          </div>
        )}
        {scan.move_files.map((f) => (
          <div key={f.path} className="stg-row">
            <span className="stg-tile stg-dim"><Trash2 size={13} aria-hidden /></span>
            <span className="stg-nm" title={f.path}><span>The last move&apos;s file</span><small>from {f.from}, {day(f.mtime)}</small></span>
            {bar(f.bytes, MOVE_COL)}
            <span className="stg-sz">{fmtBytes(f.bytes)}</span>
            <button type="button" className="ps-btn" onClick={async () => {
              if (await askConfirm(`Delete the move file from ${f.from}? It is the ${fmtBytes(f.bytes)} file the import of ${day(f.mtime)} left; MOVE ▸ Import can't read it again after this.`, { ok: "Delete", danger: true }))
                await clear([], [f.path]);
            }}>Delete…</button>
          </div>
        ))}
      </>
    );
  }

  const p = dlg && dlg !== "all" ? dlg : null;
  const kept = p?.kept.filter((k) => k.name !== ".gitignore") ?? [];
  return (
    <Section title="STORAGE">
      <div style={CARD} className="stg">{body}</div>
      {p && (
        <ClearDialog key={p.project} title={`Clear ${projectName(p.project)}'s Mystical files?`}
          about={<>What its sessions left behind: scratch, drafts and screenshots in <code>.mystical/</code>, and the pictures its turns took. Untick what you still use.</>}
          lines={projectLines(p)} start={projectLines(p).map((l) => l.key)}
          stays={kept.length ? <>Stays: {kept.map((k) => <code key={k.name}>{k.name}{k.dir ? "/" : ""}</code>)}<span>the bridge&apos;s own, {fmtBytes(kept.reduce((s, k) => s + k.bytes, 0))}</span></>
            : <>Stays: what the bridge keeps there (lessons, reports, its own state)</>}
          warn={p.running ? `${plural(p.running, "session")} ${p.running === 1 ? "is" : "are"} running here. What ${p.running === 1 ? "it is" : "they are"} writing now may be in these folders.` : undefined}
          onClose={() => setDlg(null)}
          onDelete={(on) => clear([{ project: p.project, entries: p.entries.filter((e) => on.has(`e:${e.name}`)).map((e) => e.name),
            pictures: on.has("pics"), worktrees: on.has("wt") }])} />
      )}
      {dlg === "all" && scan && (
        <ClearDialog title="Clear Mystical files in every project?"
          about={<>{fmtBytes(scan.bytes)}: what sessions left in {plural(scan.projects.length, "project")}&apos; <code>.mystical/</code> folders, their turn pictures{scan.move_files.length ? ", and the last move's file" : ""}. A project with a running session starts unticked.</>}
          lines={scan.projects.map((x) => ({ key: `p:${x.project}`, tile: x.project, name: projectName(x.project), bytes: x.bytes, chip: x.running ? "RUNNING" : undefined }))}
          after={scan.move_files.map((f) => ({ key: `m:${f.path}`, icon: true, name: "Last move's file", sub: day(f.mtime), bytes: f.bytes }))}
          start={[...scan.projects.filter((x) => !x.running).map((x) => `p:${x.project}`), ...scan.move_files.map((f) => `m:${f.path}`)]}
          stays={<>Stays everywhere: <code>learn/</code><code>docs/</code><code>tasks.json</code><code>dev.log</code></>}
          onClose={() => setDlg(null)}
          onDelete={(on) => clear(
            scan.projects.filter((x) => on.has(`p:${x.project}`)).map((x) => ({ project: x.project, entries: x.entries.map((e) => e.name), pictures: true, worktrees: true })),
            scan.move_files.filter((f) => on.has(`m:${f.path}`)).map((f) => f.path))} />
      )}
    </Section>
  );
}
