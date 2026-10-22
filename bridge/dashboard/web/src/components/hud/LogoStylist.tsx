/* STYLE WITH AI on SETTINGS ▸ Projects (docs/superpowers/specs/logo-stylist.md):
   the toolbar's button, the strip under it, each row's end while a run is on,
   and the right pane: what the stylist is looking at while it runs, and what it
   changed and why once it's done. The run itself is lib/stylerun's; the bell
   draws the same run (Notifications.tsx). */

import { useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowRight, Check, ScanEye, Sparkles, Undo2, X } from "lucide-react";
import type { AccountInfo, ProjectMark, StyleCandidate, StyleRun } from "../../api";
import { loginWindows } from "../../models";
import { slotHue } from "../../lib/profiles";
import { projectName, projectTint } from "../../lib/surfaces";
import { partialAnswer, styleCounts } from "../../lib/styleparse";
import { dismissStyle, startStyle, stopStyle, undoStyle, useStyle } from "../../lib/stylerun";
import { ProjectTile } from "../ui/ProjectTile";
import { Fuel } from "../Composer";

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const pictures = (r: StyleRun) => (r.projects ?? []).reduce((n, p) => n + p.cands.length, 0);
const logoMark = (c: StyleCandidate): ProjectMark => ({ kind: "logo", logo: c.logo });
const candLabel = (c: StyleCandidate) => c.src === "now" ? (c.path ? c.path.split("/").pop() ?? "now" : "what it wears")
  : c.src === "frontend" ? `${projectName(c.from ?? "")}'s` : (c.path ?? c.id).split("/").pop() ?? c.id;
const candKind = (c: StyleCandidate) => (c.src === "now" ? "now" : c.src === "frontend" ? "its frontend" : "repo");

/** The project the answer is being written for: the line in progress names it, else the first not answered yet. */
function current(r: StyleRun) {
  const part = partialAnswer(r.current ?? "");
  const done = new Set((r.items ?? []).map((i) => i.rel));
  const p = (r.projects ?? []).find((x) => x.key === part.p && !done.has(x.rel))
    ?? (r.projects ?? []).find((x) => !done.has(x.rel) && !(r.yours ?? []).includes(x.rel));
  return { p, part };
}

/** The toolbar's button. With more than one Claude login a press asks which one
 *  runs it, each with what it has left (the PROFILE menu's rows), and a row
 *  starts the run on it; with one, the press runs. */
export function StyleButton({ logins }: { logins: AccountInfo[] }) {
  const s = useStyle();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [open]);
  const running = s.drawing || s.run?.state === "running";
  const usable = logins.filter((a) => !a.disabled);
  const ask = usable.length > 1;
  const run = (slot: number | null) => { setOpen(false); void startStyle(slot); };
  return (
    <div ref={ref} className="ps-pickwrap">
      <button type="button" className="ps-btn prj-pickbtn st-btn" disabled={running} data-run={running || undefined}
        data-on={(open || (!running && !!s.run && s.run.state !== "idle" && !s.dismissed)) || undefined}
        aria-expanded={ask ? open : undefined}
        title="AI looks at every repo's logos and favicons, Rivendell's logo and a frontend's mark; each project wears the one that reads best here, with its background and colour. A mark you set stays yours."
        onClick={() => (ask ? setOpen((o) => !o) : run(null))}>
        {running ? <i className="st-spin" aria-hidden /> : <Sparkles size={15} aria-hidden />}
        {running ? "Styling…" : "Style with AI"}
      </button>
      {open && (
        <div className="ps-menu st-logins">
          <div className="ps-grp">Style with which login?</div>
          {usable.map((a) => (
            <button key={a.slot} type="button" className="pm-row" disabled={!a.logged_in} data-dead={!a.logged_in || undefined}
              onClick={() => run(a.slot)}>
              <span className="ps-av" style={{ background: slotHue(String(a.slot)), color: "var(--acc-on)" }}>A{a.slot}</span>
              <span className="pm-main">
                <span className="pm-l1"><span className="pm-name">{a.alias || a.email || `Account ${a.slot}`}</span>
                  {a.plan && <span className="pm-knobs">{a.plan}</span>}</span>
                {a.logged_in ? <span className="pm-fuel">{loginWindows(a).map((w) => <Fuel key={w.tag} w={w} />)}</span>
                  : <span className="pm-exp">LOGIN EXPIRED · sign in again under Accounts</span>}
              </span>
              {a.default && <span className="pm-tail"><span className="pm-tag">DEFAULT</span></span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** Under the toolbar: the run as it goes (with STOP), then what it did (with Undo all). */
export function StyleStrip({ reviewing, onReview }: { reviewing: boolean; onReview: () => void }) {
  const s = useStyle();
  const r = s.run;
  const close = <button type="button" className="ps-btn ps-i" title="close" onClick={dismissStyle}><X size={14} /></button>;
  if (s.drawing) {
    return (
      <div className="ps-riv prj-picked st-strip"><i><Sparkles size={16} aria-hidden /></i>
        <div><b>Reading every project's pictures</b><small>its logos and favicons, Rivendell's logo, a frontend's mark, each on a dark ground and a light one</small></div>
        <span className="st-bar st-bar-run"><i /></span>
      </div>
    );
  }
  if (s.error && r?.state !== "running" && !s.dismissed) {
    return (
      <div className="ps-riv prj-picked st-strip" data-err><i><Sparkles size={16} aria-hidden /></i>
        <div><b>Style with AI didn't run</b><small>{s.error}</small></div>
        <button type="button" className="ps-btn" onClick={() => void startStyle()}>Try again</button>{close}
      </div>
    );
  }
  if (!r || r.state === "idle" || s.dismissed) return null;
  const items = r.items ?? [];
  if (r.state === "running") {
    const pct = r.total ? Math.round((items.length / r.total) * 100) : 0;
    return (
      <div className="ps-riv prj-picked st-strip"><i><Sparkles size={16} aria-hidden /></i>
        <div><b>Styling {plural(r.total ?? 0, "project", "projects")}</b>
          <small>Read <b>{pictures(r)} pictures</b>: logos and favicons in the repos, Rivendell's logos, a frontend's mark · <b>{items.length} of {r.total}</b> decided</small></div>
        <button type="button" className="ps-btn" onClick={() => void stopStyle()}>Stop</button>
        {items.length ? <span className="st-bar"><i style={{ width: `${Math.max(3, pct)}%` }} /></span> : <span className="st-bar st-bar-run"><i /></span>}
      </div>
    );
  }
  const live = items.filter((i) => !i.undone);
  const c = styleCounts(live);
  const all = styleCounts(items);
  const chips = ([[c.logos, "new logo", "new logos"], [c.icons, "new icon", "new icons"], [c.backgrounds, "background", "backgrounds"],
    [c.colours, "colour", "colours"]] as const).filter(([n]) => n > 0);
  const title = all.changed > 0 && c.changed === 0 ? "Undone: every project wears what it wore before"
    : r.state === "stopped" ? `Stopped after ${items.length} of ${r.total}: ${plural(c.changed, "project", "projects")} restyled`
    : r.state === "failed" ? `Style with AI stopped${c.changed ? `: ${plural(c.changed, "project", "projects")} restyled first` : ""}`
    : `Styled ${plural(c.changed, "project", "projects")}`;
  const sub = r.state === "failed" ? r.error ?? "" : [all.kept ? `${all.kept} already right` : "",
    (r.yours ?? []).length ? `${r.yours!.length} you set, left as they are` : ""].filter(Boolean).join(" · ");
  return (
    <div className="ps-riv prj-picked st-strip" data-err={r.state === "failed" || undefined}><i><Sparkles size={16} aria-hidden /></i>
      <div><b>{title}</b>{sub && <small>{sub}</small>}
        {chips.length > 0 && <div className="st-sum">{chips.map(([n, one, many]) => <span key={one}><b>{n}</b> {n === 1 ? one : many}</span>)}</div>}
      </div>
      {r.state === "failed" && <button type="button" className="ps-btn" onClick={() => void startStyle()}>Try again</button>}
      {!reviewing && <button type="button" className="ps-btn" onClick={onReview}>Review</button>}
      {c.changed > 0 && <button type="button" className="ps-btn" onClick={() => void undoStyle()}><Undo2 size={13} aria-hidden />Undo all</button>}
      {close}
    </div>
  );
}

export type StyleRow = { st: "wait" | "now" | "done"; end: ReactNode; landed: boolean } | null;

/** Each list row's part in the run: waiting, being decided (its candidates fanned,
 *  a lens on the one weighed), or decided (what changed, ✓ already right, yours). */
export function useStyleRows(): (rel: string) => StyleRow {
  const s = useStyle();
  const r = s.run;
  if (!r || r.state === "idle" || s.dismissed) return () => null;
  const items = new Map((r.items ?? []).map((i) => [i.rel, i]));
  const inRun = new Set((r.projects ?? []).map((p) => p.rel));
  const yours = new Set(r.yours ?? []);
  // A row is "now" only once the answer has begun: before that the model reads the whole sheet.
  const answering = r.state === "running" && (!!r.current || (r.items ?? []).length > 0);
  const { p: cur, part } = answering ? current(r) : { p: undefined, part: {} as ReturnType<typeof partialAnswer> };
  const now = Date.now();
  return (rel) => {
    if (yours.has(rel)) return { st: "done", end: <span className="st-end">yours</span>, landed: false };
    const it = items.get(rel);
    if (it) {
      const landed = now - (s.landed[rel] ?? 0) < 1200;
      if (it.undone) return { st: "done", end: <span className="st-end">undone</span>, landed: false };
      const top = it.how[0];
      const end = !top ? <span className="st-end"><Check size={13} strokeWidth={2.2} aria-label="already right" /></span>
        : top === "colour" ? <span className="st-end"><span className="st-chip"><i style={{ ["--c" as string]: it.after?.color ?? "var(--acc)" }} />colour</span></span>
        : <span className="st-end"><span className="st-chip"><Sparkles size={10} aria-hidden />{top === "logo" ? "new logo" : top === "icon" ? "new icon" : "background"}</span></span>;
      return { st: "done", end, landed };
    }
    if (r.state !== "running" || !inRun.has(rel)) return null;
    if (cur?.rel === rel) {
      return { st: "now", landed: false, end: (
        <span className="st-fan">{cur.cands.slice(0, 4).map((c) => (
          <span key={c.id} data-lens={part.pick === c.id || undefined}><ProjectTile project={rel} mark={logoMark(c)} /></span>
        ))}</span>
      ) };
    }
    return { st: "wait", end: null, landed: false };
  };
}

/** The sweep down the list while the page reads every project's pictures. */
export function StyleScan() {
  const s = useStyle();
  return s.drawing ? <i className="st-scan" aria-hidden /> : null;
}

/** The right pane during a run (what it's looking at) and after it (what it changed, and why). */
export function StylePane({ onPick }: { onPick: (rel: string) => void }) {
  const s = useStyle();
  const r = s.run;
  if (s.drawing || !r || r.state === "idle") {
    return (
      <div className="st-look">
        <div className="st-k"><ScanEye size={14} aria-hidden />Reading</div>
        <p className="st-why">every project's logos and favicons, drawn on a dark ground and a light one for the stylist</p>
      </div>
    );
  }
  if (r.state === "running") return <Looking r={r} />;
  return <Ledger r={r} onPick={onPick} />;
}

function Looking({ r }: { r: StyleRun }) {
  const { p, part } = current(r);
  // Before its first answer the model reads the whole sheet, ~14 s on sonnet.
  if (!p || (!r.current && !(r.items ?? []).length)) {
    return (
      <div className="st-look">
        <div className="st-k"><ScanEye size={14} aria-hidden />Now looking at</div>
        <div className="st-who"><div><b>The whole sheet</b><small>{plural(r.total ?? 0, "project", "projects")} · {pictures(r)} pictures, each on a dark ground and a light one</small></div></div>
        <div className="st-sheet">{(r.projects ?? []).map((x) => <ProjectTile key={x.rel} project={x.rel} />)}</div>
        <p className="st-why" data-typing>reading it · {Math.max(0, Math.round(Date.now() / 1000 - (r.started ?? 0)))} s</p>
      </div>
    );
  }
  const done = new Set((r.items ?? []).map((i) => i.rel));
  const next = (r.projects ?? []).filter((x) => x.rel !== p.rel && !done.has(x.rel) && !(r.yours ?? []).includes(x.rel));
  const picked = p.cands.find((c) => c.id === part.pick);
  const icon = part.pick?.startsWith("icon:") ? part.pick.slice(5) : "";
  return (
    <div className="st-look">
      <div className="st-k"><ScanEye size={14} aria-hidden />Now looking at</div>
      <div className="st-who"><ProjectTile project={p.rel} />
        <div><b>{p.name}</b><small>{plural(p.cands.length, "picture", "pictures")} · {p.rel}</small></div></div>
      {p.cands.length > 0 && (
        <div className="st-cands">
          {p.cands.map((c) => (
            <div key={c.id} className="st-cand" data-pick={c.id === part.pick || undefined} data-off={(!!part.pick && c.id !== part.pick) || undefined}>
              {c.id === part.pick && <em><Sparkles size={10} aria-hidden />pick</em>}
              <ProjectTile project={p.rel} mark={logoMark(c)} />
              <small><b>{candKind(c)}</b>{candLabel(c)}</small>
            </div>
          ))}
        </div>
      )}
      <p className="st-why" data-typing>{part.why ?? ""}</p>
      {(part.pick || part.bg || part.color) && (
        <div className="st-dec">
          {part.pick && <span>Wears <b>{picked ? candLabel(picked) : icon ? `the ${icon} icon` : part.pick === "keep" ? "what it wears" : part.pick}</b></span>}
          {part.bg && <span>Background <b>{part.bg}</b></span>}
          {part.color && /^#[0-9a-f]{6}$/i.test(part.color) && <span>Colour <i className="st-sw" style={{ ["--c" as string]: part.color }} /><b>{part.color}</b></span>}
        </div>
      )}
      {next.length > 0 && (
        <div className="st-queue">Next <b>{next[0].name}</b>
          {next.slice(0, 4).map((x) => <span key={x.rel} className="st-dim"><ProjectTile project={x.rel} /></span>)}
          {next.length > 4 && <span>and {next.length - 4} more</span>}
        </div>
      )}
    </div>
  );
}

function Ledger({ r, onPick }: { r: StyleRun; onPick: (rel: string) => void }) {
  const items = r.items ?? [];
  const changed = items.filter((i) => i.how.length);
  const kept = items.filter((i) => !i.how.length);
  const secs = r.ended && r.started ? Math.max(1, Math.round(r.ended - r.started)) : 0;
  const tag = (h: string, c?: string) => h === "colour"
    ? <em key={h}><i style={{ ["--c" as string]: c ?? "var(--acc)" }} />colour</em> : <em key={h}>{h}</em>;
  return (
    <div className="st-led">
      <header><div><b>{changed.length ? "What the stylist changed" : r.state === "done" ? "Nothing to change" : "Nothing changed"}</b>
        <small>{secs ? `in ${secs} s, ` : ""}one AI call over {pictures(r)} pictures · pick a project to change it by hand</small></div></header>
      {changed.map((i) => (
        <div key={i.rel} className="st-item" role="button" tabIndex={0} onClick={() => onPick(i.rel)}
          onKeyDown={(e) => { if (e.key === "Enter") onPick(i.rel); }} data-undone={i.undone || undefined}>
          <span className="st-ba"><ProjectTile project={i.rel} mark={i.before} /><ArrowRight size={11} aria-hidden /><ProjectTile project={i.rel} mark={i.after} /></span>
          <div><div className="st-nm"><span style={{ color: projectTint(i.rel).color }}>{projectName(i.rel)}</span>
            <span className="st-tags">{i.how.map((h) => tag(h, i.after?.color))}</span></div>
            {i.why && <small>{i.why}</small>}</div>
          {i.undone ? <span className="st-end">undone</span>
            : <button type="button" className="ps-btn" onClick={(e) => { e.stopPropagation(); void undoStyle(i.rel); }}><Undo2 size={12} aria-hidden />Undo</button>}
        </div>
      ))}
      {kept.length > 0 && <>
        <div className="st-sec">Already right <b>{kept.length}</b></div>
        <div className="st-tiles">{kept.map((i) => <span key={i.rel} title={projectName(i.rel)}><ProjectTile project={i.rel} /></span>)}</div>
      </>}
      {(r.yours ?? []).length > 0 && <>
        <div className="st-sec">Yours <b>{r.yours!.length}</b></div>
        <div className="st-tiles">{r.yours!.map((rel) => <span key={rel} title={projectName(rel)}><ProjectTile project={rel} /></span>)}
          <small>a mark you set stays yours</small></div>
      </>}
      {r.note && <div className="st-note"><b>Passed over:</b> {r.note}</div>}
      {r.state === "failed" && r.error && <div className="st-note" data-err><b>It stopped:</b> {r.error}</div>}
    </div>
  );
}
