import { Faq } from "@/term/Faq";
import { Features } from "@/term/Features";
import { FinalCta } from "@/term/FinalCta";
import { Footer } from "@/term/Footer";
import { Hero } from "@/term/Hero";
import { Ladder } from "@/term/Ladder";
import { Nav } from "@/term/Nav";
import { Rail, useActiveSection } from "@/term/Rail";
import { Setup } from "@/term/Setup";
import { Underneath } from "@/term/Underneath";

export default function App() {
  // Read once here and handed down, so the fixed rail and the hero's inline
  // copy of it agree without each running its own observer over the page.
  const { active, progress } = useActiveSection();

  return (
    <>
      <div className="atmos" aria-hidden>
        <div className="atmos-grid" />
        <div className="atmos-scan" />
      </div>

      <a
        href="#top"
        className="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-[60] focus:bg-[var(--live)] focus:px-3 focus:py-2 focus:text-[#02120f]"
      >
        Skip to content
      </a>

      <Nav />
      <Rail active={active} progress={progress} />

      <div className="page">
        <main>
          <Hero active={active} />
          <Features />
          <Ladder />
          <Underneath />
          <Setup />
          <Faq />
          <FinalCta />
        </main>
        <Footer />
      </div>
    </>
  );
}
