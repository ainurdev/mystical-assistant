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
