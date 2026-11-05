import type { ReactNode } from "react";

/* The 132px signature box every right-rail tab opens on. The frame owns the
   height (so switching tabs never moves the list under it), the chrome, and the
   reduced-motion rule; a hero draws only what's inside. `label` is the state in
   words for screen readers, `top` the line above the drawing. */
export function RailHero({ label, top, children }: { label: string; top: ReactNode; children?: ReactNode }) {
  return (
    <section className="rh" aria-label={label}>
      <div className="rh-top">{top}</div>
      {children}
    </section>
  );
}
