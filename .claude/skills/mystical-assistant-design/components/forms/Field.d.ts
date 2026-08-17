import * as React from "react";

/** A bordered terminal input — the HUD's text entry (single-line or composer textarea). */
export interface FieldProps extends React.InputHTMLAttributes<HTMLInputElement & HTMLTextAreaElement> {
  /** Tiny UPPERCASE label above the field. */
  label?: string;
  /** Leading violet glyph for the command-line look (e.g. `~ ❯`). */
  prompt?: string;
  /** Render an auto-sizable textarea instead of an input. */
  multiline?: boolean;
  /** Textarea rows when `multiline`. @default 1 */
  rows?: number;
  /** Extra style on the inner input/textarea element. */
  inputStyle?: React.CSSProperties;
}

export declare function Field(props: FieldProps): React.JSX.Element;
