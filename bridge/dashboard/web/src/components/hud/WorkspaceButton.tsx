import { useEffect, useRef, useState, type MouseEvent as RMouseEvent } from "react";
import { Check, Settings2 } from "lucide-react";
import { workspaceImageUrl, type Workspace } from "../../api";
import { switchWorkspace, useWorkspaces } from "../../lib/workspaces";

/** A workspace's avatar: its picture, else the first letter of its name. It
 *  wears a ring a step off its edge (index.css `.wsav`), so it never reads as
 *  a project's tile, which is a flat square of the project's own tint. */
export function WorkspaceAvatar({ ws, size = 22 }: { ws: Workspace; size?: number }) {
  const [broken, setBroken] = useState(false);
  const letter = (ws.name.trim()[0] || "?").toUpperCase();
  return (
    <span className="wsav" aria-hidden style={{ width: size, height: size, fontSize: Math.round(size * 0.5) }}>
      {ws.image && !broken
        ? <img src={workspaceImageUrl(ws.image)} alt="" draggable={false} onError={() => setBroken(true)} />
        : letter}
    </span>
  );
}

/** The sidebar's workspace switch, in Brand's cap beside the fold. A click
 *  lists the workspaces to switch to; a right-click (or MANAGE) opens their
 *  settings page. With only DEFAULT it is still there: it's how you find the
 *  page that adds the second.
 *
 *  ROW (the page's SWITCHER) draws every workspace as its own button instead,
 *  the current one ringed: a click switches, a right-click still manages. The
 *  row scrolls sideways once it outgrows the cap rather than pushing the fold
 *  off it.
 *
 *  `news` counts, per workspace you aren't on, its chats by state (App's
 *  wsNews), in the sidebar's colours: one waiting on you (ask, --warn) or
 *  finished and unopened (done, --acc) puts a dot on its avatar, ask over
 *  done; one running (work, --ok) puts a ring round it, with or without a
 *  dot. The menu's trigger shows the same for every workspace but yours, and
 *  the menu names the counts per row. Each theme family dresses the marks in
 *  its own manner (index.css, the workspace marks). */
export type WsNews = { ask: number; done: number; work: number };

/** The marks on an avatar: a ring while something runs, one dot for what wants you. */
function Marks({ n }: { n?: WsNews }) {
  if (!n) return null;
  const dot = n.ask ? "ask" : n.done ? "done" : null;
  return (
    <>
      {n.work > 0 && <i className="wsring" aria-hidden />}
      {dot && <i className="wsdot" data-kind={dot} aria-hidden />}
    </>
  );
}

/** "2 waiting on you, 1 running": what the marks mean, for a title. */
function said(n?: WsNews): string {
  if (!n) return "";
  return [n.ask && `${n.ask} waiting on you`, n.done && `${n.done} finished`, n.work && `${n.work} running`].filter(Boolean).join(", ");
}

const sum = (a: WsNews, b: WsNews): WsNews => ({ ask: a.ask + b.ask, done: a.done + b.done, work: a.work + b.work });
const NONE: WsNews = { ask: 0, done: 0, work: 0 };

export function WorkspaceButton({ onManage, news }: { onManage: () => void; news?: Map<string, WsNews> }) {
  const { set, cur } = useWorkspaces();
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => { if (!wrap.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("mousedown", away); document.removeEventListener("keydown", esc); };
  }, [open]);

  const list = set?.workspaces ?? [{ id: "default", name: "Default", image: null }];
  const here = list.find((w) => w.id === cur) ?? list[0];
  const count = (id: string) => Object.values(set?.assign ?? {}).filter((v) => v === id).length;
  const manage = () => { setOpen(false); onManage(); };
  const newIn = (id: string): WsNews | undefined => (id === here.id ? undefined : news?.get(id));
  // The trigger stands for every workspace but this one.
  const others = list.reduce((t, w) => sum(t, newIn(w.id) ?? NONE), NONE);
  const anyNews = others.ask + others.done + others.work > 0;
  const onCtx = (e: RMouseEvent) => { e.preventDefault(); e.stopPropagation(); manage(); };

  if (set?.display === "row" && list.length > 1) return (
    <span className="wsrow" role="radiogroup" aria-label="Workspaces">
      {list.map((w) => (
        <button key={w.id} type="button" className="wsbtn" role="radio" aria-checked={w.id === here.id}
          title={`${w.name}${said(newIn(w.id)) ? ` — ${said(newIn(w.id))}` : ""} — right-click to manage workspaces`}
          onClick={() => switchWorkspace(w.id)} onContextMenu={onCtx}>
          <WorkspaceAvatar ws={w} size={20} />
          <Marks n={newIn(w.id)} />
        </button>
      ))}
    </span>
  );

  return (
    <span ref={wrap} className="wsbtn-wrap">
      <button type="button" className="wsbtn" aria-haspopup="menu" aria-expanded={open}
        title={`Workspace: ${here.name}${anyNews ? ` — in other workspaces: ${said(others)}` : ""} — click to switch, right-click to manage`}
        onClick={() => setOpen((o) => !o)}
        // Stopped here: the dashboard's own right-click menu would open over the page.
        onContextMenu={onCtx}>
        <WorkspaceAvatar ws={here} />
        <Marks n={anyNews ? others : undefined} />
      </button>
      {open && (
        <div className="wspop" role="menu" aria-label="Workspaces">
          <div className="wspop-h">Workspaces</div>
          {list.map((w) => (
            <button key={w.id} type="button" role="menuitemradio" aria-checked={w.id === here.id} className="wspop-row"
              onClick={() => { switchWorkspace(w.id); setOpen(false); }}>
              <WorkspaceAvatar ws={w} size={20} />
              <span className="wspop-name">{w.name}</span>
              {(() => {
                const n = newIn(w.id);
                if (!n) return null;
                return (
                  <span className="wspop-tags" title={said(n)}>
                    {n.ask > 0 && <span className="wspop-new" data-kind="ask">ASKS {n.ask}</span>}
                    {n.done > 0 && <span className="wspop-new" data-kind="done">DONE {n.done}</span>}
                    {n.work > 0 && <span className="wspop-new" data-kind="work">RUNNING {n.work}</span>}
                  </span>
                );
              })()}
              <span className="wspop-n">{w.id === "default" ? "the rest" : `${count(w.id)} project${count(w.id) === 1 ? "" : "s"}`}</span>
              {w.id === here.id && <Check size={13} strokeWidth={2.4} aria-hidden className="wspop-on" />}
            </button>
          ))}
          <button type="button" role="menuitem" className="wspop-row wspop-manage" onClick={manage}>
            <Settings2 size={14} strokeWidth={2} aria-hidden />
            <span className="wspop-name">Manage workspaces…</span>
          </button>
        </div>
      )}
    </span>
  );
}

