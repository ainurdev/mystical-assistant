/* Regenerates fileicons.gen.ts — the file icons the editor tree, tab strip and
   FILES panel draw. Add an extension to EXT (or a whole filename to NAME), then
   from bridge/dashboard/web: node src/lib/fileicons.build.mjs

   Two packs, on purpose. Lucide is the icon language the rest of the HUD speaks
   — 24px grid, currentColor stroke, round caps — so it carries every icon that
   names a *category*: text, archive, image, lock. But a category icon can't
   answer the one question a file tree is actually asked, which is what language
   this is: .py and .php both landing on file-code makes the column texture, not
   information. So anything with a mark of its own gets it, from simple-icons
   ("si:" prefix) — same 24 grid, same currentColor, solid instead of stroked,
   which at 15px is what makes a Python next to a PHP legible at a glance.
   Bodies are inlined rather than pulled from a package so the dashboard keeps
   working offline. Browse names at lucide.dev/icons and simpleicons.org. */
import { writeFileSync } from "node:fs";

const EXT = {
  ts: "si:typescript", mts: "si:typescript", cts: "si:typescript",
  js: "si:javascript", mjs: "si:javascript", cjs: "si:javascript",
  tsx: "si:react", jsx: "si:react",
  py: "si:python", pyi: "si:python", ipynb: "si:jupyter",
  rs: "si:rust", go: "si:go", rb: "si:ruby", php: "si:php",
  java: "si:openjdk", kt: "si:kotlin", swift: "si:swift", dart: "si:dart",
  c: "si:c", h: "si:c", cpp: "si:cplusplus", cc: "si:cplusplus", hpp: "si:cplusplus",
  cs: "si:csharp", lua: "si:lua", ex: "si:elixir", exs: "si:elixir",
  hs: "si:haskell", scala: "si:scala", clj: "si:clojure", zig: "si:zig",
  ml: "si:ocaml", jl: "si:julia", pl: "si:perl", pm: "si:perl", r: "si:r",
  vue: "si:vuedotjs", svelte: "si:svelte", astro: "si:astro",
  graphql: "si:graphql", gql: "si:graphql", prisma: "si:prisma",
  html: "si:html5", htm: "si:html5",
  css: "si:css3", scss: "si:sass", sass: "si:sass", less: "si:less",
  json: "si:json", jsonc: "si:json",
  yml: "si:yaml", yaml: "si:yaml", toml: "si:toml",
  md: "si:markdown", mdx: "si:markdown", tex: "si:latex",
  sh: "si:gnubash", bash: "si:gnubash", zsh: "si:zsh", ps1: "si:powershell",
  dockerfile: "si:docker", wasm: "si:webassembly",
  gitignore: "si:git", gitattributes: "si:git", gitmodules: "si:git",
  tf: "si:terraform", tfvars: "si:terraform", vim: "si:vim", el: "si:gnuemacs",
  sqlite: "si:sqlite", sqlite3: "si:sqlite",

  // No mark of its own — the category icon carries it.
  proto: "file-code", fish: "file-terminal", makefile: "file-terminal",
  xml: "code-xml", svg: "code-xml",
  ini: "file-cog", cfg: "file-cog", conf: "file-cog", editorconfig: "file-cog",
  txt: "file-text", rst: "file-text", license: "file-text",
  pdf: "file-text", docx: "file-text", csv: "file-spreadsheet", xlsx: "file-spreadsheet",
  png: "image", jpg: "image", jpeg: "image", gif: "image", webp: "image",
  bmp: "image", avif: "image", ico: "image",
  mp4: "file-video", mov: "file-video", webm: "file-video",
  mp3: "file-audio", wav: "file-audio", ogg: "file-audio",
  ttf: "file-type", otf: "file-type", woff: "file-type", woff2: "file-type",
  zip: "file-archive", tar: "file-archive", gz: "file-archive", tgz: "file-archive",
  xz: "file-archive", bz2: "file-archive", "7z": "file-archive", rar: "file-archive",
  sql: "database", db: "database",
  env: "file-lock", pem: "file-key", key: "file-key",
  log: "scroll-text", todo: "list-todo",
};

/* Whole-filename overrides, where the extension alone would undersell it —
   a lockfile is its package manager, a manifest is its language. */
const NAME = {
  "package.json": "si:npm", "package-lock.json": "si:npm",
  "yarn.lock": "si:yarn", "pnpm-lock.yaml": "si:pnpm", "bun.lockb": "si:bun",
  "tsconfig.json": "si:typescript", "deno.json": "si:deno",
  "cargo.toml": "si:rust", "cargo.lock": "si:rust",
  "go.mod": "si:go", "go.sum": "si:go",
  "gemfile": "si:ruby", "gemfile.lock": "si:ruby",
  "composer.json": "si:php", "composer.lock": "si:php",
  "pyproject.toml": "si:python", "requirements.txt": "si:python",
  "setup.py": "si:python", "pipfile": "si:python", "uv.lock": "si:python",
  "docker-compose.yml": "si:docker", "docker-compose.yaml": "si:docker",
  "claude.md": "si:claude", "agents.md": "si:anthropic",
  ".eslintrc": "si:eslint", ".prettierrc": "si:prettier",
  "vite.config.ts": "si:vite", "vite.config.js": "si:vite",
  "tailwind.config.js": "si:tailwindcss", "tailwind.config.ts": "si:tailwindcss",
  "nginx.conf": "si:nginx", "makefile": "file-terminal",
};

const all = [...new Set([...Object.values(EXT), ...Object.values(NAME), "file"])];
const packs = { lucide: all.filter((n) => !n.includes(":")), "simple-icons": all.filter((n) => n.startsWith("si:")).map((n) => n.slice(3)) };

const bodies = {};
for (const [pack, names] of Object.entries(packs)) {
  const data = await fetch(`https://api.iconify.design/${pack}.json?icons=${names.join(",")}`).then((r) => r.json());
  const missing = names.filter((n) => !data.icons?.[n] && !data.aliases?.[n]);
  if (missing.length) { console.error(`MISSING in ${pack}:`, missing.join(", ")); process.exit(1); }
  for (const n of names) {
    // Aliases come back separately, pointing at a parent's body.
    const raw = data.icons[n]?.body ?? data.icons[data.aliases[n].parent].body;
    // Lucide draws at stroke-width 2; the HUD's own glyphs are 1.5–1.6, so thin
    // them to match. Simple-icons are filled, so this is a no-op there.
    bodies[pack === "lucide" ? n : `si:${n}`] = raw.replaceAll('stroke-width="2"', 'stroke-width="1.6"');
  }
}

const entries = all.map((n) => `  ${JSON.stringify(n)}: ${JSON.stringify(bodies[n])},`).join("\n");
const map = (o) => Object.entries(o).map(([k, v]) => `  ${JSON.stringify(k)}: ${JSON.stringify(v)},`).join("\n");

writeFileSync(new URL("fileicons.gen.ts", import.meta.url), `\
/* GENERATED by fileicons.build.mjs — edit the maps there and re-run it, not this.
   Icon bodies are from lucide (ISC) and simple-icons (CC0), via api.iconify.design. */

/* Last dot-segment of the filename → icon. For an extensionless name like
   Dockerfile or Makefile that segment is the whole lowercased name, so those
   land here too. */
export const EXT_ICON: Record<string, string> = {
${map(EXT)}
};

/* Whole-filename overrides, where the extension alone would undersell it. */
export const NAME_ICON: Record<string, string> = {
${map(NAME)}
};

export const ICON_BODY: Record<string, string> = {
${entries}
};
`);
console.log(`ok — ${all.length} icons`);
