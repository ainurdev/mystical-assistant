import { useMemo, useRef, useState } from "react";
import { composePrompt } from "@selector/composePrompt";
import { api } from "../../lib/api";
import { useChat } from "../../lib/chat";
import { useSelector } from "./useSelector";
import { PreviewFrame } from "./PreviewFrame";
import { SelectionTray } from "./SelectionTray";

export function DesignView({ previewUrl, project }: { previewUrl: string | null; project: string | null }) {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const [width, setWidth] = useState(375);
  const [instruction, setInstruction] = useState("");
  const { runPrompt, isRunning } = useChat();
  const origin = useMemo(() => {
    try { return previewUrl ? new URL(previewUrl).origin : null; } catch { return null; }
  }, [previewUrl]);
  const sel = useSelector(iframeRef, origin);

  if (!previewUrl) return <p className="text-sm text-[var(--tg-hint)]">Start the preview first, then open Design.</p>;

  const submit = async () => {
    if (!instruction.trim() || !sel.state.items.length) return;
    const text = composePrompt({ project, width, items: sel.state.items, instruction });
    const atts = [];
    try {
      const shot = await api.screenshot(width);
      if (shot.data_url) atts.push({ id: "shot", name: "preview.png", dataUrl: shot.data_url });
    } catch { /* text-only */ }
    await runPrompt(text, atts);
    sel.clear();
    setInstruction("");
  };

  return (
    <div className="flex flex-col gap-3">
      <PreviewFrame url={previewUrl} iframeRef={iframeRef} width={width} onWidth={setWidth}
        mode={sel.state.mode} onMode={sel.setMode} hoverLabel={sel.state.hoverLabel} />
      <SelectionTray items={sel.state.items} onNote={sel.setNote} onRemove={sel.remove} />
      <textarea value={instruction} onChange={(e) => setInstruction(e.target.value)} rows={3}
        placeholder="What should Claude change?"
        className="w-full rounded-lg bg-[var(--tg-secondary-bg)] p-2 text-sm outline-none" />
      <button onClick={() => void submit()} disabled={isRunning || !instruction.trim() || !sel.state.items.length}
        className="rounded-lg bg-[var(--tg-button)] px-3 py-2.5 text-sm font-medium text-[var(--tg-button-text)] disabled:opacity-40">
        Send to Claude
      </button>
    </div>
  );
}
