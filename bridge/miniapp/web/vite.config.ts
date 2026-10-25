import { execSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, URL } from "node:url";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// dist/.built: the tree this bundle was built from, as a commit. `git stash create` gives
// HEAD plus any uncommitted edits, or plain HEAD when clean. The rail's ⟳ diffs it against
// the checkout to tell whether this app is behind (bridge/selfupdate.py live()). Taken as
// the build starts, so an edit saved mid-build still reads as behind; written only once
// the bundle is, because rollup calls closeBundle after a failed build too.
function builtFrom(): Plugin {
  let out = "";
  let sha = "";
  const git = (args: string) => {
    try { return execSync(`git ${args}`, { cwd: fileURLToPath(new URL(".", import.meta.url)), stdio: ["ignore", "pipe", "ignore"] }).toString().trim(); }
    catch { return ""; }
  };
  return {
    name: "built-from",
    apply: "build",
    configResolved(c) { out = resolve(c.root, c.build.outDir); },
    buildStart() { sha = git("stash create") || git("rev-parse HEAD"); },
    writeBundle() { if (sha) writeFileSync(resolve(out, ".built"), sha + "\n"); },
  };
}

// https://vite.dev/config/
export default defineConfig({
  base: "/",
  plugins: [react(), tailwindcss(), builtFrom()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  server: {
    port: 5173,
  },
});
