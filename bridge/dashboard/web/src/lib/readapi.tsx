import { req } from "../api";
import { MdImage } from "../components/MdImage";
import { useChatImageScope } from "./chatimages";
import type { DataEv } from "./dataview";
import type { Ref } from "./refs";

// The dashboard's side of FileRef and SelectionPop, which are the same files in both apps.

export const useRefSession = (): string | null => useChatImageScope().session ?? null;

export const postRefs = async (session: string, addresses: string[]) =>
  (await req<{ refs: Record<string, Ref> }>("/local/chat/file-refs", { method: "POST", body: { session_id: session, addresses } })).refs;

export async function openOnComputer(session: string, address: string): Promise<string | null> {
  try {
    await req("/local/chat/open-file", { method: "POST", body: { session_id: session, address } });
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : "Couldn't open it.";
  }
}

export const translateText = (session: string, text: string, context: string, target: string) =>
  req<{ from: string; text: string }>("/local/chat/translate", { method: "POST", body: { session_id: session, text, context, target } });

export const InlineImage = ({ address }: { address: string }) => <MdImage data-addr={address} alt={address.split("/").pop() ?? ""} />;

export const explainText = (session: string, text: string, context: string) =>
  req<{ text: string }>("/local/chat/explain", { method: "POST", body: { session_id: session, text, context } });

export async function saveView(session: string, view: DataEv): Promise<void> {
  await req("/local/chat/view-save", { method: "POST", body: { session_id: session, view } });
}

export const listViews = (session: string) =>
  req<{ views: { id: string; view: DataEv }[] }>(`/local/saved-views?session=${encodeURIComponent(session)}`);

export const removeView = (session: string, id: string) =>
  req("/local/saved-views/delete", { method: "POST", body: { session_id: session, id } });

export async function sendFile(name: string, blob: Blob, caption: string): Promise<void> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  await req("/local/saved-views/send", { method: "POST", body: { name, caption, data: btoa(bin) } });
}

/** The design view's routes (bridge/multi_api.py _post_design). */
export const designCall = <T,>(session: string, path: string, body: Record<string, unknown> = {}) =>
  req<T>(`/local/chat/${path}`, { method: "POST", body: { session_id: session, ...body } });

export const uploadImage = async (session: string, data: string) =>
  (await req<{ path: string }>("/local/chat-images/upload", { method: "POST", body: { session_id: session, data } })).path;

/** Automations (bridge/automations.py). No session: they belong to you, not to a chat. */
export const autoGet = <T,>() => req<T>("/local/automations");
export const autoCall = <T,>(path: string, body: Record<string, unknown> = {}) =>
  req<T>(`/local/automations/${path}`, { method: "POST", body });

/** The project's work list and its run (bridge/worklist.py, workrun.py). */
export const workGet = <T,>(session: string | null, project?: string | null) =>
  req<T>(`/local/worklist?session=${encodeURIComponent(session ?? "")}&project=${encodeURIComponent(project ?? "")}`);
export const workCall = <T,>(path: string, session: string | null, project: string | null | undefined, body: Record<string, unknown> = {}) =>
  req<T>(`/local/worklist/${path}`, { method: "POST", body: { session_id: session, project, ...body } });
export const workSources = async (session: string | null) =>
  (await req<{ sources: string[] }>(`/local/worklist/sources?session=${encodeURIComponent(session ?? "")}`)).sources;
