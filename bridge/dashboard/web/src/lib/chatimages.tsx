import { createContext, useContext, useMemo, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { req } from "../api";
import { queryClient, settings } from "./queries";
import type { ImageScope } from "./embeds";

/* Images in the chat, the client's half of bridge/chat_images.py: the SYSTEM ▸ Send
   images and Pictures it shows you choices, the upload, and whose chat an address in the
   markdown belongs to. The choices have nothing to do with the experimental switch. An older bridge has no such
   route (a 404): that's attachment mode, as it has always been, and the row says to
   restart. */

export type ChatImagesMode = "attachment" | "inline";
/** Where a picture the agent shows you draws: large in the chat, or in the WORK gallery. */
export type ShownPictures = "chat" | "gallery";

export type ChatImagesState = {
  loaded: boolean;
  mode: ChatImagesMode;
  shown: ShownPictures;
  /** This bridge has no such route: older code. */
  stale: boolean;
};

const isGone = (e: unknown) => e instanceof Error && /^(not found|HTTP 404)$/i.test(e.message);

type Got = { mode?: string; shown?: string };
const read = (d: Got): ChatImagesState =>
  ({ loaded: true, mode: d.mode === "inline" ? "inline" : "attachment", shown: d.shown === "gallery" ? "gallery" : "chat", stale: false });
const NOT_YET: ChatImagesState = { loaded: false, mode: "attachment", shown: "chat", stale: false };

export function useChatImages(): ChatImagesState {
  const q = useQuery(settings.chatImages());
  const d = useMemo(() => q.data && read(q.data), [q.data]);
  // Any other failure keeps the last answer: a blip shouldn't change how a paste lands.
  if (d) return d;
  if (isGone(q.error)) return { loaded: true, mode: "attachment", shown: "chat", stale: true };
  return q.error ? { ...NOT_YET, loaded: true } : NOT_YET;
}

/** Read at the moment of a paste, so the handler never closes over an old answer. */
export const chatImagesInline = () => queryClient.getQueryData(settings.chatImages().queryKey)?.mode === "inline";

/** POST chat-images, either choice. Throws so the row can say why. */
export async function setChatImages(body: { mode: ChatImagesMode } | { shown: ShownPictures }): Promise<void> {
  const d = await req<Got>("/local/chat-images", { method: "POST", body });
  // A bridge from before Pictures it shows you answers without it, and the pick would vanish.
  if ("shown" in body && d.shown === undefined) throw new Error("The bridge is running older code. Restart it to use this.");
  queryClient.setQueryData(settings.chatImages().queryKey, d);
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
