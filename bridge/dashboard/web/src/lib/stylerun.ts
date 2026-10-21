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
  undone: string[];                // projects undone here since the run
  dismissed: boolean;              // the strip was closed on this run
  landed: Record<string, number>;  // project -> when its answer landed, for the flip
}

const SEEN_KEY = "hud-style-seen";   // the last run whose strip was closed, so a reload keeps it closed
let state: StyleState = { run: null, live: null, drawing: false, error: "", undone: [], dismissed: false, landed: {} };
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

/** The toolbar's button: draw the sheet, start the run, follow it. */
export async function startStyle(): Promise<void> {
  if (state.drawing || state.run?.state === "running") return;
  set({ drawing: true, error: "", dismissed: false, undone: [], landed: {} });
  try {
    const c = await api.styleCandidates();
    const sheet = await drawSheet(c);
    const run = await api.styleStart(sheet, c.sig);
    set({ run, drawing: false, live: liveOf(run) });
    follow();
  } catch (e) {
    set({ drawing: false, error: e instanceof Error ? e.message : String(e) });
  }
}

export async function stopStyle(): Promise<void> {
  try { set({ run: await api.styleStop() }); } catch (e) { set({ error: e instanceof Error ? e.message : String(e) }); }
}

/** Undo the run, or one project of it. */
export async function undoStyle(rel?: string): Promise<void> {
  try {
    await api.styleUndo(rel);
    const all = (state.run?.items ?? []).filter((i) => i.how.length).map((i) => i.rel);
    set({ undone: rel ? [...state.undone, rel] : all });
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

const TILE = 36;                          // one candidate on one ground
const CELL = TILE * 2 + 4 + 12;           // both grounds and a gap
const ROW = 92, COLW = 716, COLS = 2;     // two columns of projects keep the sheet under the model's 1568px

/** Every project's candidates, numbered as the bridge numbered them (P1.., c1..),
 *  each drawn on a dark ground and a light one. A PNG, base64. */
export async function drawSheet(c: StyleCandidates): Promise<string> {
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
      const x = x0 + j * CELL, y = y0 + 22;
      const img = imgs.get(k.logo);
      for (const [dx, ground] of [[0, "#0d1117"], [TILE + 4, "#ffffff"]] as const) {
        g.fillStyle = ground;
        g.fillRect(x + dx, y, TILE, TILE);
        if (!img) continue;
        const w = img.naturalWidth || TILE, h = img.naturalHeight || TILE, k2 = Math.min((TILE - 6) / w, (TILE - 6) / h);
        g.drawImage(img, x + dx + (TILE - w * k2) / 2, y + (TILE - h * k2) / 2, w * k2, h * k2);
      }
      g.fillStyle = "#d6dde4";
      g.font = "600 12px system-ui, sans-serif";
      g.fillText(k.id, x + TILE - 7, y + TILE + 4);
    });
  });
  return cv.toDataURL("image/png").split(",")[1];
}
