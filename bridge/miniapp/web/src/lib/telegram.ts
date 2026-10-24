// Minimal typings for the subset of the Telegram WebApp API we use.
// (telegram-web-app.js is loaded via a <script> tag in index.html.)

export interface TelegramWebApp {
  initData: string;
  ready: () => void;
  expand: () => void;
  setHeaderColor?: (color: string) => void;
  setBackgroundColor?: (color: string) => void;
  /** Telegram's own back arrow in its top bar (Bot API 6.1+). */
  BackButton?: { show: () => void; hide: () => void; onClick: (cb: () => void) => void; offClick: (cb: () => void) => void };
  platform?: string;
  isVersionAtLeast?: (version: string) => boolean;
  /** Bot API 8.0: the whole screen, and a home-screen shortcut ("missed" = not added yet). */
  requestFullscreen?: () => void;
  checkHomeScreenStatus?: (cb: (status: string) => void) => void;
  addToHomeScreen?: () => void;
}

declare global {
  interface Window {
    Telegram?: { WebApp?: TelegramWebApp };
  }
}

function getWebApp(): TelegramWebApp | undefined {
  return window.Telegram?.WebApp;
}

/** Raw init data string sent on every API request (empty outside Telegram). */
export function getInitData(): string {
  return getWebApp()?.initData ?? "";
}

/**
 * Boot the Telegram WebApp. The Mini App ships its own themes (lib/theme), so
 * instead of mapping Telegram's themeParams onto our palette, applyTheme pushes
 * the picked theme's ground onto Telegram's surrounding chrome.
 */
export function initTelegram() {
  const wa = getWebApp();
  if (!wa) return;
  wa.ready();
  wa.expand();
  if (!wa.isVersionAtLeast?.("8.0")) return;
  // Phones get the whole screen; #root keeps clear of Telegram's own buttons (index.css).
  if (wa.platform === "ios" || wa.platform === "android") wa.requestFullscreen?.();
  // The home-screen shortcut is offered once: a "not now" is not asked again.
  try {
    if (localStorage.getItem(HOME_ASKED)) return;
    wa.checkHomeScreenStatus?.((status) => {
      if (status !== "missed") return;
      try { localStorage.setItem(HOME_ASKED, "1"); } catch { /* asked again next time */ }
      wa.addToHomeScreen?.();
    });
  } catch { /* no localStorage: no offer */ }
}

const HOME_ASKED = "tg-home-asked";

/** Show Telegram's back arrow while `cb` is the way back; returns the undo. A
 *  client too old for BackButton just keeps the in-app one. */
export function telegramBack(cb: () => void): () => void {
  const bb = getWebApp()?.BackButton;
  if (!bb) return () => {};
  bb.onClick(cb);
  bb.show();
  return () => { bb.offClick(cb); bb.hide(); };
}
