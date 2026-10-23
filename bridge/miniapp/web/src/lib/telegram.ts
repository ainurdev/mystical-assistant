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
}
