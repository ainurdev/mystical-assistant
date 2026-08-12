import type { CtxItem } from "../components/hud/ContextMenu";
import { confirmLeave } from "./leaveGuard";

/* The browser's own context-menu entries, rebuilt for the custom HUD menu —
   preventDefault() takes the native one away, so anything it offered has to be
   re-implemented here. `top` is target-specific (selection / link / image) and
   goes above the app items; `page` is the browser-level block below them.
   ponytail: view-source and inspect aren't reachable from JS, so they're gone. */

const copy = (t: string) => { try { void navigator.clipboard?.writeText(t); } catch { /* ignore */ } };
const open = (url: string) => window.open(url, "_blank", "noopener,noreferrer");

async function copyImage(img: HTMLImageElement) {
  try {
    const c = document.createElement("canvas");
    c.width = img.naturalWidth; c.height = img.naturalHeight;
    c.getContext("2d")?.drawImage(img, 0, 0);
    // Chromium only accepts image/png on the clipboard, hence the canvas hop.
    const blob = await new Promise<Blob | null>((r) => c.toBlob(r, "image/png"));
    if (blob) await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
  } catch { /* tainted canvas / no permission — same as the native item failing */ }
}

function saveAs(url: string) {
  const a = document.createElement("a");
  a.href = url;
  a.download = url.split("/").pop()?.split("?")[0] || "download";
  a.rel = "noopener";
  a.click();
}

function selectAll() {
  const s = window.getSelection();
  if (!s) return;
  const r = document.createRange();
  r.selectNodeContents(document.body);
  s.removeAllRanges();
  s.addRange(r);
}

export function nativeCtxItems(e: MouseEvent): { top: CtxItem[]; page: CtxItem[] } {
  const el = e.target as HTMLElement;
  // Read the selection now — clicking a menu row drops it.
  const sel = (window.getSelection()?.toString() ?? "").trim();
  const link = el.closest?.("a[href]") as HTMLAnchorElement | null;
  const img = el.closest?.("img") as HTMLImageElement | null;

  const top: CtxItem[] = [];
  if (sel) {
    top.push({ icon: "⧉", label: "Copy", hint: "⌘C", onClick: () => copy(sel) });
    const q = sel.length > 22 ? `${sel.slice(0, 22)}…` : sel;
    top.push({ icon: "⌕", label: `Search web for “${q}”`, onClick: () => open(`https://www.google.com/search?q=${encodeURIComponent(sel)}`) });
  }
  if (link) {
    top.push({ icon: "↗", label: "Open link in new tab", onClick: () => open(link.href) });
    top.push({ icon: "⧉", label: "Copy link address", onClick: () => copy(link.href) });
  }
  if (img) {
    const src = img.currentSrc || img.src;
    top.push({ icon: "↗", label: "Open image in new tab", onClick: () => open(src) });
    top.push({ icon: "⧉", label: "Copy image", onClick: () => void copyImage(img) });
    top.push({ icon: "⧉", label: "Copy image address", onClick: () => copy(src) });
    top.push({ icon: "↓", label: "Save image as…", onClick: () => saveAs(src) });
  }

  const page: CtxItem[] = [
    { icon: "☰", label: "Select all", hint: "⌘A", onClick: selectAll },
    { icon: "←", label: "Back", onClick: () => history.back() },
    { icon: "→", label: "Forward", onClick: () => history.forward() },
    { icon: "↻", label: "Reload", hint: "⌘R", onClick: () => void confirmLeave().then((ok) => ok && location.reload()) },
    { icon: "⎙", label: "Print…", hint: "⌘P", onClick: () => window.print() },
  ];
  return { top, page };
}
