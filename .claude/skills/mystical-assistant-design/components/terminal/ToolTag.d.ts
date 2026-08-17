import * as React from "react";

/** A tool invocation in the terminal stream — colored UPPERCASE tag, optional row. */
export interface ToolTagProps extends React.HTMLAttributes<HTMLDivElement> {
  /** Tool name; colors the tag (Bash=teal, Read=violet, Write/Edit=green). @default "Bash" */
  name?: string;
  /** When set, renders the full indented `[TAG]  summary` row instead of a bare tag. */
  summary?: React.ReactNode;
  /** Play the `streamIn` entrance (for newly-streamed rows). */
  animate?: boolean;
}

export declare function ToolTag(props: ToolTagProps): React.JSX.Element;
