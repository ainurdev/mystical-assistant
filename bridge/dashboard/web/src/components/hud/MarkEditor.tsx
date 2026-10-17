import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Image as ImageIcon, Search, Shapes, Type, X } from "lucide-react";
import { DynamicIcon, iconNames } from "lucide-react/dynamic";
import { api, projectLogoUrl, type ProjectMark, type RivendellMarks } from "../../api";
import { inkCss, liftInk } from "../../lib/ink";
import { readLogo, shrinkLogo, useLogoInfo, type LogoInfo } from "../../lib/logoinfo";
import { hashTint, projectInitials, projectMark, putProjectMark, setProjectMarks } from "../../lib/surfaces";
import { synced } from "./RivendellMarks";

/* The mark editor: what a project's tile shows (its initials, an icon, or a
   logo) and the colour it wears. Opened from a tile in SETTINGS ▸ AI MANAGEMENT
   ▸ Projects and from the ANALYZE header, where it replaced the old colour dot.
   Design: docs/superpowers/specs/project-marks.md (the mockups' 02-editor).

   A mark that follows Rivendell says so. Any change here makes it yours, and a
   project Rivendell has a client logo for offers USE RIVENDELL'S. A repo no
   Rivendell project names offers LINK, which links it to one in Rivendell
   itself, so every Mystical on that Rivendell gets the logo. A dropped logo
   travels with SAVE in one request (bridge/projectmarks.set_mark), so a
   cancelled edit never leaves a file behind. It ships in the main bundle,
   not as a lazy chunk: a chunk that a rebuild had replaced under an open page
   failed to load and blanked the dashboard (2026-10-16). It floats in a portal, fixed beside the tile that opened it and flipped
   above it when there's no room below: inside SETTINGS or ANALYZE it would be
   clipped by the modal. */

type Kind = ProjectMark["kind"];
const HEX = /^#[0-9a-f]{6}$/i;
const MAX = 512 * 1024;

// The palette swatches: the theme's six inks, then six fixed hues.
const PALETTE = [
  "var(--acc)", "var(--purple)", "var(--ok)", "var(--info)", "var(--warn)", "var(--err)",
  "#ff7ad9", "#ffab6b", "#c8ef6a", "#7fd8ff", "#ff8ba7", "#b8c9d4",
];
// What the icon grid offers before you search: project-shaped things.
const COMMON = [
  "code", "terminal", "rocket", "gem", "bot", "layers", "box", "zap",
  "cloud", "database", "server", "cpu", "globe", "shield", "key-round", "wand-sparkles",
  "receipt", "wallet", "landmark", "briefcase", "shopping-cart", "chart-line", "calendar", "mail",
  "car", "graduation-cap", "book-open", "stethoscope", "flask-conical", "brain", "film", "music",
  "mountain-snow", "trees", "sprout", "leaf", "flame", "sun", "moon", "anchor",
];

interface Logo { name?: string; data?: string; url: string; label: string }

/** "IB Groups' logo", "Elvou's logo". */
const poss = (who: string) => (who.endsWith("s") ? `${who}'` : `${who}'s`);

export default function MarkEditor({ project, name, anchor, onClose }: {
  project: string;
  name: string;
  anchor: HTMLElement | null;   // the tile it hangs from
  onClose: () => void;
}) {
  const cur = projectMark(project);
  const following = cur?.source === "rivendell";
  const [kind, setKind] = useState<Kind>(cur?.kind ?? "letters");
  const [icon, setIcon] = useState<string | null>(cur?.icon ?? null);
  const [color, setColor] = useState<string | null>(cur?.color ?? null);
  const [plate, setPlate] = useState<ProjectMark["plate"] | null>(cur?.plate ?? null);
  const [hex, setHex] = useState(cur?.color && HEX.test(cur.color) ? cur.color : "");
  const [logo, setLogo] = useState<Logo | null>(cur?.logo
    ? { name: cur.logo, url: projectLogoUrl(cur.logo), label: following ? `${poss(cur.rv?.name ?? "The client")} logo` : "Your logo" }
    : null);
  const [dropped, setDropped] = useState<LogoInfo | null>(null);
  const stored = useLogoInfo(logo?.name, logo?.url ?? "");
  const info = logo?.data ? dropped : stored;
  const [query, setQuery] = useState("");
  const [riv, setRiv] = useState<RivendellMarks | null>(null);
  const [pick, setPick] = useState(-1);          // LINK's project, an index into riv.projects
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);
  const light = document.documentElement.hasAttribute("data-light");

  // Which client Rivendell has for this repo, for USE RIVENDELL'S and the
  // follow line. A bridge without the route just leaves both out.
  useEffect(() => { api.rivendellMarks().then(setRiv).catch(() => setRiv(null)); }, []);
  const match = riv?.matches?.[project] ?? null;
  const target = riv?.projects?.[pick];

  // Esc, a click outside, or scrolling what's under it closes it. The tile
  // counts as inside, so its own click can toggle it shut. Esc listens in the
  // capture phase with a stop: App's Esc would close the modal behind as well.
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const inside = (t: EventTarget | null) => !!t && (root.current?.contains(t as Node) || anchor?.contains(t as Node));
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); onClose(); } };
    const onDown = (e: PointerEvent) => { if (!inside(e.target)) onClose(); };
    // Only a scroll that moves the tile: a transcript streaming next door
    // scrolls all the time and must not shut it.
    const onScroll = (e: Event) => {
      const t = e.target as Node | null;
      if (!inside(t) && anchor && t && (t === document || t.contains?.(anchor))) onClose();
    };
    window.addEventListener("keydown", onKey, true);
    document.addEventListener("pointerdown", onDown);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      document.removeEventListener("pointerdown", onDown);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [onClose, anchor]);

  // Below the tile, or above it when the window has no room below, or beside it
  // when neither fits: the side is chosen once, as it opens, and kept. Chosen
  // afresh on every height change it flipped sides on a tab switch and jumped
  // out from under the pointer. The tabs don't change its height anyway: they
  // share one (.mk-pane), and so does the colour row (every tab shows it whole).
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  useLayoutEffect(() => {
    let side: "below" | "above" | "beside" | null = null;
    const place = () => {
      const a = anchor?.getBoundingClientRect();
      const el = root.current;
      if (!a || !el) return;
      const h = el.offsetHeight, w = el.offsetWidth, vh = window.innerHeight;
      side ??= a.bottom + 8 + h <= vh - 8 ? "below" : a.top - 8 - h >= 8 ? "above" : "beside";
      const top = side === "below" ? a.bottom + 8 : side === "above" ? a.top - 8 - h : Math.min(a.top - 60, vh - 8 - h);
      const left = side === "beside" ? a.right + 12 : a.left - 6;
      setPos({ top: Math.max(8, Math.min(top, vh - 8 - h)), left: Math.max(8, Math.min(left, window.innerWidth - w - 8)) });
    };
    place();
    const ro = new ResizeObserver(place);
    if (root.current) ro.observe(root.current);
    const onResize = () => { side = null; place(); };
    window.addEventListener("resize", onResize);
    return () => { ro.disconnect(); window.removeEventListener("resize", onResize); };
  }, [anchor]);

  const icons = useMemo(() => {
    const q = query.trim().toLowerCase().replace(/\s+/g, "-");
    return q ? iconNames.filter((n) => n.includes(q)).slice(0, 40) : COMMON;
  }, [query]);

  async function take(file: File | null | undefined) {
    if (!file) return;
    if (!/^image\/(png|jpeg|webp|svg\+xml)$/.test(file.type)) { setErr("A logo is a PNG, JPEG, WEBP or SVG image."); return; }
    try {
      const got = await shrinkLogo(file);
      if (got.data.length * 0.75 > MAX) { setErr("That logo is over 512 KB, even shrunk."); return; }
      const read = await readLogo(got.url).catch(() => null);
      setLogo({ data: got.data, url: got.url, label: `${file.name} · ${Math.max(1, Math.round(got.data.length * 0.75 / 1024))} KB` });
      setDropped(read);
      setKind("logo");
      setErr("");
      // A new logo brings its own colour, unless you picked one by hand.
      if (read?.colors[0] && (!color || !PALETTE.includes(color))) { setColor(read.colors[0]); setHex(read.colors[0]); }
    } catch {
      setErr("That file couldn't be read as an image.");
    }
  }

  const next: ProjectMark | null =
    kind === "icon" ? (icon ? { kind, icon, ...(color ? { color } : {}) } : null)
    : kind === "logo" ? (logo ? { kind, ...(logo.name ? { logo: logo.name } : {}), ...(color ? { color } : {}),
        ...(plate ? { plate } : {}) } : null)
    : color ? { kind: "letters", color } : null;
  const incomplete = (kind === "icon" && !icon) || (kind === "logo" && !logo);
  // A dropped logo only counts while LOGO is the chosen tab; a bare letters
  // mark (you went back to letters on a matched repo) reads as no mark.
  const dropping = kind === "logo" && !!logo?.data;
  const shown = (m: ProjectMark | null) => (m && !(m.kind === "letters" && !m.color) ? m : null);
  const unchanged = !dropping && JSON.stringify(next) === JSON.stringify(
    shown(cur) ? Object.fromEntries(Object.entries(cur!).filter(([k]) => k !== "source" && k !== "rv")) : null);
  // Only the background changed: the bridge keeps a followed mark following.
  const bare = (m: ProjectMark | null) =>
    JSON.stringify(Object.entries(m ?? {}).filter(([k]) => !["source", "rv", "plate"].includes(k)).sort());
  const plateOnly = !dropping && (plate ?? null) !== (cur?.plate ?? null) && bare(next) === bare(shown(cur));

  async function save(mark: ProjectMark | null, logoData?: string) {
    setBusy(true);
    setErr("");
    try {
      const res = await api.setProjectSettings({ project }, { mark, ...(logoData ? { logo_data: logoData } : {}) });
      if (!("mark" in res)) { setErr("Restart the bridge to save marks: it's older than them."); return; }
      putProjectMark(project, res.mark ?? null);
      onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function follow() {
    setBusy(true);
    try {
      await api.rivendellMarksAction("follow", { project });
      setProjectMarks((await api.projects()).marks);
      onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function link() {
    if (!target) return;
    setBusy(true);
    setErr("");
    try {
      await api.rivendellMarksAction("link", { project, instance: target.instance, rv_project: target.id });
      setProjectMarks((await api.projects()).marks);
      onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  // What the tile and the name print in: the chosen colour, readable on this
  // ground, or the hashed default when none is chosen.
  const tint = inkCss(color ?? hashTint(project));
  const lifted = color && HEX.test(color) ? liftInk(color, light) : null;
  // The logo's colours on every tab, not just LOGO: they wrap the row onto a
  // second line, and a tab that changed the editor's height moved it.
  const swatches = info?.colors ?? [];
  const preview = (
    <b className="ptile mk-tile" data-kind={kind === "letters" ? undefined : kind} style={{ ["--pc" as string]: tint }}
      data-logo={kind === "logo" && info?.fill ? "fill" : undefined} data-plate={kind === "logo" && plate ? plate : undefined}>
      {kind === "logo" && logo ? <img src={logo.url} alt="" />
        : kind === "icon" && icon ? <DynamicIcon name={icon as never} />
        : projectInitials(project)}
    </b>
  );

  return createPortal(
    <div ref={root} className="mk" style={pos ?? { top: -9999, left: -9999 }} onClick={(e) => e.stopPropagation()}
      onPaste={(e) => { const f = e.clipboardData.files[0]; if (f) { e.preventDefault(); void take(f); } }}
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => { e.preventDefault(); void take(e.dataTransfer.files[0]); }}>
      <div className="mk-hd">
        <div><small>Project mark</small><b>{name}</b></div>
        <button type="button" className="mk-x" onClick={onClose} title="close (esc)"><X size={15} /></button>
      </div>
      <div className="mk-bd">
        <div className="mk-seg" role="tablist">
          {([["letters", "LETTERS", Type], ["icon", "ICON", Shapes], ["logo", "LOGO", ImageIcon]] as const).map(([k, l, I]) => (
            <button key={k} type="button" role="tab" aria-selected={kind === k} data-on={kind === k || undefined}
              onClick={() => setKind(k)}><I size={13} aria-hidden />{l}</button>
          ))}
        </div>

        <div className="mk-pane">
          {kind === "letters" && (
            <div className="mk-drop mk-still">{preview}
              <div><b>Its initials</b><small>two letters from its name, the default for every project</small></div>
            </div>
          )}

          {kind === "icon" && (
            <>
              <label className="mk-search"><Search size={14} aria-hidden />
                <input autoFocus value={query} onChange={(e) => setQuery(e.target.value)} placeholder={`search ${iconNames.length.toLocaleString()} icons`} />
                <span>lucide</span>
              </label>
              <div className="mk-grid" style={{ ["--pc" as string]: tint }}>
                {icons.map((n) => (
                  <button key={n} type="button" title={n} data-on={icon === n || undefined} onClick={() => setIcon(n)}>
                    <DynamicIcon name={n as never} size={16} />
                  </button>
                ))}
                {icons.length === 0 && <span className="mk-none">no icon is called that</span>}
              </div>
            </>
          )}

          {kind === "logo" && (
            <>
              <button type="button" className="mk-drop" onClick={() => fileRef.current?.click()}>
                {logo ? preview : <span className="mk-ph"><ImageIcon size={20} aria-hidden /></span>}
                <div>
                  <b>{logo ? logo.label : "Drop a logo here"}</b>
                  <small>{logo ? <>drop, paste or <u>choose a file</u> to {following ? "use your own instead" : "replace it"}</>
                    : <>or paste one, or <u>choose a file</u> · PNG, SVG, JPG or WEBP up to 512 KB</>}</small>
                </div>
              </button>
              <input ref={fileRef} type="file" hidden accept="image/png,image/jpeg,image/webp,image/svg+xml"
                onChange={(e) => { void take(e.target.files?.[0]); e.target.value = ""; }} />
              <div className="mk-bgrow">
                <div className="mk-lbl">Background</div>
                <div className="mk-mini" role="radiogroup" aria-label="Background">
                  {([[null, "NONE"], ["light", "LIGHT"], ["dark", "DARK"]] as const).map(([v, l]) => (
                    <button key={l} type="button" role="radio" aria-checked={plate === v} data-on={plate === v || undefined}
                      onClick={() => setPlate(v)}>{l}</button>
                  ))}
                </div>
              </div>
            </>
          )}
        </div>

        {following && (
          <div className="mk-from"><i className="mk-gem" />
            <span><b>Follows Rivendell</b> · {cur?.rv?.own ? `${poss(cur.rv.name ?? "its")} own logo` : `client ${cur?.rv?.name ?? "?"}`}{riv?.synced_at ? ` · ${synced(riv.synced_at)}` : ""}</span>
          </div>
        )}
        {!following && match && (match.logo || match.color) && (
          <div className="mk-from"><i className="mk-gem" />
            <span>Rivendell has <b>{poss(match.client ?? "its client")}</b> {match.logo ? "logo" : "colour"}</span>
            <button type="button" className="mk-btn mk-ghostbtn" disabled={busy} onClick={() => void follow()}>USE IT</button>
          </div>
        )}
        {!following && riv?.unlinked?.includes(project) && !!riv.projects?.length && (
          <div className="mk-from"><i className="mk-gem" />
            <select value={pick} onChange={(e) => setPick(Number(e.target.value))} aria-label="Rivendell project"
              title="Links this repo to that project in Rivendell itself, so every Mystical on that Rivendell gets its client's logo">
              <option value={-1}>Link to a Rivendell project…</option>
              {riv.projects.map((p, i) => <option key={`${p.instance}:${p.id}`} value={i}>{p.client ? `${p.client} · ${p.name}` : p.name}</option>)}
            </select>
            <button type="button" className="mk-btn mk-ghostbtn" disabled={busy || !target} onClick={() => void link()}>LINK</button>
          </div>
        )}

        <div className="mk-lbl">Colour<span>{following && color === cur?.color ? `${poss(cur?.rv?.name ?? "the client")} brand colour`
          : swatches.length ? "read from the logo" : "yours to pick"}</span></div>
        <div className="mk-sws">
          <button type="button" className="mk-sw mk-auto" title="the default for this name" data-on={!color || undefined}
            style={{ ["--c" as string]: hashTint(project) }} onClick={() => { setColor(null); setHex(""); }} />
          {following && cur?.color && !swatches.includes(cur.color) && (
            <button type="button" className="mk-sw mk-big" data-on={color === cur.color || undefined} style={{ background: cur.color }}
              title={`${poss(cur.rv?.name ?? "the client")} brand colour`} onClick={() => { setColor(cur.color!); setHex(cur.color!); }} />
          )}
          {swatches.map((c) => (
            <button key={c} type="button" className="mk-sw mk-big" data-on={color === c || undefined} style={{ background: c }}
              title={c} onClick={() => { setColor(c); setHex(c); }} />
          ))}
          <span className="mk-sep" />
          {PALETTE.map((c) => (
            <button key={c} type="button" className="mk-sw" data-on={color === c || undefined} style={{ background: c }}
              onClick={() => { setColor(c); setHex(""); }} />
          ))}
        </div>
        <div className="mk-hexrow">
          <label className="mk-hex"><i style={{ background: color ?? "transparent" }} />
            <input value={hex} placeholder="#rrggbb" maxLength={7} spellCheck={false}
              onChange={(e) => { const v = e.target.value.trim(); setHex(v); if (HEX.test(v)) setColor(v.toLowerCase()); }} />
          </label>
          {lifted && (
            <span className="mk-ink">too {light ? "light" : "dark"} to read here, so names print in
              <i style={{ background: lifted }} />{lifted}</span>
          )}
        </div>

        <div className="mk-pv" style={{ ["--pc" as string]: tint }}>
          {preview}<span className="mk-pvname">{name}</span>
          <span className="mk-pvlb">PREVIEW</span>
        </div>
        {err && <div className="mk-err">{err}</div>}
      </div>
      <div className="mk-ft">
        <button type="button" className="mk-btn mk-pri" disabled={busy || incomplete || unchanged}
          onClick={() => void save(next, dropping ? logo?.data : undefined)}>SAVE</button>
        <button type="button" className="mk-btn mk-ghostbtn" onClick={onClose}>CANCEL</button>
        <span style={{ flex: 1 }} />
        {following ? (!plateOnly && <span className="mk-note">a change here stops it following</span>)
          : shown(cur) && <button type="button" className="mk-btn mk-ghostbtn" disabled={busy} onClick={() => void save(null)}>BACK TO LETTERS</button>}
      </div>
    </div>,
    document.body,
  );
}
