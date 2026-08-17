import * as React from "react";

/** Tiny round state indicator — green running, amber idle/awaiting, red error. */
export interface StatusDotProps extends React.HTMLAttributes<HTMLSpanElement> {
  /** Maps to a semantic color. @default "idle" */
  status?: "running" | "working" | "live" | "awaiting" | "dirty" | "idle" | "exited" | "error";
  /** Diameter in px. @default 8 */
  size?: number;
  /** Add the success "ping" pulse ring (use for live/running). */
  pulse?: boolean;
}

export declare function StatusDot(props: StatusDotProps): React.JSX.Element;
