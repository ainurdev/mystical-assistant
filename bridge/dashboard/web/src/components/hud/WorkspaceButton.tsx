import { useEffect, useRef, useState } from "react";
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
 *  page that adds the second. */
export function WorkspaceButton({ onManage }: { onManage: () => void }) {
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

  return (
    <span ref={wrap} className="wsbtn-wrap">
      <button type="button" className="wsbtn" aria-haspopup="menu" aria-expanded={open}
        title={`Workspace: ${here.name} — click to switch, right-click to manage`}
        onClick={() => setOpen((o) => !o)}
        // Stopped here: the dashboard's own right-click menu would open over the page.
        onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); manage(); }}>
        <WorkspaceAvatar ws={here} />
      </button>
      {open && (
        <div className="wspop" role="menu" aria-label="Workspaces">
          <div className="wspop-h">Workspaces</div>
          {list.map((w) => (
            <button key={w.id} type="button" role="menuitemradio" aria-checked={w.id === here.id} className="wspop-row"
              onClick={() => { switchWorkspace(w.id); setOpen(false); }}>
              <WorkspaceAvatar ws={w} size={20} />
              <span className="wspop-name">{w.name}</span>
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

