import { useEffect } from "react";

/** Full-size view of one attachment. Tap the backdrop or press Esc to close. */
export function ImageLightbox({ src, alt, onClose }: { src: string; alt?: string; onClose: () => void }) {
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
      aria-label={alt || "Attachment"}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/85 p-4"
    >
      <img src={src} alt={alt ?? ""} className="max-h-full max-w-full rounded-lg object-contain" />
    </div>
  );
}
