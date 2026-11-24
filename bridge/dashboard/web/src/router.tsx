import { createHashHistory, createRootRoute, createRoute, createRouter } from "@tanstack/react-router";
import { App } from "./App";
import { RouteError } from "./components/RouteError";
import { fromLegacy } from "./lib/routes";

// The URLs are lib/routes.ts's. App is the root: it stays mounted across every
// navigation and reads the place from the path, so the children only name the
// URLs; anything else is no match and App reads it as #/.
const rootRoute = createRootRoute({ component: App, errorComponent: RouteError, notFoundComponent: () => null });
const none = () => null;
const routeTree = rootRoute.addChildren([
  createRoute({ getParentRoute: () => rootRoute, path: "/", component: none }),
  createRoute({ getParentRoute: () => rootRoute, path: "/s/$id", component: none }),
  createRoute({ getParentRoute: () => rootRoute, path: "/settings/$page", component: none }),
]);

// An old ?s=<id> link becomes #/s/<id> before history first reads the URL.
const moved = fromLegacy(location.href);
if (moved) history.replaceState(history.state, "", moved);

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
