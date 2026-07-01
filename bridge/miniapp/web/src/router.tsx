import { createRouter, createHashHistory } from "@tanstack/react-router";
import { rootRoute } from "./routes/root";
import { runRoute } from "./routes/run";
import { serverRoute } from "./routes/server";
import { shellRoute } from "./routes/shell";
import { previewRoute } from "./routes/preview";
import { historyRoute } from "./routes/history";
import { issuesRoute } from "./routes/issues";
import { designRoute } from "./routes/design";
import { memoryRoute } from "./routes/memory";

const routeTree = rootRoute.addChildren([
  runRoute,
  issuesRoute,
  serverRoute,
  shellRoute,
  previewRoute,
  designRoute,
  historyRoute,
  memoryRoute,
]);

// Hash history is the safest choice inside the Telegram webview.
export const router = createRouter({
  routeTree,
  history: createHashHistory(),
  defaultPreload: false,
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
