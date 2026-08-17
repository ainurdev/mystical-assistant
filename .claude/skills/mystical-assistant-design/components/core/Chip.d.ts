import * as React from "react";

/**
 * Bordered UPPERCASE metadata tag — model, branch, status, surface code.
 */
export interface ChipProps extends React.HTMLAttributes<HTMLSpanElement> {
  /** Border/text color. @default "accent" */
  tone?: "accent" | "violet" | "blue" | "success" | "warning" | "danger" | "muted";
  /** Leading filled status dot in the tone color. */
  dot?: boolean;
  /** Fill the chip with a faint wash of its tone. */
  solid?: boolean;
  /** Optional leading glyph/icon node (e.g. `⎇`). */
  icon?: React.ReactNode;
}

export declare function Chip(props: ChipProps): React.JSX.Element;
