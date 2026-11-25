import { execSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, URL } from "node:url";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { sentryVitePlugin } from "@sentry/vite-plugin";

// dist/.built: the tree this bundle was built from, as a commit. `git stash create` gives
// HEAD plus any uncommitted edits, or plain HEAD when clean. The rail's ⟳ diffs it against
// the checkout to tell whether this app is behind (bridge/selfupdate.py live()). Taken as
// the build starts, so an edit saved mid-build still reads as behind; written only once
// the bundle is, because rollup calls closeBundle after a failed build too.
const git = (args: string) => {
  try { return execSync(`git ${args}`, { cwd: fileURLToPath(new URL(".", import.meta.url)), stdio: ["ignore", "pipe", "ignore"] }).toString().trim(); }
  catch { return ""; }
};

function builtFrom(): Plugin {
  let out = "";
  let sha = "";
  return {
    name: "built-from",
    apply: "build",
    configResolved(c) { out = resolve(c.root, c.build.outDir); },
    buildStart() { sha = git("stash create") || git("rev-parse HEAD"); },
    writeBundle() { if (sha) writeFileSync(resolve(out, ".built"), sha + "\n"); },
  };
}

// Reports (lib/reports.ts): every script is stamped with a debug id that ties it to
// its map, and the release is HEAD, so a crash on any install's build of a pushed
// commit maps against the maps CI uploaded for it.
// shortcut: no CI job uploads them yet (the push login lacks GitHub's `workflow` scope), so
// stacks stay minified; add one that runs `npm run build` on push with CI and SENTRY_* set.
// The maps are written but no script links them. Only CI, with the token, talks to
// Sentry; an install's build never does, and the plugin's telemetry is off.
// shortcut: the ids match only when an install's bundle is byte-identical to CI's (Node 24,
// npm ci on the lockfile); another Node or node_modules leaves its stacks minified. Pin Node if that bites.
const upload = !!(process.env.CI && process.env.SENTRY_AUTH_TOKEN);
process.env.SENTRY_CLI_NO_TELEMETRY = "1";   // the CLI that uploads sends its own error reports to Sentry's project otherwise
const sentry = sentryVitePlugin({
  telemetry: false,
  authToken: upload ? process.env.SENTRY_AUTH_TOKEN : undefined,
  org: process.env.SENTRY_ORG,
  project: process.env.SENTRY_PROJECT,
  release: { name: git("rev-parse HEAD") || undefined, create: upload, finalize: upload },
  sourcemaps: { disable: upload ? false : "disable-upload" },
});

export default defineConfig({
  plugins: [react(), tailwindcss(), builtFrom(), sentry],
  base: "/",
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  build: { outDir: "dist", sourcemap: "hidden" },
});
