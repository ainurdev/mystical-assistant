import { request } from "./api";
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
