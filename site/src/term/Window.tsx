import type { ReactNode } from "react";

/**
 * The chrome every screenshot on this page arrives in.
 *
 * The title bar carries the pane's real route and a real session state, so the
 * frame is captioning the shot rather than decorating it. Corner ticks instead
 * of a border radius: the one thing a terminal never has is a rounded corner.
 */
export function Window({
  route,
  state = "LIVE",
  tone = "live",
  src,
  alt,
  priority = false,
  children,
}: {
  route: string;
  state?: string;
  tone?: "live" | "wait" | "work" | "idle";
  src?: string;
  alt?: string;
  priority?: boolean;
  children?: ReactNode;
}) {
  return (
    <figure className="win m-0">
      <div className="win-bar">
        <span className="font-mono text-[0.66rem] tracking-[0.06em] text-[var(--ink-dim)]">
          <span className="text-[var(--ink-ghost)]">▸ </span>
          {route}
        </span>
        <span className={`tag st-${tone}`}>{state}</span>
      </div>

      <div className="win-glass">
        {src ? (
          <img
            className="win-media"
            src={src}
            alt={alt ?? ""}
            loading={priority ? "eager" : "lazy"}
            decoding={priority ? "sync" : "async"}
            /* Intrinsic ratio is unknown per shot, so height is left auto and
               the img reserves space via width/height on the file itself. */
          />
        ) : (
          children
        )}
      </div>
    </figure>
  );
}
