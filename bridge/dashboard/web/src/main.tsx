import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource/share-tech-mono/400.css";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/500.css";
import "@fontsource/jetbrains-mono/700.css";
// FLINT's voice (lib/theme FLINT_DEFS): Geist for the UI, Geist Mono for code.
import "@fontsource/geist/400.css";
import "@fontsource/geist/500.css";
import "@fontsource/geist/600.css";
import "@fontsource/geist-mono/400.css";
import "@fontsource/geist-mono/500.css";
import "./index.css";
// Side-effect import: `beforeinstallprompt` fires once, before React mounts, so
// the listener has to be installed here rather than in the SETTINGS component.
import "./lib/installprompt";
import { App } from "./App";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
