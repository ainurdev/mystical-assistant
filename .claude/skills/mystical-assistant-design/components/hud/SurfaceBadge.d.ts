import * as React from "react";

/** The where-this-lives chip — color-codes a session/run origin. */
export interface SurfaceBadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  /** Origin key (`vscode` · `dashboard` · `bot` · `miniapp` · `terminal`) or code (`VS` · `WEB` · `TG` · `MA` · `CLI`). @default "vscode" */
  surface?: string;
  /** Show the full label ("VS Code") instead of the two-letter code. */
  full?: boolean;
}

export declare function SurfaceBadge(props: SurfaceBadgeProps): React.JSX.Element;
