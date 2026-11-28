import type { Breadcrumb, BreadcrumbHint, BrowserOptions, ErrorEvent, EventHint } from "@sentry/browser";

/* Reports, the page's half (ADR 0005; bridge/reports.py is the bridge's half
 * and the gate). The page asks GET /local/reports at start; only a team
 * install answers on, and only then does @sentry/browser load, as its own
 * chunk, the way lib/usage.ts loads PostHog after a yes. Everywhere else
 * Sentry's code never reaches the page. A page under automation
 * (navigator.webdriver: headless Chrome, a driven browser, macos/eyes' WebKit
 * kit) doesn't ask at all: an agent's screenshots are no one's start-ups, and
 * 60 of a teammate's 76 on 2026-11-26 were theirs.
 *
 * What the SDK may do is catch crashes: window errors, failed promises (its
 * global handlers), React's root callbacks and route errors (main.tsx, through
 * lib/crash.ts). No console capture, no replay, no profiling, no tracing:
 * every default integration is off and only the ones below are named.
 * Breadcrumbs are navigations (the hash route), bridge calls (path only) and
 * clicks (the control's role and data-ctx-type, never its text); anything else
 * is dropped. Slow spots (lib/slow.ts) go out as warnings, capped here with
 * the crashes: the same one by name once in 10 minutes, 100 reports an hour.
 *
 * The scrubber is bridge/reports.py's rules again, on every report before it
 * leaves: the token this page holds, known token shapes, every URL's query,
 * a prompt's first line, every string capped. A script chunk missing after a
 * newer build is the reload guard's business, never a crash.
 *
 * Kept free of runtime imports so lib/reports.check.ts can run it under node. */

const FILTERED = "[Filtered]";
const SAME_EVERY = 60_000; // the same crash at most once a minute
const SLOW_EVERY = 600_000; // the same slow spot, by name, at most once in 10 minutes
const HOUR_CAP = 100;       // reports an hour from the page
const CAP = 1000;          // every string, a message included
const PROMPT_CAP = 120;    // a prompt keeps its first line, this long at most
const SHAPES: [RegExp, string][] = [
  [/sk-ant-[\w-]+/g, FILTERED],
  [/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_\w{20,})/g, FILTERED],
  [/\bBearer\s+[\w.~+/=-]+/gi, "Bearer " + FILTERED],
  [/\bbot\d+:[\w-]+/g, "bot" + FILTERED],
];
const QUERY = /(\b[a-z][a-z0-9+.-]*:\/\/[^\s?#"'<>]*)\?[^\s#"'<>]*/gi;
const LOCAL_QUERY = /(\/local\/[^\s?#"'<>]*)\?[^\s#"'<>]*/g;   // a bridge call's query can carry search or prompt text
const TOKEN_PARAM = /([?&]token=)[^&#\s"'<>]*/gi;   // any other relative URL keeps its query, but never its token

function text(s: string, key: string, held: string[]): string {
  for (const sec of held) s = s.split(sec).join(FILTERED);
  for (const [rx, sub] of SHAPES) s = s.replace(rx, sub);
  s = s.replace(QUERY, "$1").replace(LOCAL_QUERY, "$1").replace(TOKEN_PARAM, `$1${FILTERED}`);
  return key === "prompt" ? s.split("\n", 1)[0].slice(0, PROMPT_CAP) : s.slice(0, CAP);
}

function scrub(v: unknown, held: string[], key = ""): unknown {
  if (typeof v === "string") return text(v, key, held);
  if (Array.isArray(v)) return v.map((x) => scrub(x, held, key));
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, scrub(x, held, k)]));
  return v;
}

/** A script chunk gone after a newer build: each engine words it its own way,
 *  and vite says it of a stylesheet. Never sent (the reload guard's case). */
export function isMissingChunk(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : typeof err === "string" ? err : "";
  return /Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module|Unable to preload CSS/i.test(msg);
}

/** A URL as a hash route: `#/s/<id>`, nothing before it, no query. */
function hashRoute(url: unknown): string {
  const h = String(url ?? "").split("#")[1] ?? "/";
  return "#" + h.split("?")[0];
}

/** A bridge call as its path, or null for anything not the bridge's. */
function bridgePath(url: unknown, origin: string): string | null {
  try {
    const u = new URL(String(url ?? ""), origin);
    return u.origin === origin ? u.pathname : null;
  } catch { return null; }
}

interface Control { getAttribute(n: string): string | null; tagName: string; closest?(sel: string): Control | null }
const IMPLIED: Record<string, string> = { BUTTON: "button", A: "link", INPUT: "textbox", SELECT: "combobox", TEXTAREA: "textbox" };

/** A click as the control it hit: its role and data-ctx-type, never its text. */
export function controlOf(target: unknown): string {
  const t = target as Control | null;
  const el = t?.closest?.("[data-ctx-type],[role],button,a,input,select,textarea") ?? t;
  if (!el?.getAttribute) return "unknown";
  const role = el.getAttribute("role") || IMPLIED[el.tagName] || el.tagName.toLowerCase();
  const ctx = el.getAttribute("data-ctx-type");
  return ctx ? `${role} [${ctx}]` : role;
}

/** before_breadcrumb: the three kinds kept, each cut to what it may say. */
export function keepBreadcrumb(crumb: Breadcrumb, hint: BreadcrumbHint | undefined, origin: string): Breadcrumb | null {
  const { category, data } = crumb;
  if (category === "navigation") {
    return { ...crumb, data: { from: hashRoute(data?.from), to: hashRoute(data?.to) } };
  }
  if (category === "fetch" || category === "xhr") {
    const path = bridgePath(data?.url, origin);
    return path ? { ...crumb, data: { method: data?.method, url: path, status_code: data?.status_code } } : null;
  }
  if (category === "ui.click") {
    return { ...crumb, message: controlOf((hint?.event as Event | undefined)?.target), data: undefined };
  }
  return null;
}

/** Where the page runs, as the report's `app` and `os` tags. */
export function tagsFor(ua: string, bridgeOs: string): Record<string, string> {
  const app = /\bMysticalMac\//.test(ua) ? "Mystical.app"
    : /\bMysticalWin\//.test(ua) ? "Mystical.exe"
    : /\bMysticalLinux\//.test(ua) ? "linux window"
    : "browser";
  return { side: "page", os: /\bWindows\b/.test(ua) ? "windows" : bridgeOs, app };
}

/** The engine's own notice that a ResizeObserver's callback resized what it observes:
 *  the sizes it could not deliver go out with the next frame, and nothing broke. It
 *  reaches window.onerror with no error object, so it is read off the report. */
function isResizeNotice(e: ErrorEvent): boolean {
  return /^ResizeObserver loop (completed with undelivered notifications|limit exceeded)/.test(e.exception?.values?.at(-1)?.value ?? e.message ?? "");
}

/** before_send: missing chunks and the resize notice dropped, everything else scrubbed and stamped. */
export function scrubReport(event: ErrorEvent, hint: EventHint | undefined, held: string[]): ErrorEvent | null {
  if (isMissingChunk(hint?.originalException) || isResizeNotice(event)) return null;
  // the crumbs were cut by keepBreadcrumb as they were left; any other kind goes here
  const breadcrumbs = event.breadcrumbs?.filter((b) => KEPT.has(b.category ?? ""));
  return scrub({ ...event, breadcrumbs }, held) as ErrorEvent;
}
const KEPT = new Set(["navigation", "fetch", "xhr", "ui.click"]);

/** A mark for `start-up: page` (lib/slow.ts), once per name: when the page
 *  next paints, or now. Left on every install; only a team install reads them. */
export function markStartup(name: string, painted = true): void {
  const m = "startup:" + name;
  const put = () => { if (!performance.getEntriesByName(m, "mark").length) performance.mark(m); };
  if (painted) requestAnimationFrame(() => setTimeout(put)); else put();
}

export interface ReportsStatus { on: boolean; dsn?: string; user?: string; os?: string }

/** The options @sentry/browser starts with; integrations are added by startReports. */
export function options(s: ReportsStatus, token: string, ua: string, origin: string): BrowserOptions {
  const held = token.length >= 8 ? [token] : [];
  const last = new Map<string, number>();
  const sent: number[] = [];
  const fresh = (e: ErrorEvent) => {   // the same crash: its type, message and where it was thrown; a slow spot: its name
    const x = e.exception?.values?.at(-1);
    const top = x?.stacktrace?.frames?.at(-1);
    const key = x ? `${x.type}: ${x.value}@${top?.filename}:${top?.lineno}:${top?.colno}` : String(e.message);
    const every = e.tags?.kind === "slow spot" ? SLOW_EVERY : SAME_EVERY;
    const now = Date.now();
    while (sent.length && now - sent[0] >= 3_600_000) sent.shift();
    if (sent.length >= HOUR_CAP || now - (last.get(key) ?? -every) < every) return false;
    last.set(key, now);
    sent.push(now);
    return true;
  };
  return {
    dsn: s.dsn,
    defaultIntegrations: false,
    dataCollection: { userInfo: false, cookies: false, httpHeaders: false, httpBodies: [], urlQueryParams: false },
    sendClientReports: false,
    // the release is the commit the page was built from: Sentry's Vite plugin writes it into the bundle
    initialScope: { tags: tagsFor(ua, s.os ?? ""), user: { username: s.user ?? "" } },
    beforeBreadcrumb: (crumb, hint) => keepBreadcrumb(crumb, hint, origin),
    beforeSend: (event, hint) => {
      // SDK 11 stacks every message; a slow spot's is the observer's own, and Sentry would title the issue from it
      if (event.tags?.kind === "slow spot") delete event.exception;
      return fresh(event) ? scrubReport(event, hint, held) : null;
    },
  };
}

/** At start: ask the bridge, and load Sentry only on a team install. `settle`
 *  is lib/crash.ts's, handed in so this module stays importable under node. */
export async function startReports(settle: (sink: ((err: unknown) => void) | null) => void): Promise<void> {
  if (navigator.webdriver) return settle(null);   // an agent's look at the page (a screenshot kit, a driven check)
  let s: ReportsStatus = { on: false };
  try {
    const res = await fetch("/local/reports");
    if (res.ok) s = await res.json();
  } catch { /* a bridge that can't answer reports nothing */ }
  if (!s.on || !s.dsn) return settle(null);
  try {
    const Sentry = await import("@sentry/browser");
    const token = new URLSearchParams(location.search).get("token") ?? "";
    Sentry.init({
      ...options(s, token, navigator.userAgent, location.origin),
      integrations: [
        Sentry.globalHandlersIntegration(),
        Sentry.breadcrumbsIntegration({ dom: true, fetch: true, history: true, xhr: false, sentry: false }),
        Sentry.dedupeIntegration(),
        Sentry.linkedErrorsIntegration(),
      ],
    });
    settle((err) => { Sentry.captureException(err); });
    // slow spots shaped as the bridge's are (bridge/reports.py _slow), so both sides group alike;
    // a chunk gone after a newer build just means none this load
    import("./slow").then(({ watchSlowSpots }) => watchSlowSpots((s) => Sentry.captureMessage(s.name, {
      level: "warning", fingerprint: [s.name],
      tags: { surface: s.surface, kind: "slow spot" },
      contexts: { slow: { ms: s.ms, ...s.context } },
    })), () => {});
  } catch {
    settle(null);   // a page older than the build can't load the chunk: the next load starts it
  }
}
