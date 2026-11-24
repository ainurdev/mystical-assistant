# The dashboard fetches with TanStack Query and navigates with TanStack Router

The dashboard grew as one 3,900-line component with 82 hand-written polling timers that shared nothing: it made over 100 requests to start, fetched the same answer from several components, kept polling while hidden, and had no URLs. It now reads everything through TanStack Query, and chats, Settings pages, right-rail tabs and the pop-ups (Analyze, editor, picture viewer) get hash URLs through TanStack Router: the two libraries the Mini App already uses. Routing itself was not a measured cost (2026-11-23 study); the router was chosen for URLs and for loading Settings, the editor and the terminal as separate pieces of script.

## Considered Options

- **Share the repeated fetches with the house store pattern** (`lib/ai.ts`, `lib/integrations.ts`) (not picked): no new dependency, but every poller would still be written by hand and nothing would pause in the background.
- **Query for polled reads only, router later as its own refactor** (not picked): a smaller change, at the cost of two ways to fetch living side by side.

## Consequences

- Polling stops while the window is not in front. Notices, needs and the running list are the exceptions, because the bell, the Dock badge and OS banners depend on them; any new poll that must run hidden has to say so.
- A lazy route that asks for a piece of script a newer build removed reloads the page once (the router's own guard). That replaces the "no `React.lazy`" rule that followed the blank screen of 2026-10-17.
- URLs are hash URLs (`#/s/<id>`), as in the Mini App. `?s=<id>` links keep working.
