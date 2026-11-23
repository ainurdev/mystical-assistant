// The dashboard's URLs (ADR 0006): hash URLs, as in the Mini App.
//   #/                 the last session, or a fresh one
//   #/s/<id>           a session
//   #/settings/<page>  SETTINGS on that page, over the session that was open
// Pure, so `npm run check` covers URL to place and back; router.tsx and App
// do the navigating. Anything this doesn't know reads as #/: a hand-typed or
// stale URL lands on the app, never on a blank page.

export const SETTINGS_PAGES = ["appearance", "transcript", "notifications", "projects", "workspaces",
  "aimgmt", "skills", "agenttools", "integrations", "system", "move", "mac"] as const;
export type SettingsPage = typeof SETTINGS_PAGES[number];
// Names an older caller still opens SETTINGS on (openSettings("clock"), an
// older bridge's bot button): the modal maps each to its page and fold
// (normalizeTab), then the URL is replaced with the page it landed on.
const LEGACY_PAGES = ["plugins", "clock", "session", "accounts", "mcp", "ai"];

export type Place = { kind: "home" } | { kind: "session"; id: string } | { kind: "settings"; page?: string };

const ID = /^[\w-]+$/;
const isPage = (p: string) => (SETTINGS_PAGES as readonly string[]).includes(p) || LEGACY_PAGES.includes(p);

/** A router pathname (no "#") to the place it opens. */
export function placeOf(path: string): Place {
  const [, a, b, extra] = path.split("/");
  if (extra !== undefined && extra !== "") return { kind: "home" };
  const v = b ? decodeURIComponent(b) : "";
  if (a === "s" && ID.test(v)) return { kind: "session", id: v };
  if (a === "settings") return isPage(v) ? { kind: "settings", page: v } : { kind: "settings" };
  return { kind: "home" };
}

/** The pathname a place lives at. */
export function pathOf(p: Place): string {
  if (p.kind === "session") return `/s/${encodeURIComponent(p.id)}`;
  if (p.kind === "settings") return `/settings/${p.page && isPage(p.page) ? p.page : "appearance"}`;
  return "/";
}

/** An old `?s=<id>` link (OS banners, Telegram buttons, the Mac and Windows
 *  apps' deep links) as the URL it means now: `s` leaves the query, everything
 *  else (token, skipboot) stays, and the hash names the session. null: nothing
 *  to change. */
export function fromLegacy(href: string): string | null {
  const u = new URL(href);
  const id = u.searchParams.get("s");
  if (id === null) return null;
  u.searchParams.delete("s");
  u.hash = ID.test(id) ? `#${pathOf({ kind: "session", id })}` : u.hash;
  return u.toString();
}

// On any route, the search carries the right rail's tab and at most one pop-up:
//   ?rail=<tab>                   the rail's tab (lib/theme RIGHT_TABS)
//   ?analyze=<project>            the project window
//   ?edit=<project>:<path>        the project window, its editor on that file
//   ?pic=<turn id>.<picture key>  the picture viewer (lib/nav picKey)
// Unknown values read as absent. A project rel or a turn id never holds ":" or ".".
export type Popup =
  | { kind: "analyze"; project: string }
  | { kind: "edit"; project: string; path: string }
  | { kind: "pic"; turn: string; pic: string };
export type Extras = { rail?: string; popup?: Popup };

const PROJECT = /^[^:]+$/;

/** A router search string ("?a=b" or "") to its rail tab and pop-up. */
export function extrasOf(search: string, rails: readonly string[]): Extras {
  const q = new URLSearchParams(search);
  const out: Extras = {};
  const rail = q.get("rail");
  if (rail && rails.includes(rail)) out.rail = rail;
  const analyze = q.get("analyze");
  const [project, ...rest] = (q.get("edit") ?? "").split(":");
  const path = rest.join(":");
  const [turn, pic, more] = (q.get("pic") ?? "").split(".");
  if (analyze && PROJECT.test(analyze)) out.popup = { kind: "analyze", project: analyze };
  else if (project && path) out.popup = { kind: "edit", project, path };
  else if (turn && ID.test(turn) && pic && /^\w+$/.test(pic) && more === undefined) out.popup = { kind: "pic", turn, pic };
  return out;
}

/** The search string a rail tab and pop-up live at ("" for neither). */
export function searchOf(e: Extras): string {
  const q = new URLSearchParams();
  if (e.rail) q.set("rail", e.rail);
  const p = e.popup;
  if (p?.kind === "analyze") q.set("analyze", p.project);
  else if (p?.kind === "edit") q.set("edit", `${p.project}:${p.path}`);
  else if (p?.kind === "pic") q.set("pic", `${p.turn}.${p.pic}`);
  const s = q.toString();
  return s ? `?${s}` : "";
}
