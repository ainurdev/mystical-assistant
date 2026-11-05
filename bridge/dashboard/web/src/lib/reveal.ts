import { api } from "../api";
import type { CtxItem } from "../components/hud/ContextMenu";
import { notify } from "../components/hud/Notifications";

/* "Show in Finder": the row a right-click offers wherever the dashboard shows a
   local file (a chat attachment, a file named in a reply, the editor's rows and
   its open file). The bridge points the OS file manager at it; POST
   /local/files/reveal takes only paths inside the workspace.

   The bridge runs on this machine, so the browser's OS names the file manager.
   No row on a touch-only device: it has no file manager, and it isn't the
   machine whose Finder would open. The Telegram Mini App has no right-click
   menu and none of this code. */

const plat = typeof navigator === "undefined" ? "" : navigator.platform || navigator.userAgent;
const LABEL = /Mac/.test(plat) ? "Show in Finder" : /Win/.test(plat) ? "Show in Explorer" : "Open containing folder";

/** The upload path behind a /local/attachment URL, else null. */
export function attachmentPath(src: string | undefined): string | null {
  if (!src) return null;
  const u = new URL(src, "http://localhost");
  return u.pathname === "/local/attachment" ? u.searchParams.get("path") : null;
}

export async function revealFile(path: string) {
  try {
    await api.revealFile(path);
  } catch (e) {
    const m = (e as Error).message;
    // a bridge older than the route answers every unknown POST with "not found"
    notify("error", m === "not found" ? `Restart the bridge (⟳) to use ${LABEL}.` : m);
  }
}

/** The row for `target`, an absolute path or what to run when it's picked (a
 *  file named in prose is only looked up then), or no row at all. */
export function revealItems(target: string | (() => void) | null | undefined): CtxItem[] {
  if (!target || !matchMedia("(any-pointer: fine)").matches) return [];
  return [{ icon: "⇱", label: LABEL, onClick: typeof target === "string" ? () => void revealFile(target) : target }];
}
