import { useSyncExternalStore } from "react";

/** The native app's side channel. Mystical.app (macos/) and Mystical.exe
 *  (windows/) each tag their web view's user agent and install one message
 *  handler — NotificationShim.handlerName on the Mac, and shim.js puts the same
 *  object on window.webkit inside WebView2 — so everything the page asks of the
 *  app goes through here, and in a browser every call is a no-op or resolves to
 *  null: no caller has to check where it runs.
 *
 *  The tab's switches are the app's (UserDefaults on the Mac, settings.json on
 *  Windows) and only cached here: one copy, right at launch before any page has
 *  loaded. `keepInDock` is the Mac's alone, `hotkey` the Windows app's. */
export interface MacSettings {
  keepInDock?: boolean;         // Mac: the Dock icon stays while the window is hidden
  floating: boolean;            // the always-on-top WAITING ON YOU panel
  titleFollowsSession: boolean; // the window title is the open session's
  hotkey?: boolean;             // Windows: Win+Ctrl+A summons the window
  version: string;              // the app's build (git describe)
  platform?: "mac" | "windows"; // absent on a Mac app older than the Windows one
}
export type MacSwitch = "keepInDock" | "floating" | "titleFollowsSession" | "hotkey";

type Handler = { postMessage: (m: unknown) => Promise<unknown> };
const handler = (): Handler | null => {
  const w = window as Window & { webkit?: { messageHandlers?: Record<string, Handler> } };
  return w.webkit?.messageHandlers?.mysticalNotify ?? null;
};

/** Running inside Mystical.app (not a tab, not the PWA). */
export function isMacApp(): boolean {
  return typeof navigator !== "undefined" && /\bMysticalMac\//.test(navigator.userAgent);
}

/** Running inside Mystical.exe. */
export function isWinApp(): boolean {
  return typeof navigator !== "undefined" && /\bMysticalWin\//.test(navigator.userAgent);
}

/** Running inside linux/window.py, the Linux window (WebKitGTK). Not one of
 *  isNativeApp's shells: it has no shim and no settings of its own — WebKit's
 *  own Notification is the desktop's — only a title bar the page draws. */
export function isLinuxApp(): boolean {
  return typeof navigator !== "undefined" && /\bMysticalLinux\//.test(navigator.userAgent);
}

/** The Linux window's ops: drag (a press on the caps), minimize, maximize (a
 *  toggle), close. A no-op anywhere else. */
export function linuxWindow(op: "drag" | "minimize" | "maximize" | "close"): void {
  const w = window as Window & { webkit?: { messageHandlers?: Record<string, { postMessage: (m: unknown) => unknown }> } };
  try { w.webkit?.messageHandlers?.mysticalLinux?.postMessage({ op }); } catch { /* not the window */ }
}

/** Either native shell: the shim, the banner buttons and the tab apply. */
export function isNativeApp(): boolean {
  return isMacApp() || isWinApp();
}

async function post<T>(msg: Record<string, unknown>): Promise<T | null> {
  const h = handler();
  if (!h) return null;
  try { return (await h.postMessage(msg)) as T; } catch { return null; }
}

let cache: MacSettings | null = null;
const listeners = new Set<() => void>();
const adopt = (s: MacSettings | null) => { if (s) { cache = s; listeners.forEach((f) => f()); } return s; };

export const macSettings = (): Promise<MacSettings | null> => post<MacSettings>({ op: "settings" }).then(adopt);
export const macSet = (key: MacSwitch, value: boolean): Promise<MacSettings | null> =>
  post<MacSettings>({ op: "set", key, value }).then(adopt);
/** The theme's ground is light: alerts, the file picker and the title bar follow. */
export const macAppearance = (light: boolean): void => { void post({ op: "appearance", light }); };
/** `mystical app` — rebuilds the app from the checkout and reopens it. */
export const macRebuild = (): void => { void post({ op: "rebuild" }); };
/** Mac only: a press on the HUD's top row, the title bar's stand-in — the app drags the window. */
export const macDrag = (): void => { void post({ op: "drag" }); };
/** Mac only: the page's traffic lights (Strip's Brand) — close hides the window, minimize, zoom = full screen. */
export const macWindow = (action: "close" | "minimize" | "zoom"): void => { void post({ op: "window", action }); };

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  if (!cache && isNativeApp()) void macSettings();
  return () => { listeners.delete(fn); };
}
/** The app's switches, live; null until the app answers (and always in a browser). */
export function useMacSettings(): MacSettings | null {
  return useSyncExternalStore(subscribe, () => cache, () => null);
}
