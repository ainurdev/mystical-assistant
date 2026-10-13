import { useSyncExternalStore } from "react";

/** Mystical.app's side channel. The native shell (macos/) tags its web view's
 *  user agent and installs one message handler (NotificationShim.handlerName);
 *  everything the page asks of the app goes through here, and off the Mac every
 *  call is a no-op or resolves to null, so no caller has to check where it runs.
 *
 *  The MAC APP tab's switches are the app's (UserDefaults, MacPrefs.swift) and
 *  only cached here: one copy, right at launch before any page has loaded. */
export interface MacSettings {
  keepInDock: boolean;          // Dock icon stays while the window is hidden
  floating: boolean;            // the always-on-top WAITING ON YOU panel
  titleFollowsSession: boolean; // the window title is the open session's
  version: string;              // the app bundle's build (git describe)
}
export type MacSwitch = keyof Omit<MacSettings, "version">;

type Handler = { postMessage: (m: unknown) => Promise<unknown> };
const handler = (): Handler | null => {
  const w = window as Window & { webkit?: { messageHandlers?: Record<string, Handler> } };
  return w.webkit?.messageHandlers?.mysticalNotify ?? null;
};

/** Running inside Mystical.app (not a tab, not the PWA). */
export function isMacApp(): boolean {
  return typeof navigator !== "undefined" && /\bMysticalMac\//.test(navigator.userAgent);
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
/** `mystical app` — rebuilds the bundle from the checkout and reopens it. */
export const macRebuild = (): void => { void post({ op: "rebuild" }); };
/** A press on the HUD's top row, the title bar's stand-in: the app drags the window. */
export const macDrag = (): void => { void post({ op: "drag" }); };
/** The page's traffic lights (Strip's Brand): close hides the window, minimize, zoom = full screen. */
export const macWindow = (action: "close" | "minimize" | "zoom"): void => { void post({ op: "window", action }); };

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  if (!cache && isMacApp()) void macSettings();
  return () => { listeners.delete(fn); };
}
/** The app's switches, live; null until the app answers (and always off the Mac). */
export function useMacSettings(): MacSettings | null {
  return useSyncExternalStore(subscribe, () => cache, () => null);
}
