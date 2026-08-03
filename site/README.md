# site — the marketing landing page

A standalone Vite + React page for the project's public launch. It shares the
dashboard's palette (aqua `#7fe9d8`, violet `#b9a6ff`, near-black `#060a0a`) so
the page and the product read as one thing, but it has no runtime dependency on
the bridge — it's static output.

```bash
npm install
npm run dev      # http://localhost:5173
npm run build    # → dist/
npm run preview  # serve the built dist/
```

## Deploying

**Live** at <https://mystical-assistant.pages.dev> since 2026-07-30 — Cloudflare
Pages project `mystical-assistant`, production branch `master`, deployed by direct
upload. That's the hostname in `index.html`'s canonical, OG and JSON-LD tags, so
those are now true. A fresh project 522s for the first few minutes while the edge
warms; it settles without intervention.

Every push to `master` that touches `site/**` redeploys, via
`.github/workflows/deploy-site.yml` — it runs the same `npm run deploy` below.
The workflow needs `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` as GitHub
*repository secrets*; without them the run fails at the wrangler step.

Deploying by hand is `npm run deploy`. It reads the same two variables from the
repo's `.env` — already there, and `.env` is git-ignored.

`vite.config.ts` sets `base: "./"`, so `dist/` works unchanged on Cloudflare
Pages, GitHub Pages (project sites included), Netlify, or opened off disk.

- **Cloudflare Pages, direct upload** — in use, from CI and by hand. `npm run
  deploy` from this directory; `wrangler.jsonc` carries the project name and
  output dir, so the command needs no flags and can't target the wrong project.
- **Cloudflare Pages, connected to GitHub** — the alternative to the workflow,
  and the way to get a preview deployment per branch and PR. In the Cloudflare
  dashboard: the `mystical-assistant` project → Settings → Build → Connect to
  Git, with root directory `site`, build command `npm ci && npm run build`,
  output directory `dist`. Needs the Cloudflare GitHub App to have access to the
  repo — a one-time authorisation. Drop the workflow if you switch, or the two
  will race.
- **GitHub Pages** — publish `site/dist` via an action, or copy it to `docs/`.

## Editing

Copy lives inline in each section under `src/sections/` — one file per section,
in page order (`Hero`, `Problem`, `Different`, `Dashboard`, `Screens`,
`Underneath`, `Features`, `HowItWorks`, `Security`, `Faq`, `FinalCta`, `Footer`).
Shared URLs and the install command are in `src/site.ts`.

## Positioning

The page sells the **local dashboard** and does not mention the Telegram bot or
Mini App at all, beyond disclosing that `setup.sh` still demands a bot token.

`Different.tsx` carries the whole argument, and its five claims were checked
against the field before they were written:

| Claim | Why it survived |
| --- | --- |
| Resumes at your usage-limit reset | Claude Code has an open request for it; the alternatives are external shell wrappers |
| Liveness from the PID | Others detect sessions from file mtimes |
| Python stdlib only | The comparable web UIs ship a Node server |

Deliberately **not** claimed, because CloudCLI, Nimbalyst, agenthud, amux and
Claude Code Agent Monitor already do them: session auto-discovery, file
explorer, git pane, worktrees, live subagent feeds, multi-session management.

If one of the five stops being true, delete the row rather than softening it —
a differentiator nobody believes is worse than one fewer.

## The audit (2026-07-30)

Every claim on the page was checked against the implementation. What it turned up,
so the next audit starts from a known state rather than from scratch:

| Claim | Verdict |
| --- | --- |
| A `LOGS` pane in the workspace | **Wrong, removed.** There is no logs tab. The dev server's log tail lives in the preview window, and `components/Logs.tsx` is orphaned. |
| "Server errors climb their own ladder from one minute out to thirty" | **Off by a rung, fixed.** `limits.py SERVER_BACKOFF` is `(0, 60, 300, 600, 900, 1800)` — the first retry is immediate. The FAQ already said so; `Different.tsx` didn't. |
| "It resumes when your limit resets" | **True but understated, rewritten.** Parking is now the *last* rung of `bridge/ladder.py`: another Claude account first, then a free agent, then the reset. |
| "Answer five questions" (`HowItWorks`) | **Wrong by one, fixed to six.** `setup.sh` prompts for token, projects root, autonomy, Mini App, the opencode install, and start-now — the free-provider prompt landed in `e04afe6`, after this page was written. |
| "the dashboard builds on first start, so you need npm" | **True**, and `.gitignore` confirms it: `bridge/dashboard/web/dist/` is not committed. (The root `README.md` claims "no build step" — also stale.) |
| Python stdlib only · no API key · MIT · 127.0.0.1 + Host allow-list + token | **All true.** |
| Tab list vs. reality | **Was short.** The dashboard opens three views, four sidebar panels, seven analyze tabs and the preview window; `LOGS` was the only entry that didn't exist. |

Features that shipped but weren't on the page, now added: the fallback ladder and
per-account meters, the skills catalog, the context meter, the ⌘K palette, and the
theme/CRT/indicator layer. Deliberately still absent: the PONYTAIL dial and its
`REVIEW`/`AUDIT` chips, because they set `PONYTAIL_DEFAULT_MODE` for a *third-party
plugin's* hook — with the plugin uninstalled they do nothing, so they aren't ours
to claim.

Four things to keep in sync by hand:

- **The screenshots** in `public/shots/` are real captures and go stale silently
  when the UI moves. `tools/shot/` re-takes them; its README has the commands.
- **The FAQ** is duplicated in `src/sections/Faq.tsx` and as `FAQPage` JSON-LD in
  `index.html`. Change one, change the other, or the structured data drifts from
  the page.
- **The canonical/OG URLs** in `index.html` point at
  `https://mystical-assistant.pages.dev/` (Cloudflare Pages). If the page moves
  to a custom domain, change them there and in the `SoftwareApplication` JSON-LD.
- **`og.png`** in `public/` is a 1200×630 render of the hero, not a hand-drawn
  asset — the source is `tools/og/og.html`, screenshotted headless. If the
  headline in `Hero.tsx` changes, re-render it or the card goes stale.

## Notes

- `src/components/HeroMock.tsx` is a hand-built illustration of the dashboard and
  Mini App. It's **unmounted** — the hero shows `public/shots/dashboard.png`
  instead, on the theory that the strongest thing above the fold is the real
  product. The mock stays in the repo because it's the only version that can't go
  stale; swap it back by re-importing it into `Hero.tsx` if a capture ever can't
  be taken. The `Screens` section carries the two shots the hero doesn't.
- Custom classes in `index.css` live in `@layer components` on purpose. Unlayered,
  they outrank every Tailwind utility (`.panel`'s `position: relative` quietly beat
  an `absolute` on the same element and broke the hero's overlap).
