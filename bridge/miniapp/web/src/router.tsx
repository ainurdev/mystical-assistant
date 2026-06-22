import { createRouter, createHashHistory } from "@tanstack/react-router";
import { rootRoute } from "./routes/root";
import { runRoute } from "./routes/run";
import { serverRoute } from "./routes/server";
import { previewRoute } from "./routes/preview";
import { historyRoute } from "./routes/history";

const routeTree = rootRoute.addChildren([
  runRoute,
  serverRoute,
  previewRoute,
  historyRoute,
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
