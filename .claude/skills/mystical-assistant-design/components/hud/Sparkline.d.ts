import * as React from "react";

/** A real-derived mini line chart — feed a rolling number[]; it self-normalizes. */
export interface SparklineProps extends React.SVGAttributes<SVGSVGElement> {
  /** The rolling data buffer. */
  data?: number[];
  /** Stroke color. @default "var(--primary)" (use `var(--violet)` for the 2nd series) */
  color?: string;
  /** Internal viewBox width. @default 320 */
  width?: number;
  /** Height in px. @default 42 */
  height?: number;
  /** Vertical padding inside the box. @default 4 */
  pad?: number;
  /** Draw the faint center axis line. @default true */
  axis?: boolean;
  /** Polyline stroke width. @default 1.4 */
  strokeWidth?: number;
}

export declare function Sparkline(props: SparklineProps): React.JSX.Element;
