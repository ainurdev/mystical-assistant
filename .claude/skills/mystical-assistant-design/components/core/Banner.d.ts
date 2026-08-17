import * as React from "react";

/** Inline status strip for errors / notices, in the terminal flow. */
export interface BannerProps extends React.HTMLAttributes<HTMLDivElement> {
  /** `error` = danger wash; `info` = neutral accent wash. @default "info" */
  tone?: "error" | "info";
}

export declare function Banner(props: BannerProps): React.JSX.Element;
