import { Nav } from "@/sections/Nav";
import { Hero } from "@/sections/Hero";
import { Dashboard } from "@/sections/Dashboard";
import { Underneath } from "@/sections/Underneath";
import { HowItWorks } from "@/sections/HowItWorks";
import { Features } from "@/sections/Features";
import { Security } from "@/sections/Security";
import { Faq } from "@/sections/Faq";
import { FinalCta } from "@/sections/FinalCta";
import { Footer } from "@/sections/Footer";

export default function App() {
  return (
    <>
      {/* Fine vertical grid traces behind everything, aligned to the same shell
          the content sits in. The old page's aurora blooms are gone with it —
          a glow behind the type is the opposite of an editorial surface. */}
      <div className="field" aria-hidden>
        <div className="field-traces" />
      </div>

      <a
        href="#top"
        className="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-[60] focus:bg-[var(--accent)] focus:px-3 focus:py-2 focus:text-[var(--accent-ink)]"
      >
        Skip to content
      </a>

      <Nav />

      {/* Features runs first: the hero band lands on a picture, so the next
          thing should be more pictures, not four paragraphs about the problem.
          The hero states the problem once; there is no section restating it. */}
      <main className="relative z-10">
        <Hero />
        <Features />
        <Dashboard />
        <Underneath />
        <HowItWorks />
        <Security />
        <Faq />
        <FinalCta />
      </main>

      <div className="relative z-10">
        <Footer />
      </div>
    </>
  );
}
