import { useEffect } from "react";

/** Full-size view of one attachment. Click the backdrop or press Esc to close. */
export function ImageLightbox({ src, onClose }: { src: string; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Attachment"
      style={{ position: "fixed", inset: 0, zIndex: 95, display: "flex", alignItems: "center", justifyContent: "center", padding: 24, background: "color-mix(in srgb, var(--panel3) 82%, transparent)", cursor: "zoom-out", animation: "backdropIn .18s ease both" }}
    >
      <img src={src} alt="" style={{ maxWidth: "92vw", maxHeight: "92vh", objectFit: "contain", border: "1px solid color-mix(in srgb, var(--acc) 30%, transparent)" }} />
    </div>
  );
}

/** Thumbnail that opens the lightbox — a button so it's keyboard-reachable. */
export function ZoomButton({ onOpen, children }: { onOpen: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label="Open image"
      style={{ display: "block", padding: 0, border: 0, background: "transparent", cursor: "zoom-in", lineHeight: 0 }}
    >
      {children}
    </button>
  );
}
