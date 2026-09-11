/** One sound per notification, picked from the PeonPing catalog.
 *
 *  Two sources, deliberately kept side by side: the four synthesised TONES in
 *  push.ts (nothing to fetch, works offline, the historical default) and the
 *  ~350 community voice packs at peonping.com. Both are addressed by one
 *  string so the settings only ever store one field per event:
 *
 *    "off"           — this event stays silent
 *    "tone:blip"     — a synthesised tone from push.ts
 *    "https://…mp3"  — a pack sound, served straight from raw.githubusercontent
 *
 *  Nothing is downloaded to disk and nothing is proxied through the bridge:
 *  the registry, the pack manifests and the mp3s are all CORS-open, so the
 *  browser fetches them itself and its own HTTP cache is the only cache that
 *  matters.
 */

// Extension spelt out so `sounds.check.ts` runs under bare node, which won't
// resolve an extensionless path the way Vite does.
import { chime, type ToneKey } from "./push.ts";

/** The six moments the dashboard can make a noise about. `cat` is the PeonPing
 *  category written for that moment — the picker opens there, but any sound in
 *  a pack can be assigned to any event. */
export const PUSH_EVENTS = {
  done: { label: "DONE", hint: "a session finished while you weren't watching", cat: "task.complete" },
  question: { label: "QUESTION", hint: "a session is waiting on an answer", cat: "input.required" },
  permission: { label: "APPROVAL", hint: "a session is waiting on a yes/no", cat: "input.required" },
  failure: { label: "FAILURE", hint: "something the dashboard tried went wrong", cat: "task.error" },
  start: { label: "START", hint: "a session picked up a turn", cat: "session.start" },
  limit: { label: "LIMIT", hint: "a session parked on a usage limit or API error", cat: "resource.limit" },
} as const;

export type PushEvent = keyof typeof PUSH_EVENTS;
export const PUSH_EVENT_KEYS = Object.keys(PUSH_EVENTS) as PushEvent[];

/** What the settings store per event. `label` is carried alongside `src` so the
 *  row can name the sound without re-fetching a 500KB registry to look it up. */
export interface SoundChoice {
  src: string;
  label: string;
}

export const OFF: SoundChoice = { src: "off", label: "OFF" };

// ---- catalog ----------------------------------------------------------------

const REGISTRY = "https://peonping.github.io/registry/index.json";
const RAW = "https://raw.githubusercontent.com";

export interface Pack {
  name: string;
  display_name: string;
  description?: string;
  categories: string[];
  sound_count?: number;
  tags?: string[];
  trust_tier?: string;
  source_repo: string;
  source_ref: string;
  source_path?: string;
}

export interface PackSound {
  file: string;
  label?: string;
}

/** Where a pack's files live. Sound paths in the manifest are relative to it. */
export function packBase(p: Pack): string {
  const sub = p.source_path && p.source_path !== "." ? `/${p.source_path}` : "";
  return `${RAW}/${p.source_repo}/${p.source_ref}${sub}`;
}

// ponytail: module-level promises, not localStorage. The registry is ~500KB of
// JSON that GitHub Pages serves with an ETag — the browser's HTTP cache already
// does the persistence, and this just stops one modal session refetching it.
let registryReq: Promise<Pack[]> | null = null;
const manifestReq = new Map<string, Promise<Record<string, PackSound[]>>>();

/** Every pack in the catalog, newest listing first fetch wins. */
export function loadPacks(): Promise<Pack[]> {
  registryReq ??= fetch(REGISTRY)
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`registry ${r.status}`))))
    .then((d: { packs?: Pack[] }) => d.packs ?? [])
    .catch((e) => { registryReq = null; throw e; });
  return registryReq;
}

/** A pack's sounds, grouped by category. Categories a pack doesn't ship are
 *  simply absent — the picker falls back to showing everything it has. */
export function loadPackSounds(p: Pack): Promise<Record<string, PackSound[]>> {
  const base = packBase(p);
  let req = manifestReq.get(base);
  if (!req) {
    req = fetch(`${base}/openpeon.json`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`manifest ${r.status}`))))
      .then((m: { categories?: Record<string, { sounds?: PackSound[] }> }) =>
        Object.fromEntries(
          Object.entries(m.categories ?? {}).map(([c, v]) => [c, v.sounds ?? []]),
        ))
      .catch((e) => { manifestReq.delete(base); throw e; });
    manifestReq.set(base, req);
  }
  return req;
}

/** Flatten a manifest to one list, the event's own category first. Assigning a
 *  victory line to FAILURE is your business, so nothing is filtered out. */
export function soundsFor(
  byCat: Record<string, PackSound[]>,
  cat: string,
): { cat: string; sounds: PackSound[] }[] {
  const keys = Object.keys(byCat).sort((a, b) =>
    a === cat ? -1 : b === cat ? 1 : a.localeCompare(b));
  return keys.filter((k) => byCat[k]?.length).map((k) => ({ cat: k, sounds: byCat[k] }));
}

/** What each PeonPing category is FOR, in the picker's words. The raw key names
 *  the hook that fires it — "user.spam" is peon-ping's rapid-prompt detector —
 *  not what its lines sound like. Hints follow peon-ping's own category list;
 *  a key it doesn't know shows as itself, with no hint made up for it. */
const CATS: Record<string, [label: string, hint: string]> = {
  "task.complete": ["FINISHED", "a task is done"],
  "input.required": ["NEEDS INPUT", "waiting on a permission or an answer"],
  "task.error": ["ERROR", "something failed"],
  "resource.limit": ["LIMIT", "a limit hit, or the context compacting"],
  "session.start": ["GREETING", "a session opens"],
  "session.end": ["GOODBYE", "a session closes"],
  "task.acknowledge": ["ACKNOWLEDGE", "a prompt was received"],
  "task.progress": ["PROGRESS", "still working"],
  "user.spam": ["ANNOYED", "prompts sent too fast"],
};

export function catLabel(cat: string): { label: string; hint?: string } {
  const c = CATS[cat];
  return c ? { label: c[0], hint: c[1] } : { label: cat.toUpperCase() };
}

/** Where a manifest's `file` actually sits in the repo. Packs spell it three
 *  ways — "sounds/x.mp3", a bare "x.mp3", and occasionally "./sounds/x.mp3" —
 *  but every one of them stores the file at sounds/<basename>. This is the rule
 *  peon-ping's own downloader applies (scripts/pack-download.sh), and taking the
 *  manifest path literally 404s on the packs that use the bare form.
 *  Encoded per segment: plenty of sound files carry spaces and apostrophes. */
export function soundPath(file: string): string {
  const clean = file.replace(/^\.?\//, "");
  const rel = clean.startsWith("sounds/") ? clean.slice(7) : clean.split("/").pop() || clean;
  return `sounds/${rel.split("/").map(encodeURIComponent).join("/")}`;
}

/** The choice a picked pack sound becomes. Pack name in the label because
 *  "Fantastic" alone doesn't say whose voice it is. */
export function packChoice(p: Pack, s: PackSound): SoundChoice {
  const name = s.label
    || s.file.split("/").pop()?.replace(/\.[a-z0-9]+$/i, "")
    || s.file;
  return { src: `${packBase(p)}/${soundPath(s.file)}`, label: `${p.display_name} · ${name}` };
}

// ---- playback ---------------------------------------------------------------

// One element per URL: replaying sets currentTime rather than building a new
// element, so a sound is fetched once and every later ping is instant.
const els = new Map<string, HTMLAudioElement>();

function element(src: string): HTMLAudioElement {
  let el = els.get(src);
  if (!el) {
    el = new Audio(src);
    el.preload = "auto";
    els.set(src, el);
  } else if (el.error) {
    // The one reset worth making: it never arrived (offline when the page
    // opened), so ask again rather than blip in its place for the rest of the day.
    el.load();
  }
  return el;
}

/** Warm a sound so the first real notification isn't the download. Making the
 *  element IS the warm-up — preload="auto" starts the fetch. Never load() one
 *  that exists: that resets it, and picking a sound in the settings both plays
 *  it and re-runs this, so the element being reset is the preview. */
export function preloadSound(src: string | undefined): void {
  if (src && src.startsWith("http")) { try { element(src); } catch { /* ignore */ } }
}

/** Play one choice. `fallback` is the legacy single tone, used when an event has
 *  never been assigned — so an untouched install sounds exactly as it did. */
export function playSound(
  choice: SoundChoice | undefined,
  volume: number,
  fallback: ToneKey,
): void {
  const src = choice?.src ?? `tone:${fallback}`;
  if (src === "off" || volume <= 0) return;
  if (src.startsWith("tone:")) { chime(src.slice(5) as ToneKey, volume); return; }
  try {
    const el = element(src);
    el.volume = Math.max(0, Math.min(1, volume));
    el.currentTime = 0;
    // A pack sound that won't load (offline, repo retagged, autoplay blocked)
    // still has to make a noise — silence reads as "nothing happened".
    void el.play().catch(() => chime(fallback, volume));
  } catch {
    chime(fallback, volume);
  }
}

// The audition playing now, held as the function that stops it.
let auditioning: (() => void) | null = null;

/** The settings picker's ▶. Unlike playSound it holds one slot — auditioning is
 *  clicking down a pack's lines, and the one you just clicked should cut the
 *  last off, not talk over it — and it can be stopped: pass null. `onEnd` hears
 *  exactly once when this audition stops, however it stops; `ok` is false only
 *  when the sound itself is broken (its file 404s, won't decode, never came).
 *  No fallback blip here: in the picker a blip in place of the line you tapped
 *  is a lie about that line. A tone is a blip anyway, so it ends as it starts. */
export function audition(
  src: string | null,
  volume: number,
  onEnd?: (ok: boolean) => void,
): void {
  auditioning?.();
  if (!src) return;
  if (src.startsWith("tone:")) { chime(src.slice(5) as ToneKey, volume); onEnd?.(true); return; }
  const el = element(src);
  const end = (ok: boolean) => {
    if (auditioning !== stop) return;   // already cut off: its late AbortError is noise
    auditioning = null;
    el.removeEventListener("ended", ended);
    onEnd?.(ok);
  };
  const stop = () => { end(true); el.pause(); };
  const ended = () => end(true);
  auditioning = stop;
  el.addEventListener("ended", ended);
  el.volume = Math.max(0, Math.min(1, volume));
  el.currentTime = 0;
  // Broken is the element's verdict, not the rejection's: a real element sets
  // .error before it rejects over a bad file, while a refusal (no user gesture
  // behind the play, a pause cutting it off) rejects with the file untouched.
  el.play().catch(() => end(!el.error));
}
