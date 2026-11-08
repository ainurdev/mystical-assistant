import { request } from "./api";
import { useChatImage } from "./chatimg";
import { ChatImage } from "../components/ChatImage";
import { useChat } from "./chat";
import type { DataEv } from "./dataview";
import type { Ref } from "./refs";

// The Mini App's side of FileRef and SelectionPop, which are the same files in both apps.

export const useRefSession = (): string | null => useChat().sessionId ?? null;

export const postRefs = async (session: string, addresses: string[]) =>
  (await request<{ refs: Record<string, Ref> }>("/api/chat/file-refs", { method: "POST", body: { session_id: session, addresses } })).refs;

export async function openOnComputer(session: string, address: string): Promise<string | null> {
  try {
    await request("/api/chat/open-file", { method: "POST", body: { session_id: session, address } });
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : "Couldn't open it.";
  }
}

export const translateText = (session: string, text: string, context: string, target: string) =>
  request<{ from: string; text: string }>("/api/chat/translate", { method: "POST", body: { session_id: session, text, context, target } });

export const InlineImage = ({ address }: { address: string }) => <ChatImage address={address} alt={address.split("/").pop() ?? ""} />;

export const explainText = (session: string, text: string, context: string) =>
  request<{ text: string }>("/api/chat/explain", { method: "POST", body: { session_id: session, text, context } });

export async function saveView(session: string, view: DataEv): Promise<void> {
  await request("/api/chat/view-save", { method: "POST", body: { session_id: session, view } });
}

export const listViews = (session: string) =>
  request<{ views: { id: string; view: DataEv }[] }>(`/api/saved-views?session=${encodeURIComponent(session)}`);

export const removeView = (session: string, id: string) =>
  request("/api/saved-views/delete", { method: "POST", body: { session_id: session, id } });

export async function sendFile(name: string, blob: Blob, caption: string): Promise<void> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  await request("/api/saved-views/send", { method: "POST", body: { name, caption, data: btoa(bin) } });
}

/** The design view's routes (bridge/multi_api.py _post_design). */
export const designCall = <T,>(session: string, path: string, body: Record<string, unknown> = {}) =>
  request<T>(`/api/chat/${path}`, { method: "POST", body: { session_id: session, ...body } });

export const uploadImage = async (session: string, data: string) =>
  (await request<{ path: string }>("/api/chat-images/upload", { method: "POST", body: { session_id: session, data } })).path;

/** Automations (bridge/automations.py). No session: they belong to you, not to a chat. */
export const autoGet = <T,>() => request<T>("/api/automations");
export const autoCall = <T,>(path: string, body: Record<string, unknown> = {}) =>
  request<T>(`/api/automations/${path}`, { method: "POST", body });

/** The project's work list and its run (bridge/worklist.py, workrun.py). */
export const workGet = <T,>(session: string | null, project?: string | null) =>
  request<T>(`/api/worklist?session=${encodeURIComponent(session ?? "")}&project=${encodeURIComponent(project ?? "")}`);
export const workCall = <T,>(path: string, session: string | null, project: string | null | undefined, body: Record<string, unknown> = {}) =>
  request<T>(`/api/worklist/${path}`, { method: "POST", body: { session_id: session, project, ...body } });
export const workSources = async (session: string | null) =>
  (await request<{ sources: string[] }>(`/api/worklist/sources?session=${encodeURIComponent(session ?? "")}`)).sources;

/** A picture a run kept (bridge/workrun.py _keep_evidence). Fetched with the init-data, as an img can't send it. */
export function WorkPicture({ session, path, alt }: { session: string | null; path: string; alt: string }) {
  const look = useChatImage({ session: session ?? undefined }, path);
  return look.url ? <a href={look.url} target="_blank" rel="noreferrer"><img className="wl-pic" src={look.url} alt={alt} loading="lazy" /></a> : null;
}
