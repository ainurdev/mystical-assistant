import * as React from "react";

export interface DropdownOption {
  id: string;
  label: React.ReactNode;
}

/** The HUD's labeled select chip — a bordered button opening a `✓ label` menu. */
export interface DropdownProps {
  /** Tiny UPPERCASE label beside the chip (MODEL / EFFORT / MODE). */
  label?: string;
  /** Currently-selected option id. */
  value?: string;
  /** Selectable options. */
  options: DropdownOption[];
  /** Called with the chosen option id. */
  onChange?: (id: string) => void;
  /** Min width of the chip button. @default 92 */
  minWidth?: number;
  /** Menu open direction. @default "down" */
  direction?: "up" | "down";
  style?: React.CSSProperties;
}

export declare function Dropdown(props: DropdownProps): React.JSX.Element;
