import type { ReactNode } from "react";
import { Reveal } from "@/components/Reveal";

/**
 * The editorial chapter header: a mono counter and rule up top, the title
 * oversized on the left, the deck offset into its own columns rather than
 * centred underneath it. Centred section heads were the old page's default and
 * were what made every section read the same — the offset is doing the work.
 */
export function SectionHead({
  n,
  chapter,
  title,
  deck,
}: {
  n: string;
  chapter: string;
  title: ReactNode;
  deck?: ReactNode;
}) {
  return (
    <Reveal>
      <header>
        <p className="chapter">
          <span className="chapter-n">{n}</span>
          {chapter}
        </p>

        <div className="g12 mt-7 sm:mt-9">
          <h2 className="h2 col-span-12 max-w-[17ch] lg:col-span-7">{title}</h2>
          {deck && (
            <p className="deck col-span-12 mt-5 max-w-[46ch] lg:col-span-4 lg:col-start-9 lg:mt-2">
              {deck}
            </p>
          )}
        </div>
      </header>
    </Reveal>
  );
}
