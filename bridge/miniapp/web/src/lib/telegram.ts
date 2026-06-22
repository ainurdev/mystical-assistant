// Minimal typings for the subset of the Telegram WebApp API we use.
// (telegram-web-app.js is loaded via a <script> tag in index.html.)

export interface TelegramThemeParams {
  bg_color?: string;
  text_color?: string;
  hint_color?: string;
  link_color?: string;
  button_color?: string;
  button_text_color?: string;
  secondary_bg_color?: string;
}

export interface TelegramWebApp {
  initData: string;
  themeParams: TelegramThemeParams;
  colorScheme: "light" | "dark";
  ready: () => void;
  expand: () => void;
  onEvent: (event: string, handler: () => void) => void;
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

function setVar(name: string, value: string | undefined) {
  if (value) document.documentElement.style.setProperty(name, value);
}

/** Map Telegram themeParams onto our CSS variables. Falls back to defaults. */
export function applyTheme() {
  const params = getWebApp()?.themeParams;
  if (!params) return;
  setVar("--tg-bg", params.bg_color);
  setVar("--tg-text", params.text_color);
  setVar("--tg-button", params.button_color);
  setVar("--tg-button-text", params.button_text_color);
  setVar("--tg-hint", params.hint_color);
  setVar("--tg-secondary-bg", params.secondary_bg_color);
  setVar("--tg-link", params.link_color);
}

/** Boot the Telegram WebApp: ready/expand, apply theme, watch for changes. */
export function initTelegram() {
  const wa = getWebApp();
  if (!wa) return;
  wa.ready();
  wa.expand();
  applyTheme();
  wa.onEvent("themeChanged", applyTheme);
}
