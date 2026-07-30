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

`vite.config.ts` sets `base: "./"`, so `dist/` works unchanged on GitHub Pages
(project sites included), Cloudflare Pages, Netlify, or opened off disk.

- **Cloudflare Pages** — the live target, project `mystical-assistant`
  (`https://mystical-assistant.pages.dev`). Build `npm ci && npm run build`, then
  `npx wrangler pages deploy dist --project-name=mystical-assistant`.
- **GitHub Pages** — publish `site/dist` via an action, or copy it to `docs/`.

## Editing

Copy lives inline in each section under `src/sections/` — one file per section,
in page order (`Hero`, `Problem`, `Different`, `Dashboard`, `Features`,
`HowItWorks`, `Security`, `Faq`, `FinalCta`, `Footer`). Shared URLs and the
install command are in `src/site.ts`.

## Positioning

The page sells the **local dashboard** and does not mention the Telegram bot or
Mini App at all, beyond disclosing that `setup.sh` still demands a bot token.

`Different.tsx` carries the whole argument, and its five claims were checked
against the field before they were written:

| Claim | Why it survived |
| --- | --- |
| Resumes at your usage-limit reset | Claude Code has an open request for it; the alternatives are external shell wrappers |
| Teaches you the code it wrote | No comparable dashboard has a learning layer |
| Curated, branch-scoped memory | The popular memory plugins auto-ingest into one bank per project |
| Liveness from the PID | Others detect sessions from file mtimes |
| Python stdlib only | The comparable web UIs ship a Node server |

Deliberately **not** claimed, because CloudCLI, Nimbalyst, agenthud, amux and
Claude Code Agent Monitor already do them: session auto-discovery, file
explorer, git pane, worktrees, live subagent feeds, multi-session management.

If one of the five stops being true, delete the row rather than softening it —
a differentiator nobody believes is worse than one fewer.

Two things to keep in sync by hand:

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
  Mini App, not a screenshot. It stays sharp at any width, but it also can't
  update itself — if the real UI changes shape, this won't notice.
- Custom classes in `index.css` live in `@layer components` on purpose. Unlayered,
  they outrank every Tailwind utility (`.panel`'s `position: relative` quietly beat
  an `absolute` on the same element and broke the hero's overlap).
