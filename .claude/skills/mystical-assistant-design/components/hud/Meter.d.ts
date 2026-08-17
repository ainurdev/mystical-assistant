import * as React from "react";

/** The thin HUD utilization bar — CPU / MEM / CONTEXT / USED / FOCUS. */
export interface MeterProps extends React.HTMLAttributes<HTMLSpanElement> {
  /** Fill percentage 0–100. @default 0 */
  value?: number;
  /** Fill style. `gradient` = the teal→violet context ramp. @default "accent" */
  fill?: "accent" | "gradient" | "success" | "warning" | "danger" | string;
  /** Bar height in px. @default 5 */
  height?: number;
  /** Play the `grow` fill animation on mount. */
  animate?: boolean;
  /** Override the track background. */
  track?: string;
}

export declare function Meter(props: MeterProps): React.JSX.Element;
