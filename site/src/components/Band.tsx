import { Reveal } from "@/components/Reveal";

/**
 * The page's signature motif: a full-bleed screenshot that cuts across the
 * column grid, with its caption overlapping the lower edge and pulled back into
 * the grid. It's the one element allowed to break the shell — everything else
 * stays inside it, which is what makes the break read as composition.
 *
 * Captions are read about twice as often as body copy, so each one is written
 * to stand alone: what you're looking at, and why it matters. Ogilvy's rule —
 * never a photograph without a caption, and every caption a miniature ad.
 *
 * Shots are real captures off a running install (`site/tools/shot/`), 1512×950,
 * with the repo names swapped for a demo set. They go stale when the UI moves;
 * re-take them rather than writing around them.
 */
export function Band({
  src,
  alt,
  kicker,
  caption,
  priority = false,
}: {
  src: string;
  alt: string;
  kicker: string;
  caption: string;
  priority?: boolean;
}) {
  return (
    <figure className="relative m-0">
      <div className="band">
        <img
          src={src}
          alt={alt}
          width={1512}
          height={950}
          loading={priority ? "eager" : "lazy"}
          fetchPriority={priority ? "high" : "auto"}
          decoding="async"
          className="band-media"
        />
        <div className="band-veil" aria-hidden />
      </div>

      <figcaption className="shell band-cap">
        <Reveal>
          <div className="g12">
            <div className="col-span-12 md:col-span-7 lg:col-span-6">
              <p className="label mb-2.5">
                <span className="accent" aria-hidden>
                  ▍
                </span>{" "}
                {kicker}
              </p>
              <p className="caption max-w-[46ch]">{caption}</p>
            </div>
          </div>
        </Reveal>
      </figcaption>
    </figure>
  );
}
