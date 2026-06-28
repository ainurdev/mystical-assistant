import type { Plugin } from "vite";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { injectLoc } from "./jsx-loc";

export interface SelectorOptions {
  parentOrigins?: string[];
}

export function mysticalSelector(opts: SelectorOptions = {}): Plugin {
  let root = process.cwd();
  let agentJs = "";
  const loadAgent = () => {
    if (!agentJs) {
      const agentPath = fileURLToPath(new URL("../dist/agent.global.js", import.meta.url));
      agentJs = readFileSync(agentPath, "utf8");
    }
    return agentJs;
  };
  const frameAncestors = ["'self'", ...(opts.parentOrigins ?? [])].join(" ");

  return {
    name: "vite-plugin-mystical-selector",
    apply: "serve",
    enforce: "pre",
    configResolved(c) {
      root = (c as { root?: string }).root ?? root;
    },
    transform(code, id) {
      const file = id.split("?")[0];
      if (!/\.[jt]sx$/.test(file) || file.includes("node_modules")) return null;
      const rel = path.relative(root, file).split(path.sep).join("/");
      return { code: injectLoc(code, rel), map: null };
    },
    transformIndexHtml() {
      return [{ tag: "script", attrs: { type: "module" }, children: loadAgent(), injectTo: "body" as const }];
    },
    configureServer(server) {
      server.middlewares.use((_req, res, next) => {
        res.setHeader("Content-Security-Policy", `frame-ancestors ${frameAncestors}`);
        res.removeHeader("X-Frame-Options");
        next();
      });
    },
  };
}
