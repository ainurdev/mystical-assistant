import { createContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowUpRight, Check, ChevronDown, Clock, CornerDownRight, Download, ListPlus, Play, Search, Split } from "lucide-react";
import { api, type SpinRow } from "../api";
import { main } from "../lib/queries";
import { openSession } from "../lib/devicerun";
import { ago, projectName } from "../lib/surfaces";
import { CLONE, counts, gone, placeCount, shortKeys, sourceCount, tappable, tickedAtFirst } from "../lib/spinoffs";
import { ProjectTile } from "./ui/ProjectTile";
import { Markdown } from "./Markdown";
import { FLOW_ICON } from "./Composer";

/** The chat a spin-off came from, for its way back: the header's crumb and its first line (Terminal provides it). */
export interface SpunFromInfo { id: string; title: string; project: string; keys: string[] }
export const SpunFrom = createContext<SpunFromInfo | null>(null);

type Flow = SpinRow["flow"];
const FLOWS: [Flow, string][] = [["fix", "Fix"], ["build", "Build"], ["design", "Design"]];
const SHOWN = 8;   // projects the menu lists before "n more": the search finds the rest

/** The card a turn leaves when its work turned up work this chat isn't doing (spin_off, bridge/spinoffs.py;
 *  .mystical/design-drafts/spin-offs, A · CARD). Its rows are read from the bridge, never from the reply,
 *  and only your START or PARK files anything. Rows that went fold to a ✓ line of chips, each a link to
 *  its spin-off; the rows you didn't touch stay as a smaller card. It is an offer, not an ask: no amber
 *  node, never in Needs you. */
export function SpinOffCard({ session, card }: { session: string; card: string }) {
  const read = main.spinoffs({ session });
  // Polled only while a row is on its way: a clone, or a chain's later row waiting for the one before.
  const q = useQuery({ ...read, refetchInterval: (qq) =>
    qq.state.data?.cards.some((c) => c.id === card && c.rows.some((r) => r.state === "cloning" || r.state === "waiting")) ? 5000 : false });
  const projectsQ = useQuery(main.projects());
  const qc = useQueryClient();
  const rows = useMemo(() => q.data?.cards.find((c) => c.id === card)?.rows ?? [], [q.data, card]);
  const here = q.data?.here ?? "";
  // null until the rows land; then the rows that can go as they are start ticked.
  const [ticked, setTicked] = useState<Set<number> | null>(null);
  const [placed, setPlaced] = useState<Record<number, string>>({});
  const [flows, setFlows] = useState<Record<number, Flow>>({});
  const [open, setOpen] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    if (ticked === null && rows.length) setTicked(new Set(rows.filter(tickedAtFirst).map((r) => r.n)));
  }, [rows, ticked]);
  if (!rows.length) return q.error ? <p className="so-err" role="alert">The spin-offs didn't load: {q.error.message}</p> : null;

  const ticks = ticked ?? new Set<number>();
  const placeOf = (r: SpinRow) => (gone(r) ? r.project : placed[r.n] ?? (r.project || (r.clone ? CLONE : "")));
  const flowOf = (r: SpinRow) => flows[r.n] ?? r.flow;
  const went = rows.filter(gone);
  const rest = rows.filter((r) => !gone(r));
  const n = counts(rest, ticks, placeOf);
  const listing = projectsQ.data;
  const projects = (listing?.projects ?? []).filter((p) => !listing?.hidden?.includes(p));

  const tap = async (how: "start" | "park") => {
    const picks = rest.filter((r) => ticks.has(r.n) && tappable(r) && placeOf(r) && (how === "start" || placeOf(r) !== CLONE))
      .map((r) => ({ n: r.n, project: placeOf(r), flow: flowOf(r) }));
    if (!picks.length) return;
    setBusy(true);
    setError("");
    try {
      qc.setQueryData(read.queryKey, await api.spinoffTap(session, card, how, picks));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const tick = (r: SpinRow) => setTicked((t) => {
    const next = new Set(t ?? []);
    if (next.has(r.n)) next.delete(r.n);
    else next.add(r.n);
    return next;
  });

  return (
    <div className="so">
      {went.length ? (
        <div className="so-fold" role="group" aria-label="Spun off">
          <span className="so-done"><Check size={15} strokeWidth={2.4} aria-hidden />Spun off {went.length}</span>
          {went.map((r) => <Chip key={r.n} r={r} />)}
        </div>
      ) : null}
      {rest.length ? (
        <div className="so-card" role="group" aria-label="Spin-offs">
          <div className="so-h">
            <Split size={15} aria-hidden />
            <b>Spin-offs</b>
            <span>{rest.length}{(() => { const p = placeCount(rest, placeOf); return p ? ` · ${p} project${p === 1 ? "" : "s"}` : ""; })()}</span>
          </div>
          {rest.map((r) => r.repeat ? <Repeat key={r.n} r={r} /> : (
            <div key={r.n} className="so-item" data-open={open === r.n || undefined}>
              <div className="so-row" data-off={!ticks.has(r.n) || undefined}>
                {r.after && rest.some((x) => x.n === r.after) ? <span className="so-chain" aria-hidden /> : null}
                <button type="button" role="checkbox" aria-checked={ticks.has(r.n)} className="so-tick" disabled={busy || !tappable(r)}
                  aria-label={r.title} onClick={() => tick(r)}>
                  {ticks.has(r.n) ? <Check size={11} strokeWidth={3} aria-hidden /> : null}
                </button>
                <div className="so-tx">
                  {r.brief || r.sources.some((x) => x.url) ? (
                    <button type="button" className="so-t1" aria-expanded={open === r.n} title="What its session gets"
                      onClick={() => setOpen((o) => (o === r.n ? null : r.n))}>{r.title}</button>
                  ) : <div className="so-t1" data-plain="">{r.title}</div>}
                  <div className="so-t2"><Second r={r} place={placeOf(r)} /></div>
                </div>
                <div className="so-ctl">
                  <ProjectMenu r={r} place={placeOf(r)} here={here} projects={projects}
                    onPick={(p) => { setPlaced((m) => ({ ...m, [r.n]: p })); setTicked((t) => new Set(t ?? []).add(r.n)); }} />
                  <FlowMenu flow={flowOf(r)} onPick={(f) => setFlows((m) => ({ ...m, [r.n]: f }))} />
                </div>
              </div>
              {open === r.n ? <Brief r={r} /> : null}
            </div>
          ))}
          <div className="so-f">
            {error ? <span className="so-warn" role="alert" title={error}>{error}</span> : null}
            <span className="so-sp" />
            <button type="button" className="so-btn" disabled={busy || !n.park} onClick={() => void tap("park")}
              title="On each project's work list, to start later">
              <ListPlus size={14} aria-hidden />Park{n.park ? ` ${n.park}` : ""}
            </button>
            <button type="button" className="so-btn" data-pri={n.start ? "" : undefined} disabled={busy || !n.start} onClick={() => void tap("start")}>
              <Play size={12} aria-hidden />Start{n.start ? ` ${n.start}` : ""}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** A spin-off on the ✓ line: its project, its title, and a link to its session; a chain's later one
 *  shows a clock until the one before is done, a parked one sits on its project's work list. */
function Chip({ r }: { r: SpinRow }) {
  const inner = (
    <>
      <ProjectTile project={r.project} />
      <span className="so-ct">{r.title}</span>
      {r.state === "waiting" ? <Clock size={13} className="so-wait" aria-hidden />
        : r.state === "parked" ? <ListPlus size={13} aria-hidden /> : <ArrowUpRight size={13} aria-hidden />}
    </>
  );
  const where = projectName(r.project);
  return r.session ? (
    <button type="button" className="so-chip" data-state={r.state} title={`${r.title}, in ${where}`} onClick={() => openSession(r.session)}>{inner}</button>
  ) : (
    <span className="so-chip" data-state={r.state}
      title={r.state === "waiting" ? `${r.title}: starts in ${where} once the one before it is done` : `${r.title}: parked on the work list of ${where}`}>{inner}</span>
  );
}

/** A row whose source is on a work list already: no tick, a link to where it is. */
function Repeat({ r }: { r: SpinRow }) {
  const rep = r.repeat!;
  return (
    <div className="so-item">
      <div className="so-row" data-repeat="">
        <span className="so-lead" aria-hidden><ArrowUpRight size={14} /></span>
        <div className="so-tx">
          <div className="so-t1" data-plain="">{r.title}</div>
          <div className="so-t2">
            <ProjectTile project={rep.project} /><span>{projectName(rep.project)}</span><span>·</span>
            {rep.session ? <>already in<button type="button" className="so-link" onClick={() => openSession(rep.session)}>{rep.title}</button></>
              : <span>already parked on its work list</span>}
            {rep.at ? <span className="so-dim">· {ago(rep.at)} ago</span> : null}
          </div>
        </div>
      </div>
    </div>
  );
}

/** A row's second line: what it waits on, what it was found in; a clone's repo; or how it went wrong. */
function Second({ r, place }: { r: SpinRow; place: string }) {
  if (r.state === "cloning") return <><Clock size={12} className="so-wait" aria-hidden /><span>Cloning</span><span className="so-mono">{bare(r.clone)}</span></>;
  const keys = shortKeys(r.sources.map((s) => s.ref || bare(s.url)));
  return (
    <>
      {r.after ? <><span className="so-after"><CornerDownRight size={12} aria-hidden />after {r.after}</span><span>·</span></> : null}
      {place === CLONE ? (
        <><Download size={12} className="so-wait" aria-hidden /><span>no checkout ·</span><span className="so-mono">{bare(r.clone)}</span></>
      ) : !place ? <span className="so-wait">no project here matched</span> : r.sources.length ? (
        <><span>{sourceCount(r.sources)}</span><span>·</span><span className="so-mono">{keys.join(" · ")}</span></>
      ) : null}
      {r.note ? <span className="so-warn" title={r.note}>{r.note}</span> : null}
    </>
  );
}

const bare = (url: string) => url.replace(/^https?:\/\//, "");

/** What the row's spin-off gets as its brief, with the links it came from. */
function Brief({ r }: { r: SpinRow }) {
  const links = r.sources.filter((s) => s.url);
  const names = shortKeys(links.map((s) => s.ref || bare(s.url)));
  return (
    <div className="so-brief">
      {r.brief ? <Markdown className="so-md">{r.brief}</Markdown> : null}
      {links.length ? (
        <div className="so-src">
          {links.map((s, i) => <a key={i} href={s.url} target="_blank" rel="noreferrer noopener">{names[i]} ↗</a>)}
        </div>
      ) : null}
    </div>
  );
}

/** A picker's button and its menu, shut by a click outside or Escape. Not a dialog: one restyles the
 *  buttons inside it (index.css [role="dialog"]). */
function Menu({ label, face, children }: { label: string; face: ReactNode; children: (close: () => void) => ReactNode }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const down = (e: PointerEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); setOpen(false); } };
    document.addEventListener("pointerdown", down);
    document.addEventListener("keydown", key, true);
    return () => { document.removeEventListener("pointerdown", down); document.removeEventListener("keydown", key, true); };
  }, [open]);
  return (
    <span className="so-pkw" ref={ref}>
      <button type="button" className="so-pk" aria-haspopup="listbox" aria-expanded={open} aria-label={label} onClick={() => setOpen((o) => !o)}>
        {face}<ChevronDown size={12} className="so-cv" aria-hidden />
      </button>
      {open ? <div className="so-pop" role="listbox" aria-label={label}>{children(() => setOpen(false))}</div> : null}
    </span>
  );
}

function ProjectMenu({ r, place, here, projects, onPick }: { r: SpinRow; place: string; here: string; projects: string[]; onPick: (rel: string) => void }) {
  const [find, setFind] = useState("");
  const q = find.trim().toLowerCase();
  const all = [...projects].sort((a, b) => Number(b === place) - Number(a === place) || Number(b === here) - Number(a === here)
    || projectName(a).localeCompare(projectName(b)));
  const hits = all.filter((p) => !q || `${projectName(p)} ${p}`.toLowerCase().includes(q));
  const face = place === CLONE ? <><Download size={13} aria-hidden /><span className="so-pn">Clone &amp; start</span></>
    : place ? <><ProjectTile project={place} /><span className="so-pn">{projectName(place)}</span></>
    : <span className="so-pn so-wait">Pick a project</span>;
  return (
    <Menu label={`Project for ${r.title}`} face={face}>
      {(close) => (
        <>
          <label className="so-find">
            <Search size={13} aria-hidden />
            <input autoFocus value={find} onChange={(e) => setFind(e.target.value)} placeholder="Find a project" aria-label="Find a project"
              onKeyDown={(e) => { if (e.key === "Enter" && hits[0]) { onPick(hits[0]); close(); } }} />
          </label>
          {hits.slice(0, SHOWN).map((p) => (
            <button key={p} type="button" role="option" aria-selected={p === place} className="so-opt" onClick={() => { onPick(p); close(); }}>
              <ProjectTile project={p} /><span className="so-pn">{projectName(p)}</span>
              {p === here ? <span className="so-tag">this chat</span> : null}
              {p === place ? <Check size={13} className="so-ck" aria-hidden /> : null}
            </button>
          ))}
          {hits.length > SHOWN ? <div className="so-more">{hits.length - SHOWN} more: type to find them</div> : null}
          {!hits.length ? <div className="so-more">No project matches.</div> : null}
          {r.clone ? (
            <>
              <div className="so-sep" />
              <button type="button" role="option" aria-selected={place === CLONE} className="so-opt" onClick={() => { onPick(CLONE); close(); }}>
                <Download size={13} aria-hidden /><span className="so-pn">Clone &amp; start</span><span className="so-tag so-mono">{bare(r.clone)}</span>
              </button>
            </>
          ) : null}
        </>
      )}
    </Menu>
  );
}

function FlowMenu({ flow, onPick }: { flow: Flow; onPick: (f: Flow) => void }) {
  const Icon = FLOW_ICON[flow];
  return (
    <Menu label="Flow" face={<><Icon size={13} aria-hidden /><span>{FLOWS.find(([f]) => f === flow)?.[1]}</span></>}>
      {(close) => FLOWS.map(([f, word]) => {
        const I = FLOW_ICON[f];
        return (
          <button key={f} type="button" role="option" aria-selected={f === flow} className="so-opt" onClick={() => { onPick(f); close(); }}>
            <I size={13} aria-hidden /><span className="so-pn">{word}</span>{f === flow ? <Check size={13} className="so-ck" aria-hidden /> : null}
          </button>
        );
      })}
    </Menu>
  );
}
