# vite-plugin-mystical-selector

Dev-only Vite plugin for the Mystical Assistant visual element selector.

## Install (in a target project)

1. Add as a dev dependency (from this monorepo path or a published build).
2. Wire it in `vite.config.ts`, dev-only:

```ts
import { mysticalSelector } from "vite-plugin-mystical-selector/plugin";

export default defineConfig({
  plugins: [
    react(),
    mysticalSelector({ parentOrigins: ["https://your-dashboard-origin", "https://t.me"] }),
  ],
});
```

It stamps `data-mloc` on JSX, injects the in-page selector agent, and allows the
dashboard/Mini App to embed the dev server in an iframe. Active only under `vite` dev
(`apply: 'serve'`); never in production builds.
