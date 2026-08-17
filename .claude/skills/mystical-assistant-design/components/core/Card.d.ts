import * as React from "react";

/** Translucent dark surface for grouping content — the plain sibling of `Panel`. */
export interface CardProps extends React.HTMLAttributes<HTMLDivElement> {
  /** Add a teal hairline border. */
  bordered?: boolean;
  /** Inner padding in px (or any CSS length). @default 12 */
  padding?: number | string;
}

export declare function Card(props: CardProps): React.JSX.Element;
