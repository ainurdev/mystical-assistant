import * as React from "react";

/**
 * The Mystical Assistant action control — square, monospace, phosphor.
 */
export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  /** Visual treatment. `hud` is the bordered UPPERCASE command action (SEND ▸ / STOP ■). @default "primary" */
  variant?: "primary" | "secondary" | "outline" | "ghost" | "destructive" | "hud";
  /** Padding/scale. `icon` is a 40×40 square. @default "default" */
  size?: "sm" | "default" | "lg" | "icon";
  /** Force UPPERCASE + nothing else (the `hud` variant already does this). */
  uppercase?: boolean;
}

export declare function Button(props: ButtonProps): React.JSX.Element;
