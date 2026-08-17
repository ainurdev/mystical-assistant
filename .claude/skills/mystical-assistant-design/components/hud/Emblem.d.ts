import * as React from "react";

/**
 * The Mystical Assistant brand mark — dashed ring · diamond · violet core.
 */
export interface EmblemProps extends React.SVGAttributes<SVGSVGElement> {
  /** Rendered size in px (square). @default 96 */
  size?: number;
  /** Animate the ring (chrome/idle). @default true */
  spin?: boolean;
  /** Core fill color. @default "var(--violet)" */
  core?: string;
  /** `mark` = the compact emblem; `boot` adds concentric rings + axis ticks. @default "mark" */
  variant?: "mark" | "boot";
}

export declare function Emblem(props: EmblemProps): React.JSX.Element;
