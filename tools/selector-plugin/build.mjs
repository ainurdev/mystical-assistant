import { build } from "esbuild";

await build({
  entryPoints: ["src/agent.ts"],
  bundle: true,
  format: "iife",
  platform: "browser",
  target: "es2020",
  outfile: "dist/agent.global.js",
});
console.log("built dist/agent.global.js");

// Self-contained node build of the vite plugin (@babel deps bundled in) so the
// bridge can inject it into any project's dev server without installing anything
// there (see bridge/devserver.py selector injection).
await build({
  entryPoints: ["src/vite-plugin.ts"],
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node18",
  outfile: "dist/vite-plugin.mjs",
});
console.log("built dist/vite-plugin.mjs");
