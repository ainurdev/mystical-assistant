import * as React from "react";

/** A terminal line prefixed by the violet `~ ❯` glyph — sent message or idle prompt. */
export interface PromptLineProps extends React.HTMLAttributes<HTMLDivElement> {
  /** The prompt glyph. @default "~ ❯" */
  prompt?: string;
  /** Append the blinking phosphor caret (awaiting-input). */
  caret?: boolean;
  /** `user` = bright sent line; `oracle` = dim italic whisper. @default "user" */
  tone?: "user" | "oracle";
}

export declare function PromptLine(props: PromptLineProps): React.JSX.Element;
