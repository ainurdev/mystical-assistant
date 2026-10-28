import { useSyncExternalStore } from "react";
import { api, type Workspace, type WorkspaceSet } from "../api";

/** The sidebar's workspaces (bridge/workspaces.py), and which one this window
 *  shows.
 *
 *  The sets are the bridge's, so every browser and app agrees on what a
 *  workspace holds. The workspace you're *on* is this window's: switching in
 *  one window leaves another where it was, the way Zen's windows do. The last
 *  pick is remembered in localStorage only to open the next load on it.
 *
 *  A group key (a project rel, or a group the sidebar makes: Rivendell jobs,
 *  Shared) is in the workspace `assign` names, else in DEFAULT. */
export const DEFAULT_WS = "default";
const CUR_KEY = "hud-workspace";

type Snap = { set: WorkspaceSet | null; cur: string };
let snap: Snap = { set: null, cur: readCur() };
const listeners = new Set<() => void>();

function readCur(): string {
  try { return localStorage.getItem(CUR_KEY) || DEFAULT_WS; } catch { return DEFAULT_WS; }
}

function emit(next: Snap) {
  snap = next;
  listeners.forEach((f) => f());
}

/** Take a set the bridge answered with; a workspace that's gone drops you on DEFAULT. */
export function adoptWorkspaces(set: WorkspaceSet): WorkspaceSet {
  const cur = set.workspaces.some((w) => w.id === snap.cur) ? snap.cur : DEFAULT_WS;
  emit({ set, cur });
  return set;
}

export function loadWorkspaces(): void {
  void api.workspaces().then(adoptWorkspaces).catch(() => {});
}

export function switchWorkspace(id: string): void {
  if (id === snap.cur) return;
  try { localStorage.setItem(CUR_KEY, id); } catch { /* private mode: this window only */ }
  emit({ ...snap, cur: id });
}

/** Save the whole set and adopt what the bridge kept. Throws the bridge's reason. */
export async function saveWorkspaces(workspaces: Workspace[], assign: Record<string, string>,
                                     images?: Record<string, string>): Promise<WorkspaceSet> {
  return adoptWorkspaces(await api.saveWorkspaces({ workspaces, assign, images }));
}

export const workspaceOf = (set: WorkspaceSet | null, key: string): string =>
  set?.assign[key] ?? DEFAULT_WS;

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  // First subscriber loads; a focus picks up an edit made in another window.
  if (listeners.size === 1) {
    if (!snap.set) loadWorkspaces();
    window.addEventListener("focus", loadWorkspaces);
  }
  return () => {
    listeners.delete(fn);
    if (!listeners.size) window.removeEventListener("focus", loadWorkspaces);
  };
}

export function useWorkspaces(): Snap {
  return useSyncExternalStore(subscribe, () => snap, () => snap);
}

/** A picture picked for a workspace, as the bridge stores it: a raster cropped
 *  square to 128px PNG (base64), an SVG as it is. */
export async function shrinkPicture(file: File): Promise<string> {
  const b64 = (buf: ArrayBuffer) => {
    let s = "";
    const u = new Uint8Array(buf);
    for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000));
    return btoa(s);
  };
  if (file.type === "image/svg+xml") return b64(await file.arrayBuffer());
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((ok, no) => {
      const im = new Image();
      im.onload = () => ok(im);
      im.onerror = () => no(new Error("that file isn't a picture this browser can read"));
      im.src = url;
    });
    const side = Math.min(img.naturalWidth, img.naturalHeight);
    const c = document.createElement("canvas");
    c.width = c.height = 128;
    c.getContext("2d")!.drawImage(img, (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side, 0, 0, 128, 128);
    const blob = await new Promise<Blob | null>((ok) => c.toBlob(ok, "image/png"));
    if (!blob) throw new Error("couldn't encode the picture");
    return b64(await blob.arrayBuffer());
  } finally {
    URL.revokeObjectURL(url);
  }
}
