import { useEffect, useMemo, useSyncExternalStore } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, type Workspace, type WorkspaceDisplay, type WorkspaceSet } from "../api";
import { queryClient, settings } from "./queries";

/** The sidebar's workspaces (bridge/workspaces.py), and which one this window
 *  shows.
 *
 *  The sets are the bridge's, so every browser and app agrees on what a
 *  workspace holds. The workspace you're *on* is this window's: switching in
 *  one window leaves another where it was, the way Zen's windows do. Each
 *  switch is also the bridge's `last`, and a window opens on that one, so
 *  opening Mystical lands where you left it whichever address or app it is.
 *
 *  The last listing is kept in localStorage, so the first paint already
 *  shows the right workspace: before it, a window on Personal with no sets
 *  yet listed nothing until the bridge answered.
 *
 *  A group key (a project rel, or a group the sidebar makes: Rivendell jobs,
 *  Shared) is in the workspace `assign` names, else in DEFAULT. */
export const DEFAULT_WS = "default";
const CUR_KEY = "hud-workspace";
const CACHE_KEY = "hud-workspaces-cache";

type Snap = { set: WorkspaceSet | null; cur: string };
// The set is the query cache's (lib/queries settings.workspaces); only which one this window
// is on lives here, because it's this window's and no read's.
const listeners = new Set<() => void>();
// The bridge's first answer to this window decides where it opens; later ones
// (a save) leave the window where it is.
let opened = false;

function readCache(): WorkspaceSet | null {
  try {
    const s = JSON.parse(localStorage.getItem(CACHE_KEY) || "null") as WorkspaceSet | null;
    return s && Array.isArray(s.workspaces) && s.assign ? s : null;
  } catch { return null; }
}
function readCur(set: WorkspaceSet | null): string {
  let id = set?.last || DEFAULT_WS;
  try { id = localStorage.getItem(CUR_KEY) || id; } catch { /* no storage */ }
  return set && !set.workspaces.some((w) => w.id === id) ? DEFAULT_WS : id;
}
const cached = readCache();
let cur = readCur(cached);
const key = () => settings.workspaces().queryKey;

function setCur(id: string) {
  try { localStorage.setItem(CUR_KEY, id); } catch { /* private mode: this window only */ }
  if (id === cur) return;
  cur = id;
  listeners.forEach((f) => f());
}

/** A set the read answered with; a workspace that's gone drops you on DEFAULT. */
function take(set: WorkspaceSet) {
  const want = opened ? cur : set.last || cur;
  opened = true;
  try { localStorage.setItem(CACHE_KEY, JSON.stringify(set)); } catch { /* private mode */ }
  setCur(set.workspaces.some((w) => w.id === want) ? want : DEFAULT_WS);
}

/** Take a set a save answered with. */
function adoptWorkspaces(set: WorkspaceSet): WorkspaceSet {
  queryClient.setQueryData(key(), set);
  take(set);
  return set;
}

export function switchWorkspace(id: string): void {
  if (id === cur) return;
  setCur(id);
  queryClient.setQueryData(key(), (s) => s && { ...s, last: id });
  // The next window opens here. Fire and forget: this window has already moved.
  void api.workspacePrefs({ last: id }).catch(() => {});
}

/** How the sidebar's switch draws, for every window. */
export async function setWorkspaceDisplay(display: WorkspaceDisplay): Promise<void> {
  queryClient.setQueryData(key(), await api.workspacePrefs({ display }));   // the effect keeps it (take)
}

/** Save the whole set and adopt what the bridge kept. Throws the bridge's reason. */
export async function saveWorkspaces(workspaces: Workspace[], assign: Record<string, string>,
                                     images?: Record<string, string>): Promise<WorkspaceSet> {
  return adoptWorkspaces(await api.saveWorkspaces({ workspaces, assign, images }));
}

export const workspaceOf = (set: WorkspaceSet | null, key: string): string =>
  set?.assign[key] ?? DEFAULT_WS;

const subscribe = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; };

export function useWorkspaces(): Snap {
  // The last listing first (localStorage), so the first paint shows the right workspace; it
  // counts as stale, so the bridge is asked at once. A focus reads it again: another window may
  // have edited the set, and this read has no poll.
  const q = useQuery({ ...settings.workspaces(), initialData: cached ?? undefined, initialDataUpdatedAt: 0, refetchOnWindowFocus: true });
  useEffect(() => { if (q.data && q.dataUpdatedAt) take(q.data); }, [q.data, q.dataUpdatedAt]);
  const c = useSyncExternalStore(subscribe, () => cur, () => cur);
  return useMemo(() => ({ set: q.data ?? null, cur: c }), [q.data, c]);
}

/** A picture picked for a workspace, as the bridge stores it: a raster cropped
 *  square to 128px PNG (base64), an SVG as it is. */
export async function shrinkPicture(file: Blob): Promise<string> {
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
