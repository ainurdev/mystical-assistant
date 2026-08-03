import { createRouter, createHashHistory } from "@tanstack/react-router";
import { rootRoute } from "./routes/root";
import { runRoute } from "./routes/run";
import { historyRoute } from "./routes/history";
import { issuesRoute } from "./routes/issues";
import { filesRoute } from "./routes/files";

const routeTree = rootRoute.addChildren([runRoute, historyRoute, issuesRoute, filesRoute]);

// Telegram launches the webview at "#tgWebAppData=…" and telegram-web-app.js only
// ever reads that hash — it never clears it. That script is blocking and in <head>,
// so by the time this module runs it has already published window.Telegram.WebApp,
// and the hash is spent. Drop it, or hash history reads it as a route and every
// cold open from Telegram renders Not Found. Must happen before createHashHistory().
if (location.hash && !location.hash.startsWith("#/")) {
  history.replaceState(null, "", `${location.pathname}${location.search}#/`);
}

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
