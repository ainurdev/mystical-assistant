import { createContext, useContext, useMemo, useSyncExternalStore, type ReactNode } from "react";
import { req } from "../api";
import type { ImageScope } from "./embeds";

/* Images in the chat, the client's half of bridge/chat_images.py: the SYSTEM ▸ Send
   images choice, the upload, and whose chat an address in the markdown belongs to. The
   choice has nothing to do with the experimental switch. An older bridge has no such
   route (a 404): that's attachment mode, as it has always been, and the row says to
   restart. */

export type ChatImagesMode = "attachment" | "inline";

export type ChatImagesState = {
  loaded: boolean;
  mode: ChatImagesMode;
  /** This bridge has no such route: older code. */
  stale: boolean;
};

const isGone = (e: unknown) => e instanceof Error && /^(not found|HTTP 404)$/i.test(e.message);

let state: ChatImagesState = { loaded: false, mode: "attachment", stale: false };
let started = false;
const subs = new Set<() => void>();

function publish(next: ChatImagesState) {
  state = next;
  subs.forEach((fn) => fn());
}

async function refresh(): Promise<void> {
  try {
    const d = await req<{ mode?: string }>("/local/chat-images");
    publish({ loaded: true, mode: d.mode === "inline" ? "inline" : "attachment", stale: false });
  } catch (e) {
    if (isGone(e)) publish({ loaded: true, mode: "attachment", stale: true });
    else if (!state.loaded) publish({ ...state, loaded: true });
    /* any other failure keeps the last answer: a blip shouldn't change how a paste lands */
  }
}

function subscribe(fn: () => void): () => void {
  subs.add(fn);
  if (!started) {
    started = true;
    void refresh();
    // Another surface can change it; the 60 s and the return to the tab catch that.
    window.setInterval(() => { if (!document.hidden) void refresh(); }, 60_000);
    window.addEventListener("focus", () => void refresh());
  }
  return () => { subs.delete(fn); };
}

export function useChatImages(): ChatImagesState {
  return useSyncExternalStore(subscribe, () => state);
}

/** Read at the moment of a paste, so the handler never closes over an old answer. */
export const chatImagesInline = () => state.mode === "inline";

/** POST chat-images. Throws so the row can say why. */
export async function setChatImagesMode(mode: ChatImagesMode): Promise<void> {
  const d = await req<{ mode?: string }>("/local/chat-images", { method: "POST", body: { mode } });
  publish({ loaded: true, mode: d.mode === "inline" ? "inline" : "attachment", stale: false });
}

/** POST chat-images/upload. The bridge's sentence comes back as the Error's message. */
export async function uploadChatImage(data: string, scope: ImageScope): Promise<{ path: string; markdown: string }> {
  const r = await req<{ path?: string; markdown?: string; error?: string }>("/local/chat-images/upload", {
    method: "POST",
    body: { data, ...(scope.session ? { session_id: scope.session } : {}), ...(scope.project ? { project: scope.project } : {}) },
  });
  if (r.error || !r.path || !r.markdown) throw new Error(r.error || "The image didn't save.");
  return { path: r.path, markdown: r.markdown };
}

export type ChatImageContext = ImageScope & {
  /** False where the words on a plate aren't the reader's own (a teammate's session, a
   *  helper briefed by another agent), so no address in them reaches the browser. */
  remote: boolean;
};

const Ctx = createContext<ChatImageContext>({ session: null, project: null, remote: true });

/** Markdown has no session prop and a dozen callers: an address resolves through this.
 *  Only what's given changes, so the transcript can narrow `remote` inside the app's. */
export function ChatImagesScope({ session, project, remote, children }: {
  session?: string | null;
  project?: string | null;
  remote?: boolean;
  children: ReactNode;
}) {
  const up = useContext(Ctx);
  const s = session === undefined ? up.session : session;
  const p = project === undefined ? up.project : project;
  const r = remote === undefined ? up.remote : remote;
  const value = useMemo(() => ({ session: s, project: p, remote: r }), [s, p, r]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export const useChatImageScope = () => useContext(Ctx);
