import * as React from "react";

/**
 * The framed instrument container — corner brackets, header, drawline divider.
 */
export interface PanelProps extends React.HTMLAttributes<HTMLDivElement> {
  /** Dim left-hand label. @default "PANEL" */
  label?: string;
  /** Glowing right-hand title (the panel's name, e.g. WORKSPACE). */
  title?: React.ReactNode;
  /** CSS animation-delay for the staggered boot entrance (e.g. ".08s"). @default "0s" */
  delay?: string;
  /** Grow to fill its flex parent (min-height 0, for scrolling bodies). */
  flex?: boolean;
  /** Play the boot/drawline entrance. @default true */
  boot?: boolean;
}

export declare function Panel(props: PanelProps): React.JSX.Element;
