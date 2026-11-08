// Finding what looks like a file in what an agent wrote. Loose on purpose: only a path the
// bridge confirms becomes a link (bridge/chat_files.py), so a wrong guess costs one small
// question and the word stays a word. Pure, for refs.check.ts. The same file is in both apps.

export type Ref = { path: string | null; rel: string; kind: "image" | "file" | "dir" | "ambiguous"; line?: number };

const EXT = /\.(ts|tsx|js|jsx|mjs|cjs|py|rs|go|rb|java|kt|swift|c|h|cc|cpp|hpp|cs|php|sh|bash|zsh|sql|css|scss|html|json|jsonc|ya?ml|toml|ini|cfg|env|md|mdx|txt|lock|svg|vue|svelte|astro|proto|graphql|gradle|png|jpe?g|gif|webp|avif|bmp|pdf|csv|tsv|log|xml|docx?|xlsx?|pptx?|zip|tar|gz|mp4|mov|webm|mp3|wav)$/i;
const IMAGE = /\.(png|jpe?g|gif|webp|avif|bmp)$/i;

/** The address in a token, or null if it can't be a path. A trailing :12 stays on it. */
export function refOf(raw: string): string | null {
  const s = raw.trim();
  if (!s || s.length > 500 || /\s/.test(s) || /^[a-z][a-z0-9+.-]*:\/\//i.test(s) || s.startsWith("-")) return null;
  const path = s.replace(/(:\d+){1,2}$/, "");
  if (!/^[\w.@/+~-]+$/.test(path) || !/[a-z]/i.test(path)) return null;
  if (path.includes("/")) {
    const parts = path.split("/").filter(Boolean);
    const rooted = path.startsWith("/") || path.startsWith("~/") || path.startsWith("./") || path.startsWith("../");
    if (EXT.test(path) || path.endsWith("/") || rooted || parts.length >= 3) return parts.length ? s : null;
    return null;   // "and/or", "client/server"
  }
  return EXT.test(path) && !path.includes("@") ? s : null;   // an @ with no folder is a mail address
}

const TOKEN = /[\w.@/+~-]+(?::\d+){0,2}/g;

/** Where the paths are in a run of prose. A manual look behind, as older phones can't parse one in a regex. */
export function refsInText(text: string): { start: number; end: number; address: string }[] {
  const out: { start: number; end: number; address: string }[] = [];
  for (const m of text.matchAll(TOKEN)) {
    const start = m.index ?? 0;
    if (start > 0 && /[\w:@]/.test(text[start - 1])) continue;     // the rest of a URL or an address
    const token = m[0].replace(/[.\-+]+$/, "");
    const address = refOf(token);
    if (address) out.push({ start, end: start + token.length, address });
  }
  return out;
}

export const isImage = (address: string) => IMAGE.test(address.replace(/(:\d+){1,2}$/, ""));

/** The image paths mentioned in a message, to draw under it: not in a code block, and not
 *  already drawn as ![..](..) or linked. A file named six times is drawn once. */
export function imagesIn(markdown: string, cap = 6): string[] {
  const prose = markdown
    .replace(/```[\s\S]*?(?:```|$)/g, " ")
    .replace(/!?\[[^\]\n]*\]\([^)\n]*\)/g, " ")
    .replace(/`([^`\n]*)`/g, " $1 ");
  const seen = new Set<string>();
  for (const r of refsInText(prose)) if (isImage(r.address)) seen.add(r.address);
  return [...seen].slice(0, cap);
}

type Node = { type: string; value?: string; children?: Node[]; data?: Record<string, unknown> };
const LEAVE = new Set(["link", "linkReference", "image", "imageReference", "inlineCode", "code", "html", "definition"]);

/** Paths in plain prose become <file-ref>. Inline code keeps its own handler in Markdown. */
export function remarkFileRefs() {
  const walk = (n: Node) => {
    if (!n.children || LEAVE.has(n.type)) return;
    const next: Node[] = [];
    for (const c of n.children) {
      if (c.type !== "text" || !c.value) { walk(c); next.push(c); continue; }
      const found = refsInText(c.value);
      if (!found.length) { next.push(c); continue; }
      let at = 0;
      for (const f of found) {
        if (f.start > at) next.push({ type: "text", value: c.value.slice(at, f.start) });
        next.push({ type: "fileRef", data: { hName: "file-ref", hProperties: { addr: f.address } },
          children: [{ type: "text", value: c.value.slice(f.start, f.end) }] });
        at = f.end;
      }
      if (at < c.value.length) next.push({ type: "text", value: c.value.slice(at) });
    }
    n.children = next;
  };
  return walk;
}
