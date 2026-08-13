// TEMPORARY probe config (delete after verifying): dev server that proxies the
// bridge's /local API so the worktree source can be driven headlessly.
import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  base: "/",
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  server: { port: 5199, strictPort: true, proxy: { "/local": { target: "http://127.0.0.1:8790", changeOrigin: true } } },
});
