import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { createSelectorController, type SelectorController, type SelectorState } from "@selector/controller";

export function useSelector(iframeRef: RefObject<HTMLIFrameElement | null>, iframeOrigin: string | null) {
  const nonce = useMemo(() => `${iframeOrigin ?? ""}|${Math.floor(performance.now())}|${Math.random().toString(36).slice(2)}`, [iframeOrigin]);
  const ctrlRef = useRef<SelectorController | null>(null);
  const [snap, setSnap] = useState<SelectorState>({ ready: false, mode: "idle", hoverLabel: null, items: [] });

  useEffect(() => {
    const iframe = iframeRef.current;
    if (!iframe || !iframeOrigin) return;
    const ctrl = createSelectorController({ iframe, iframeOrigin, nonce });
    ctrlRef.current = ctrl;
    const unsub = ctrl.subscribe(() => setSnap(ctrl.getState()));
    setSnap(ctrl.getState());
    return () => { unsub(); ctrl.destroy(); ctrlRef.current = null; };
  }, [iframeRef, iframeOrigin, nonce]);

  return {
    state: snap,
    setMode: (m: SelectorState["mode"]) => ctrlRef.current?.setMode(m),
    setNote: (id: string, n: string) => ctrlRef.current?.setNote(id, n),
    remove: (id: string) => ctrlRef.current?.remove(id),
    clear: () => ctrlRef.current?.clear(),
  };
}
