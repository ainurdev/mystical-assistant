import { useState, type RefObject } from "react";

/** The preview surface: the project rendered in an iframe at the chosen device
 * width, centered and scaled down to fit when wider than the viewport. Controls
 * live in the floating PreviewControls tooltip, not here. */
export function PreviewFrame({
  url, iframeRef, width, selecting,
}: {
  url: string;
  iframeRef: RefObject<HTMLIFrameElement | null>;
  width: number;
  selecting: boolean;
}) {
  const [containerW, setContainerW] = useState(0);
  const scale = containerW && width > containerW ? containerW / width : 1;

  return (
    <div ref={(el) => setContainerW(el?.clientWidth ?? 0)}
      style={{ position: "absolute", inset: 0, display: "flex", justifyContent: "center",
        overflow: "auto", background: "var(--panel3)", cursor: selecting ? "crosshair" : "default" }}>
      <div style={{ width, flex: "none", transform: `scale(${scale})`, transformOrigin: "top center",
        height: scale < 1 ? `${100 / scale}%` : "100%" }}>
        <iframe ref={iframeRef} src={url} title="preview"
          style={{ width: "100%", height: "100%", border: "0", background: "#fff" }} />
      </div>
    </div>
  );
}
