import { useMemo, useRef, useState } from "react";
import { composePrompt } from "@selector/composePrompt";
import { api } from "../../api";
import { useSelector } from "./useSelector";
import { PreviewFrame } from "./PreviewFrame";
import { SelectionTray } from "./SelectionTray";

export function DesignView({
  previewUrl, project, onSubmit, busy,
}: {
  previewUrl: string | null;
  project: string | null;
  onSubmit: (text: string, images: string[]) => void;
  busy: boolean;
}) {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const [width, setWidth] = useState(375);
  const [instruction, setInstruction] = useState("");
  const origin = useMemo(() => {
    try { return previewUrl ? new URL(previewUrl).origin : null; } catch { return null; }
  }, [previewUrl]);
  const sel = useSelector(iframeRef, origin);

  if (!previewUrl) {
    return <div className="p-4 text-sm opacity-60">Start the preview tunnel first, then reload Design.</div>;
  }

  const submit = async () => {
    if (!instruction.trim() || !sel.state.items.length) return;
    const text = composePrompt({ project, width, items: sel.state.items, instruction });
    let images: string[] = [];
    try {
      const shot = await api.screenshot(width);
      if (shot.data_url) images = [shot.data_url];
    } catch { /* no screenshot: send text-only */ }
    onSubmit(text, images);
    sel.clear();
    setInstruction("");
  };

  return (
    <div className="grid h-full grid-cols-[1fr_320px] gap-3 p-3">
      <PreviewFrame url={previewUrl} iframeRef={iframeRef} width={width} onWidth={setWidth}
        mode={sel.state.mode} onMode={sel.setMode} hoverLabel={sel.state.hoverLabel} />
      <div className="flex flex-col gap-2 overflow-y-auto">
        <SelectionTray items={sel.state.items} onNote={sel.setNote} onRemove={sel.remove} />
        <textarea value={instruction} onChange={(e) => setInstruction(e.target.value)}
          placeholder="What should Claude change?" rows={3}
          className="w-full rounded border border-[var(--border)] bg-[var(--panel)] p-2 text-sm outline-none" />
        <button onClick={() => void submit()} disabled={busy || !instruction.trim() || !sel.state.items.length}
          className="rounded bg-[var(--accent)] px-3 py-2 text-sm font-medium text-[var(--accent-foreground)] disabled:opacity-40">
          Send to Claude
        </button>
      </div>
    </div>
  );
}
