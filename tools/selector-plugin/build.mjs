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
