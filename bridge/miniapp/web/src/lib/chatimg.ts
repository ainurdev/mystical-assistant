/* The bytes behind an image address, for everything that draws one in a chat.
 *
 * A local address goes through GET /api/chat-images/file, which wants the init-data
 * header an <img src> can't carry, so it comes back as a blob URL (the attachments' way,
 * api.attachmentUrl). A remote one is its own URL. Either way the answer is whether it
 * actually paints, because that's what "found" has to mean: a thumbnail in the composer
 * stands for "this is an image", and text that doesn't load stays text.
 *
 * Kept by scope and address, so a virtualized row scrolling back in doesn't blink and a
 * keystroke elsewhere in the draft doesn't fetch. A miss is forgotten after MISS_MS: the
 * agent may be about to write the file an answer names. A failure that wasn't a 404 is
 * retried by whoever next mounts. Whoever draws an entry holds it, so eviction can't
 * revoke a URL that's on screen.
 *
 * ponytail: MAX_KEPT entries, not bytes. A chat of 48 full-size photos holds them all;
 * count bytes if that ever shows up on a phone.
 */

import { useEffect, useReducer } from "react";
import { api, ApiError, type ChatImageScope } from "./api";
import { addressKind } from "./embeds";

export type ImageLook =
  | { status: "checking"; url?: undefined }
  | { status: "found"; url: string }
  | { status: "missing"; url?: undefined };

const CHECKING: ImageLook = { status: "checking" };
const MISSING: ImageLook = { status: "missing" };
const MAX_KEPT = 48;
const MISS_MS = 15_000;

/** `at` is when a miss was learned; 0 means ask again at the next chance. */
type Entry = { look: ImageLook; at: number; blob: boolean };

const kept = new Map<string, Entry>();
const flying = new Map<string, Promise<void>>();
const holders = new Map<string, number>();

function keyOf(scope: ChatImageScope, address: string): string | null {
  if (addressKind(address) === "remote") return `r:${address}`;
  if (scope.session) return `s:${scope.session}\0${address}`;
  return scope.project ? `p:${scope.project}\0${address}` : null;
}

function store(key: string, e: Entry) {
  kept.delete(key);
  kept.set(key, e);
  for (const [k, old] of kept) {
    if (kept.size <= MAX_KEPT) break;
    if (holders.get(k) || flying.has(k)) continue;
    kept.delete(k);
    if (old.blob && old.look.url) URL.revokeObjectURL(old.look.url);
  }
}

const paints = (url: string) =>
  new Promise<boolean>((resolve) => {
    const img = new Image();
    img.referrerPolicy = "no-referrer";
    img.onload = () => resolve(true);
    img.onerror = () => resolve(false);
    img.src = url;
  });

async function fetchLook(scope: ChatImageScope, address: string): Promise<Entry> {
  const miss = (at: number): Entry => ({ look: MISSING, at, blob: false });
  if (addressKind(address) === "remote") {
    return (await paints(address)) ? { look: { status: "found", url: address }, at: 0, blob: false } : miss(Date.now());
  }
  let url: string;
  try {
    url = await api.chatImageUrl(scope, address);
  } catch (e) {
    return miss(e instanceof ApiError && e.status === 404 ? Date.now() : 0);
  }
  if (await paints(url)) return { look: { status: "found", url }, at: 0, blob: true };
  URL.revokeObjectURL(url);
  return miss(Date.now());
}

function load(key: string, scope: ChatImageScope, address: string): Promise<void> {
  let p = flying.get(key);
  if (!p) {
    p = fetchLook(scope, address).then((e) => {
      flying.delete(key);
      store(key, e);
    });
    flying.set(key, p);
  }
  return p;
}

/** Hand over bytes this page already has, so what was just uploaded draws without
 *  asking for it back. */
export function primeChatImage(scope: ChatImageScope, address: string, file: Blob) {
  const key = keyOf(scope, address);
  if (key) store(key, { look: { status: "found", url: URL.createObjectURL(file) }, at: 0, blob: true });
}

/** How an address looks right now. A null address, or a local one in a chat with no
 *  session or project yet, is missing. `delay` waits for typing to settle before the
 *  network is touched; an address already known answers at once regardless. */
export function useChatImage(scope: ChatImageScope, address: string | null, delay = 0): ImageLook {
  const [, redraw] = useReducer((n: number) => n + 1, 0);
  const key = address ? keyOf(scope, address) : null;
  useEffect(() => {
    if (!key || !address) return;
    holders.set(key, (holders.get(key) ?? 0) + 1);
    const known = kept.get(key);
    let live = true;
    let timer = 0;
    if (!known || (known.look.status === "missing" && Date.now() - known.at > MISS_MS)) {
      timer = window.setTimeout(() => {
        void load(key, scope, address).then(() => { if (live) redraw(); });
      }, delay);
    }
    return () => {
      live = false;
      window.clearTimeout(timer);
      const n = (holders.get(key) ?? 1) - 1;
      if (n > 0) holders.set(key, n);
      else holders.delete(key);
    };
    // The key is the address and the scope, as text; the scope object is new every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, delay]);
  if (!key) return MISSING;
  return kept.get(key)?.look ?? CHECKING;
}
