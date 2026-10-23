import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider } from "@tanstack/react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { initTelegram } from "./lib/telegram";
import { applyHeaderStyle, applyLayout, applyTheme, loadHeaderStyle, loadLayout, loadTheme } from "./lib/theme";
import { router } from "./router";
import "@fontsource/share-tech-mono/400.css";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/500.css";
import "@fontsource/jetbrains-mono/700.css";
// FLINT's voice. PEBBLE's Nunito, MIDDLE-EARTH's Source Sans and CLAUDE's
// Spectral titles come in with index.css's one font request.
import "@fontsource/geist/400.css";
import "@fontsource/geist/500.css";
import "@fontsource/geist/600.css";
import "./index.css";

initTelegram();
applyTheme(loadTheme());
applyHeaderStyle(loadHeaderStyle());
applyLayout(loadLayout());

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: false,
      refetchOnWindowFocus: false,
    },
  },
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
