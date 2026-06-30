import { fileURLToPath, URL } from "node:url";
import { defineConfig, type PluginOption } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { mysticalSelector } from "../../../tools/selector-plugin/src/vite-plugin";

// The dashboard preview embeds this dev server in an iframe. The selector plugin
// (dev-only) injects the in-page agent and sets frame-ancestors so the dashboard
// origin is allowed to embed us — without it the iframe loads but element-select
// has nothing to talk to.
const dashPort = process.env.DASH_PORT || "8790";
const dashOrigins = [`http://127.0.0.1:${dashPort}`, `http://localhost:${dashPort}`];

export default defineConfig({
  // Cast: the plugin is typed against its own copy of vite, so its Plugin type
  // is nominally distinct from this package's. Same shape — assert to bridge it.
  plugins: [react(), tailwindcss(), mysticalSelector({ parentOrigins: dashOrigins }) as PluginOption],
  base: "/",
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      "@selector": fileURLToPath(new URL("../../../tools/selector-plugin/src", import.meta.url)),
    },
  },
  build: { outDir: "dist" },
});
