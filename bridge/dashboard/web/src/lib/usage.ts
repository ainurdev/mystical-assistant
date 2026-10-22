import type { BeforeSendFn, PostHog, PostHogConfig, Properties } from "posthog-js/dist/module.full.no-external";

/* Opt-in usage sharing: what PostHog may see once an install says yes
 * (bridge/usagesharing.py keeps the answer, hud/UsageSharing.tsx asks).
 *
 * PostHog loads only after that yes, as its own chunk, and from the build that
 * never fetches code: the recorder ships in the bundle (module.full.no-external)
 * and external loading is off. This page can drive Claude on this machine, so
 * nothing from outside the repo runs in it.
 *
 * What it may see is the feature: clicks and replays, never words. Every text
 * node and input is masked, pictures are blocked, attributes survive only where
 * they draw the page, and every URL loses its host, query and hash: the login
 * token rides in `?token=` (api.ts). Console logs, network timing and
 * exceptions stay off whatever the PostHog project says, because each of them
 * carries paths and text.
 *
 * Kept free of runtime imports so tools/usage.check.mjs can run it under node. */

const KEY = "phc_BocaW3peteivJWvVED5FDZLg2qmUAMyMY26mLGWGj8gj"; // public by design: it can send events, never read them
const HOST = "https://eu.i.posthog.com";
const BASE = "https://mystical.local";
const TITLE = "mystical//assistant";

/** Any URL as PostHog may see it: a made-up host and the path, nothing after. */
export function scrubUrl(url: string): string {
  try { return BASE + new URL(url, BASE).pathname; } catch { return BASE + "/"; }
}

// What a replay needs to draw the page, kept as written. Every other attribute
// is where this dashboard writes paths, titles, names and tooltips (title,
// aria-label, href, src, alt, placeholder, data-ctx-label, data-tip, data-who…).
const DRAWS = new Set([
  "class", "role", "type", "width", "height", "viewbox", "d", "fill", "stroke", "stroke-width",
  "stroke-linecap", "stroke-linejoin", "points", "x", "y", "x1", "y1", "x2", "y2", "cx", "cy", "r",
  "rx", "ry", "transform", "opacity", "fill-rule", "clip-rule", "xmlns", "preserveaspectratio",
  "aria-hidden", "aria-expanded", "aria-checked", "aria-selected", "aria-pressed", "aria-disabled",
  "disabled", "tabindex", "_csstext",
  // rrweb's own layout notes (its "generated" set)
  "rr_width", "rr_height", "rr_left", "rr_top", "rr_position", "rr_transform", "rr_display",
  "rr_scrollleft", "rr_scrolltop", "rr_mediastate", "rr_open_mode",
]);
// The data-* the themes select on, and only while they hold a keyword.
const KEYWORDS = new Set(["data-theme", "data-fam", "data-bg", "data-layout", "data-style", "data-state",
  "data-kind", "data-tone", "data-shape", "data-tier", "data-isle", "data-light"]);

/** rrweb's maskAttributeFn: every attribute of every recorded element passes here. */
export function maskAttribute(name: string, value: string): string {
  const n = name.toLowerCase();
  if (n === "style") return value.replace(/url\([^)]*\)/gi, "url()");
  if (n === "_csstext") return value.replace(/https?:\/\/[^/"')\s]+/gi, BASE);   // rrweb makes font URLs absolute: keep the path, drop the host
  if (n === "id") return value === "root" ? value : "*";
  if (DRAWS.has(n) || (KEYWORDS.has(n) && /^[\w-]{0,24}$/.test(value))) return value;
  return "*";
}

const URLISH = /^https?:\/\//i;

// Every key and value at any depth, since PostHog also keys data by the page
// URL ($heatmap_data was one). The replay's own data is masked as it records.
function scrub(v: unknown, key = ""): unknown {
  if (typeof v === "string") {
    if (URLISH.test(v)) return scrubUrl(v);
    if (/(^\$|_)host$/.test(key)) return "mystical.local";   // $host, $initial_host, $session_entry_host
    if (key.endsWith("referring_domain")) return "$direct";
    return key === "title" ? TITLE : v;                       // document.title is the open session's title
  }
  if (Array.isArray(v)) return v.map((x) => scrub(x));
  if (v && typeof v === "object") {
    return Object.fromEntries(Object.entries(v).map(([k, x]) =>
      [URLISH.test(k) ? scrubUrl(k) : k, k === "$snapshot_data" ? x : scrub(x, k)]));
  }
  return v;
}

/** before_send: every event, replays included, on its way out. */
export const scrubEvent: BeforeSendFn = (e) => e && {
  ...e,
  properties: scrub(e.properties) as Properties,
  $set: scrub(e.$set) as Properties | undefined,
  $set_once: scrub(e.$set_once) as Properties | undefined,
};

export const CONFIG: Partial<PostHogConfig> = {
  api_host: HOST,
  persistence: "localStorage",            // no cookie: on localhost one would reach every port's dev server
  person_profiles: "identified_only",     // and nothing ever identifies, so every install stays anonymous
  disable_external_dependency_loading: true,
  disable_surveys: true,
  disable_product_tours: true,
  disable_conversations: true,
  save_referrer: false,
  mask_all_text: true,                    // autocapture: no element text
  mask_all_element_attributes: true,      // autocapture: no href, title, aria-label…
  capture_exceptions: false,
  capture_performance: false,
  capture_heatmaps: false,                // PostHog draws them over the live site, which a localhost dashboard isn't
  enable_recording_console_log: false,
  before_send: scrubEvent,
  session_recording: {
    maskAllInputs: true,
    maskTextSelector: "*",
    blockSelector: "img, image, picture, video, audio, canvas, iframe, object, embed",
    maskAttributeFn: maskAttribute,
    // also the hook for the page address each replay starts with
    maskCapturedNetworkRequestFn: (r) => ({ ...r, name: scrubUrl(r.name ?? "") }),
    recordHeaders: false,
    recordBody: false,
  },
};

let ph: PostHog | null = null;

/** Load PostHog and start sending. Only after the install's answer is yes. */
export async function startUsage(): Promise<void> {
  if (ph) {
    ph.opt_in_capturing();
    ph.startSessionRecording();
    return;
  }
  const { default: posthog } = await import("posthog-js/dist/module.full.no-external");
  posthog.init(KEY, CONFIG);
  if (posthog.has_opted_out_capturing()) posthog.opt_in_capturing();   // switched off, then on, in an earlier page
  ph = posthog;
}

/** Stop at once in this page; the next load doesn't load PostHog at all. */
export function stopUsage(): void {
  ph?.stopSessionRecording();
  ph?.opt_out_capturing();
}
