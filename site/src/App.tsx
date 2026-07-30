import { Nav } from "@/sections/Nav";
import { Hero } from "@/sections/Hero";
import { Problem } from "@/sections/Problem";
import { Different } from "@/sections/Different";
import { Dashboard } from "@/sections/Dashboard";
import { HowItWorks } from "@/sections/HowItWorks";
import { Features } from "@/sections/Features";
import { Security } from "@/sections/Security";
import { Faq } from "@/sections/Faq";
import { FinalCta } from "@/sections/FinalCta";
import { Footer } from "@/sections/Footer";

export default function App() {
  return (
    <>
      <div className="ground" aria-hidden>
        <div className="bloom bloom-aqua" />
        <div className="bloom bloom-violet" />
      </div>

      <a
        href="#top"
        className="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-[60] focus:rounded focus:bg-[var(--acc)] focus:px-3 focus:py-2 focus:text-[var(--acc-on)]"
      >
        Skip to content
      </a>

      <Nav />

      <main className="relative z-10">
        <Hero />
        <Problem />
        <Different />
        <Dashboard />
        <Features />
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
