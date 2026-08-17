/** The browser's own "install this app" offer, caught at load.
 *
 *  Chromium fires `beforeinstallprompt` once and early — long before anyone opens
 *  SETTINGS — and that event object is the only way to raise the install dialog
 *  afterwards. So this module grabs it at import time (main.tsx imports it for the
 *  side effect) and holds it until the button in SETTINGS asks for it.
 *
 *  Nothing here works outside Chromium: Firefox and Safari never fire the event, so
 *  `canInstall()` stays false and the UI falls back to telling you where the browser
 *  keeps its own install control.
 */
type PromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};

let deferred: PromptEvent | null = null;
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

window.addEventListener("beforeinstallprompt", (e) => {
  // Suppress Chrome's own mini-infobar; the button in SETTINGS is the offer now.
  e.preventDefault();
  deferred = e as PromptEvent;
  emit();
});
window.addEventListener("appinstalled", () => {
  deferred = null;
  emit();
});

/** Running in its own window rather than a browser tab. */
export function isInstalled(): boolean {
  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    (window.navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

export function canInstall(): boolean {
  return deferred !== null;
}

export function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** Raise the browser's install dialog. True if they went through with it. */
export async function install(): Promise<boolean> {
  const e = deferred;
  if (!e) return false;
  await e.prompt();
  const { outcome } = await e.userChoice;
  deferred = null; // single-use: the browser will re-fire it if they decline
  emit();
  return outcome === "accepted";
}
