import { useRef } from "react";
import { useChat } from "../lib/chat";
import { Button } from "./ui";

export function Composer() {
  const {
    draft,
    setDraft,
    draftAttachments,
    addAttachments,
    removeAttachment,
    send,
    isRunning,
    pending,
  } = useChat();
  const fileRef = useRef<HTMLInputElement>(null);

  const blocked = isRunning || pending.length > 0;
  const sendDisabled = blocked || draft.trim().length === 0;

  return (
    <div className="fixed inset-x-0 bottom-0 z-10 mx-auto max-w-screen-sm border-t border-white/5 bg-[var(--tg-bg)] px-3 py-2">
      {draftAttachments.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-2">
          {draftAttachments.map((a) => (
            <div key={a.id} className="relative">
              <img
                src={a.dataUrl}
                alt={a.name}
                className="h-12 w-12 rounded-lg object-cover"
              />
              <button
                onClick={() => removeAttachment(a.id)}
                className="absolute -right-1.5 -top-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-black/70 text-xs text-white"
                aria-label={`Remove ${a.name}`}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}
      <div className="flex items-end gap-2">
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          multiple
          className="hidden"
          onChange={(e) => {
            void addAttachments(e.target.files);
            e.target.value = "";
          }}
        />
        <Button
          variant="secondary"
          className="shrink-0 px-3"
          onClick={() => fileRef.current?.click()}
          aria-label="Attach images"
        >
          📎
        </Button>
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
          placeholder={blocked ? "Working…" : "Message Claude…"}
          rows={1}
          className="max-h-32 flex-1 resize-none rounded-xl bg-[var(--tg-secondary-bg)] px-3 py-2 text-sm outline-none placeholder:text-[var(--tg-hint)]"
        />
        <Button
          className="shrink-0 px-3"
          disabled={sendDisabled}
          onClick={() => void send()}
          aria-label="Send"
        >
          ↑
        </Button>
      </div>
    </div>
  );
}
