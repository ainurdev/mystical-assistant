import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

export function Textarea({ className, ref, ...props }: ComponentProps<"textarea">) {
  return (
    <textarea
      ref={ref}
      className={cn(
        "flex w-full rounded-xl border border-input bg-transparent px-3.5 py-2.5 text-[15px] leading-6 text-foreground outline-none transition-[box-shadow,border-color] placeholder:text-muted-foreground focus-visible:border-ring/60 focus-visible:ring-2 focus-visible:ring-ring/40 disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    />
  );
}
