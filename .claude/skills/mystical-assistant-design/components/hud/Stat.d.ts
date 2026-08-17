import * as React from "react";

/** A micro readout cell — tracked label over a value. The atom of stat grids. */
export interface StatProps extends React.HTMLAttributes<HTMLDivElement> {
  /** The tiny uppercase label (TURNS, COST, STREAK…). */
  label: React.ReactNode;
  /** The value below it. */
  value: React.ReactNode;
  /** Value color (use a semantic var for ERRORS, etc). @default "var(--foreground)" */
  color?: string;
  /** Text alignment. @default "left" */
  align?: "left" | "center" | "right";
  /** Value font size in px. @default 13 */
  size?: number;
}

export declare function Stat(props: StatProps): React.JSX.Element;
