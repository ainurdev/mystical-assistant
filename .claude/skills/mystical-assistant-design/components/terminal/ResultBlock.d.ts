import * as React from "react";

/** The framed `RESULT // OK` output block that closes a run in the transcript. */
export interface ResultBlockProps extends React.HTMLAttributes<HTMLDivElement> {
  /** Header text. @default "RESULT // OK" */
  title?: React.ReactNode;
  /** Border/header color. @default "success" */
  tone?: "success" | "accent" | "danger";
  /** Elapsed seconds — renders the dim footer meta. */
  elapsed?: number;
  /** Cost in USD — renders alongside elapsed. */
  cost?: number;
  /** Play the result-landing glow flash. */
  flash?: boolean;
}

export declare function ResultBlock(props: ResultBlockProps): React.JSX.Element;
