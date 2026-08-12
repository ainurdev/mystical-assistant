import { useEffect } from "react";
import { createPortal } from "react-dom";

/** Full-size view of one attachment. Tap the backdrop or press Esc to close.
 *  Portaled to <body>: rendered inline it can sit under a transformed ancestor
 *  (virtualized rows are translateY'd), which would make position:fixed resolve
 *  against that ancestor instead of the viewport. */
export function ImageLightbox({ src, alt, onClose }: { src: string; alt?: string; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return createPortal(
    <div
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={alt || "Attachment"}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/85 p-4"
    >
      <img src={src} alt={alt ?? ""} className="max-h-full max-w-full rounded-lg object-contain" />
    </div>,
    document.body,
  );
}
