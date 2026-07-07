// Minimal typings for the subset of the Telegram WebApp API we use.
// (telegram-web-app.js is loaded via a <script> tag in index.html.)

export interface TelegramWebApp {
  initData: string;
  ready: () => void;
  expand: () => void;
  setHeaderColor?: (color: string) => void;
  setBackgroundColor?: (color: string) => void;
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

/** Our fixed brand background — keep in sync with --tg-bg in index.css
 *  (--tg-bg → --background → #060a0a after the HUD reskin). */
const BRAND_BG = "#060a0a";

/**
 * Boot the Telegram WebApp. The Mini App ships its own fixed violet theme
 * (see index.css), so instead of mapping Telegram's themeParams onto our
 * palette we push our background color onto Telegram's surrounding chrome.
 */
export function initTelegram() {
  const wa = getWebApp();
  if (!wa) return;
  wa.ready();
  wa.expand();
  wa.setHeaderColor?.(BRAND_BG);
  wa.setBackgroundColor?.(BRAND_BG);
}
