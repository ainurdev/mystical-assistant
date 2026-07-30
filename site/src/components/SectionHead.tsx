import type { ReactNode } from "react";
import { Reveal } from "@/components/Reveal";

export function SectionHead({
  eyebrow,
  title,
  lede,
  align = "center",
}: {
  eyebrow: string;
  title: ReactNode;
  lede?: ReactNode;
  align?: "center" | "left";
}) {
  const centered = align === "center";
  return (
    <Reveal>
      <div className={centered ? "mx-auto max-w-2xl text-center" : "max-w-2xl"}>
        <p className="eyebrow mb-4">{eyebrow}</p>
        <h2 className="h2">{title}</h2>
        {lede && <p className={`lede mt-4 ${centered ? "mx-auto" : ""}`}>{lede}</p>}
      </div>
    </Reveal>
  );
}
