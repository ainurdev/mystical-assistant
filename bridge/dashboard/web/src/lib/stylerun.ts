/* STYLE WITH AI from the page's side. The bridge runs the model
   (bridge/logostyle.py), but only a browser can draw an SVG, so the page draws
   the contact sheet the model reads: every project's candidates, numbered,
   each on a dark ground and a light one. Then it follows the run twice a
   second and refreshes the project tiles as each answer lands.

   A module, not a component's state: the run goes on when SETTINGS closes, a
   reload reattaches to it, and the bell (Notifications.tsx) draws the same run,
   fed between reads by /local/running's `styling` (App). */

import { useSyncExternalStore } from "react";
import { api, projectLogoUrl, type StyleCandidates, type StyleLive, type StyleRun } from "../api";
import { setProjectMarks } from "./surfaces";

export interface StyleState {
  run: StyleRun | null;            // the bridge's run, as last read
  live: StyleLive | null;          // the bell's view of a run on
  drawing: boolean;                // the page is drawing the sheet
  error: string;                   // the page's own failure: the sheet, or a start the bridge refused
  dismissed: boolean;              // the strip was closed on this run
  landed: Record<string, number>;  // project -> when its answer landed, for the flip
}

const SEEN_KEY = "hud-style-seen";   // the last run whose strip was closed, so a reload keeps it closed
let state: StyleState = { run: null, live: null, drawing: false, error: "", dismissed: false, landed: {} };
const subs = new Set<() => void>();
const set = (patch: Partial<StyleState>) => { state = { ...state, ...patch }; subs.forEach((fn) => fn()); };
let asked = false;
let timer = 0;

function subscribe(fn: () => void): () => void {
  subs.add(fn);
  if (!asked) {
    asked = true;
    void api.styleRun().then((run) => {
      if (run.state === "idle") return;
      set({ run, dismissed: !!run.id && localStorage.getItem(SEEN_KEY) === run.id });
      if (run.state === "running") follow();
    }).catch(() => { /* a bridge older than the stylist: no run to show */ });
  }
  return () => { subs.delete(fn); };
}

export function useStyle(): StyleState {
  return useSyncExternalStore(subscribe, () => state);
}

const liveOf = (r: StyleRun): StyleLive | null => r.state !== "running" || !r.id ? null : {
  id: r.id, total: r.total ?? 0, decided: r.items?.length ?? 0, changed: (r.items ?? []).filter((i) => i.how.length).length,
  started: r.started ?? 0,
};

/** /local/running's view, every 4 s: keeps the bell current, and picks up a run another window started. */
export function noteStyling(live: StyleLive | null | undefined): void {
  if ((live ?? null) === null && state.live === null) return;
  set({ live: live ?? null });
  if (live && !timer) follow();
}

const refreshMarks = async () => { try { setProjectMarks((await api.projects()).marks); } catch { /* the next listing */ } };

function follow(): void {
  if (timer) return;
  const tick = async () => {
    try {
      const run = await api.styleRun();
      const same = run.id === state.run?.id;
      const before = same ? state.run?.items?.length ?? 0 : 0;
      const items = run.items ?? [];
      const landed = same ? { ...state.landed } : {};
      for (const it of items.slice(before)) landed[it.rel] = Date.now();
      set({ run, live: liveOf(run), landed });
      if (items.length !== before || run.state !== "running") await refreshMarks();
      if (run.state !== "running") { window.clearInterval(timer); timer = 0; }
    } catch { /* the next tick */ }
  };
  timer = window.setInterval(tick, 500);
  void tick();
}

// The login the last press picked (undefined: the default one), so Try again runs on it too.
// shortcut: a reload forgets it and Try again runs on the default login; keep it on the bridge's run if that bites.
let lastAccount: number | undefined;

/** The toolbar's button: draw the sheet, start the run on login `account` (a
 *  slot; null: the default login; left out, as Try again does: the last press's), follow it. */
export async function startStyle(account?: number | null): Promise<void> {
  if (state.drawing || state.run?.state === "running") return;
  if (account !== undefined) lastAccount = account ?? undefined;
  set({ drawing: true, error: "", dismissed: false, landed: {} });
  try {
    const c = await api.styleCandidates();
    const { sheet, hashes } = await drawSheet(c);
    const run = await api.styleStart(sheet, c.sig, hashes, lastAccount);
    set({ run, drawing: false, live: liveOf(run) });
    follow();
  } catch (e) {
    set({ drawing: false, error: e instanceof Error ? e.message : String(e) });
  }
}

export async function stopStyle(): Promise<void> {
  try { set({ run: await api.styleStop() }); } catch (e) { set({ error: e instanceof Error ? e.message : String(e) }); }
}

/** Undo the run, or one project of it. The bridge says what's undone, so a reload or a restart agrees. */
export async function undoStyle(rel?: string): Promise<void> {
  try {
    await api.styleUndo(rel);
    set({ run: await api.styleRun() });
    await refreshMarks();
  } catch (e) {
    set({ error: e instanceof Error ? e.message : String(e) });
  }
}

/** The strip's ×: this run's strip stays closed, here and after a reload. */
export function dismissStyle(): void {
  if (state.run?.id) try { localStorage.setItem(SEEN_KEY, state.run.id); } catch { /* ignore */ }
  set({ dismissed: true, error: "" });
}

/** Opened from the bell's row: show the run again even if its strip was closed. */
export function showStyle(): void {
  set({ dismissed: false });
}

// ---- the contact sheet ------------------------------------------------------------

const TILE = 32;                          // one candidate on one ground
const BOX = TILE * 2 + 4 + 12;            // a candidate's framed box: its id on top, both grounds below
const STEP = BOX + 8;
// shortcut: two columns stay under the API's 1568px edge up to ~32 projects; past that the image is
// scaled down and the ids shrink. Split the sheet into two calls if a bridge lists more.
const ROW = 96, COLW = 716, COLS = 2;

/** A picture's 16x16 average hash, as 64 hex digits: the bridge takes a pick
 *  within a few bits of what a project wears for a copy of it (bridge/logostyle.py). */
function averageHash(img: HTMLImageElement): string {
  const S = 16, cv = document.createElement("canvas");
  cv.width = cv.height = S;
  const g = cv.getContext("2d", { willReadFrequently: true })!;
  g.fillStyle = "#808080";
  g.fillRect(0, 0, S, S);
  const w = img.naturalWidth || S, h = img.naturalHeight || S, k = Math.min(S / w, S / h);
  g.drawImage(img, (S - w * k) / 2, (S - h * k) / 2, w * k, h * k);
  const px = g.getImageData(0, 0, S, S).data, lum: number[] = [];
  for (let i = 0; i < px.length; i += 4) lum.push(0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2]);
  const mean = lum.reduce((a, b) => a + b, 0) / lum.length;
  let hex = "";
  for (let i = 0; i < lum.length; i += 4) hex += ((lum[i] > mean ? 8 : 0) | (lum[i + 1] > mean ? 4 : 0) | (lum[i + 2] > mean ? 2 : 0) | (lum[i + 3] > mean ? 1 : 0)).toString(16);
  return hex;
}

/** Every project's candidates, numbered as the bridge numbered them (P1.., c1..),
 *  each in a box of its own with its id at the top, drawn on a dark ground and
 *  a light one. The box is what ties an id to its picture: with the id loose
 *  under the tiles, the model once named the "a" and gave the wordmark's id.
 *  A PNG, base64, and each picture's average hash. */
export async function drawSheet(c: StyleCandidates): Promise<{ sheet: string; hashes: Record<string, string> }> {
  const imgs = new Map<string, HTMLImageElement | null>();
  await Promise.all(c.projects.flatMap((p) => p.cands).map(async (k) => {
    if (imgs.has(k.logo)) return;
    imgs.set(k.logo, null);
    const img = new Image();
    img.src = projectLogoUrl(k.logo);
    try { await img.decode(); imgs.set(k.logo, img); } catch { /* left blank: the model sees an empty tile */ }
  }));
  const cv = document.createElement("canvas");
  cv.width = COLW * COLS + 16;
  cv.height = Math.ceil(c.projects.length / COLS) * ROW + 16;
  const g = cv.getContext("2d")!;
  g.fillStyle = "#262b33";
  g.fillRect(0, 0, cv.width, cv.height);
  g.textBaseline = "top";
  c.projects.forEach((p, i) => {
    const x0 = 12 + (i % COLS) * COLW, y0 = 10 + Math.floor(i / COLS) * ROW;
    g.fillStyle = "#f0f3f6";
    g.font = "600 15px system-ui, sans-serif";
    g.fillText(`P${i + 1} ${p.name}`.slice(0, 64), x0, y0);
    if (!p.cands.length) {
      g.fillStyle = "#9aa4ae";
      g.font = "italic 13px system-ui, sans-serif";
      g.fillText("no pictures", x0, y0 + 30);
    }
    p.cands.forEach((k, j) => {
      const x = x0 + j * STEP, y = y0 + 22;
      g.fillStyle = "#30363f";
      g.strokeStyle = "#5b6470";
      g.lineWidth = 1;
      g.beginPath();
      g.roundRect(x + 0.5, y + 0.5, BOX - 1, TILE + 26, 6);
      g.fill();
      g.stroke();
      g.fillStyle = "#ffffff";
      g.font = "700 13px system-ui, sans-serif";
      g.fillText(k.id, x + 6, y + 4);
      const img = imgs.get(k.logo);
      for (const [dx, ground] of [[6, "#0d1117"], [6 + TILE + 4, "#ffffff"]] as const) {
        g.fillStyle = ground;
        g.fillRect(x + dx, y + 20, TILE, TILE);
        if (!img) continue;
        const w = img.naturalWidth || TILE, h = img.naturalHeight || TILE, k2 = Math.min((TILE - 4) / w, (TILE - 4) / h);
        g.drawImage(img, x + dx + (TILE - w * k2) / 2, y + 20 + (TILE - h * k2) / 2, w * k2, h * k2);
      }
    });
  });
  const hashes: Record<string, string> = {};
  for (const [name, img] of imgs) if (img) hashes[name] = averageHash(img);
  return { sheet: cv.toDataURL("image/png").split(",")[1], hashes };
}
