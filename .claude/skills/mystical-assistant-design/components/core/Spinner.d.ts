import * as React from "react";

/** A currentColor loading ring — inherits text color, fits any phosphor mood. */
export interface SpinnerProps extends React.HTMLAttributes<HTMLSpanElement> {
  /** Diameter in px. @default 16 */
  size?: number;
}

export declare function Spinner(props: SpinnerProps): React.JSX.Element;
