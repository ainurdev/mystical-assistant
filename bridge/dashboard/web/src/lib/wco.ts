import { isLinuxApp } from "./mac";
/** The installed PWA's title bar, when Chrome hands it to the page.
 *
 *  The manifest asks for display_override: window-controls-overlay. Installed
 *  and toggled on (the chevron in the window's own bar), Chrome stops drawing a
 *  title bar and paints only its min/max/close over the page's top corner. The
 *  page then has to be the title bar: `<html data-wco>` switches on index.css's
 *  rules that make the caps (Brand, RightCap) drag the window and give the
 *  buttons their corner (--wco-l/--wco-r, from the titlebar-area env vars).
 *
 *  Why not a custom close button: a browser page can't move, minimize or
 *  maximize its window, so a HUD-drawn set would be one working button and two
 *  dead ones. Chrome's are the real ones; the Mac app's lights (Strip) exist
 *  because Mystical.app forwards them to AppKit, which a browser can't.
 *
 *  Everywhere else (a tab, Mystical.app, Mystical.exe) there's no
 *  navigator.windowControlsOverlay or it isn't visible, and nothing changes. */
type Wco = EventTarget & { visible: boolean };

/** The Linux window (linux/window.py) has no title bar either, and no
 *  overlay: its min/max/close sit in the right rail (LinuxControls), and
 *  `data-wco="linux"` only marks the caps as the bar to drag (App.tsx). */
export function watchWco(): () => void {
  if (isLinuxApp()) {
    document.documentElement.setAttribute("data-wco", "linux");
    return () => document.documentElement.removeAttribute("data-wco");
  }
  const wco = (navigator as Navigator & { windowControlsOverlay?: Wco }).windowControlsOverlay;
  if (!wco) return () => {};
  const sync = () => document.documentElement.toggleAttribute("data-wco", wco.visible);
  sync();
  // geometrychange also fires when the user toggles the overlay on or off.
  wco.addEventListener("geometrychange", sync);
  return () => wco.removeEventListener("geometrychange", sync);
}
