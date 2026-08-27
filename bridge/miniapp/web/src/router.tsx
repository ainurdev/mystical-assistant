import { createRouter, createHashHistory } from "@tanstack/react-router";
import { rootRoute } from "./routes/root";
import { runRoute } from "./routes/run";
import { chatsRoute } from "./routes/chats";
import { workRoute } from "./routes/work";
import { filesRoute } from "./routes/files";
import { systemRoute } from "./routes/system";
import { outputRoute } from "./routes/output";

// One route per bottom tab: CHAT · CHATS · WORK · REPO · SYSTEM — plus
// /output, the one page that hangs off a tab rather than being one, because a
// style you pick by looking at it needs more room than SYSTEM has.
const routeTree = rootRoute.addChildren([
  runRoute, chatsRoute, workRoute, filesRoute, systemRoute, outputRoute,
]);

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
