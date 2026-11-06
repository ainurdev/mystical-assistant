/* Images written into a message: `![alt](address)`, the text bridge/chat_images.py
   puts at the caret. The composer draws them as the image (components/MarkdownInput),
   the transcript draws them where they were put (components/MdImage), and the document
   stays the markdown, so what's sent and what's copied is what was written.

   Pure: no DOM, no React, no CodeMirror, so embeds.check.ts runs it under node.

   Why a scanner when the composer already has a markdown parser: the lezer tree is
   incremental and lazy, and a tree that hasn't reached a line would read as "no image"
   and flicker; this answers from the text alone, the same every time. The grammar is
   chat_images.EMBED's (a path with spaces has to be in <...>), plus what remark also
   reads: balanced parens in a bare path and a 'single-quoted' title.
   ponytail: an indented code block isn't recognised (it can't be told from a nested
   list without the parser), so an image in one still draws in the composer. Add it if
   someone actually writes prompts that way; the sent message renders it as code. */

export type Embed = {
  from: number;
  to: number;
  alt: string;
  /** The address as a person means it: without the `<...>`. */
  address: string;
  title: string | null;
  /** Where the address sits in the text, `<...>` included. */
  addrFrom: number;
  addrTo: number;
};

export type AddressKind = "local" | "remote" | "other";

/** Whose images: the query the file route resolves relative addresses against. */
export type ImageScope = { session?: string | null; project?: string | null };

const EMBED = /!\[([^[\]\n]*)\]\([ \t]*(<[^<>\n]+>|(?:[^()\s]|\([^()\s]*\))+)(?:[ \t]+("[^"\n]*"|'[^'\n]*'))?[ \t]*\)/g;
/** bridge/chat_images.py SERVABLE: anything else stays an attachment. */
const INLINE_MIME = /^image\/(png|jpe?g|gif|webp|avif|bmp)$/i;

const escaped = (text: string, at: number) => {
  let n = 0;
  for (let i = at - 1; i >= 0 && text[i] === "\\"; i--) n++;
  return n % 2 === 1;
};

/** Fenced blocks as [from, to), an unclosed fence running to the end, as markdown has it. */
function fences(text: string): [number, number][] {
  const out: [number, number][] = [];
  let open: { from: number; ch: string; len: number } | null = null;
  let at = 0;
  while (at <= text.length) {
    let end = text.indexOf("\n", at);
    if (end < 0) end = text.length;
    const line = text.slice(at, end);
    if (open) {
      const c = /^[ \t]*(?:>[ \t]*)*(`{3,}|~{3,})[ \t]*$/.exec(line);
      if (c && c[1][0] === open.ch && c[1].length >= open.len) {
        out.push([open.from, end]);
        open = null;
      }
    } else {
      // A fence may sit in a quote or a list item, and a backtick fence's info
      // string can't hold a backtick (that's a code span on one line).
      const m = /^[ \t]*(?:>[ \t]*)*(?:(?:[-*+]|\d+[.)])[ \t]+)?(`{3,}|~{3,})(.*)$/.exec(line);
      if (m && !(m[1][0] === "`" && m[2].includes("`"))) open = { from: at, ch: m[1][0], len: m[1].length };
    }
    if (end === text.length) break;
    at = end + 1;
  }
  if (open) out.push([open.from, text.length]);
  return out;
}

/** Code spans in text[start, end): a run of n backticks up to the next run of exactly
 *  n, in the same paragraph. No closer, and they're just backticks. */
function spans(text: string, start: number, end: number, out: [number, number][]) {
  let i = start;
  while (i < end) {
    const c = text.indexOf("`", i);
    if (c < 0 || c >= end) return;
    if (escaped(text, c)) { i = c + 1; continue; }
    let n = 1;
    while (text[c + n] === "`") n++;
    const blank = /\n[ \t]*\n/g;
    blank.lastIndex = c;
    const limit = Math.min(end, blank.exec(text)?.index ?? end);
    let j = c + n;
    let close = -1;
    while (j < limit) {
      const k = text.indexOf("`", j);
      if (k < 0 || k >= limit) break;
      let m = 1;
      while (text[k + m] === "`") m++;
      if (m === n) { close = k; break; }
      j = k + m;
    }
    if (close < 0) { i = c + n; continue; }
    out.push([c, close + n]);
    i = close + n;
  }
}

/** Where code is: sorted, not overlapping. */
export function codeRanges(text: string): [number, number][] {
  const out: [number, number][] = [];
  let at = 0;
  for (const f of fences(text)) {
    spans(text, at, f[0], out);
    out.push(f);
    at = f[1];
  }
  spans(text, at, text.length, out);
  return out;
}

export const stripBrackets = (raw: string) =>
  raw.startsWith("<") && raw.endsWith(">") ? raw.slice(1, -1) : raw;

/** Every image written in the text, in order; never one inside code. */
export function findEmbeds(text: string): Embed[] {
  if (!text.includes("![")) return [];
  const code = codeRanges(text);
  const out: Embed[] = [];
  const re = new RegExp(EMBED);
  let c = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const from = m.index;
    const to = from + m[0].length;
    while (c < code.length && code[c][1] <= from) c++;
    if ((c < code.length && code[c][0] < to) || escaped(text, from)) {
      re.lastIndex = from + 2;
      continue;
    }
    const addrFrom = text.indexOf(m[2], from + m[1].length + 4);
    out.push({
      from, to, alt: m[1],
      address: stripBrackets(m[2]),
      title: m[3] ? m[3].slice(1, -1) : null,
      addrFrom, addrTo: addrFrom + m[2].length,
    });
  }
  return out;
}

/** local: the file route. remote: only ever loaded where a person typed it. other:
 *  nothing this client should load (a data: URL, ~, a scheme, a protocol-relative
 *  host), the same refusals chat_images.resolve makes. */
export function classifyAddress(address: string): AddressKind {
  const a = address.trim();
  if (/^https?:\/\/[^\s/]/i.test(a)) return "remote";
  if (!a || a.includes("\0") || a.startsWith("~") || a.startsWith("//")) return "other";
  if (/^[a-z][a-z0-9+.-]*:/i.test(a)) return "other";
  return "local";
}

/** What an <img> should load for an address, or null when nothing should. Both session
 *  and project go along: the route prefers the session and falls back to the project
 *  when the session isn't one the bridge owns (a chat that doesn't exist yet). */
export function imageSrc(address: string, scope: ImageScope): string | null {
  const a = address.trim();
  const kind = classifyAddress(a);
  if (kind === "remote") return a;
  if (kind === "other") return null;
  const q = new URLSearchParams({ path: a });
  if (scope.session) q.set("session", scope.session);
  if (scope.project) q.set("project", scope.project);
  return `/local/chat-images/file?${q}`;
}

/** The text an address takes in the markdown. */
export function formatAddress(address: string): string {
  return /[\s()]/.test(address) ? `<${address}>` : address;
}

/** What someone typed into the address box, as an address, or null when it can't be
 *  one: empty, or it wouldn't read back as the same address from the markdown. */
export function cleanAddress(input: string): string | null {
  const a = stripBrackets(input.trim()).trim();
  return !a || /[<>\n\r]/.test(a) ? null : a;
}

export function embedMarkdown(alt: string, address: string, title?: string | null): string {
  return `![${alt}](${formatAddress(address)}${title ? ` "${title}"` : ""})`;
}

/** The edit that points an embed at another address and touches nothing else. */
export const addressChange = (e: Embed, address: string) =>
  ({ from: e.addrFrom, to: e.addrTo, insert: formatAddress(address) });

/** Would the bridge take this file into the chat? The rest goes to the attachment tray. */
export const isInlineImage = (mime: string) => INLINE_MIME.test(mime);

/** What to call it in the viewer: its alt, unless that's the "image" every upload gets. */
export function imageName(alt: string, address: string): string {
  const a = alt.trim();
  if (a && a !== "image") return a;
  return address.split(/[?#]/)[0].split("/").pop() || address;
}

/** The size to draw at, height capped and the ratio kept. Null without a real size. */
export function fitBox(width: number, height: number, cap: number): { width: number; height: number } | null {
  if (!(width > 0) || !(height > 0)) return null;
  const k = Math.min(1, cap / height);
  return { width: Math.max(1, Math.round(width * k)), height: Math.max(1, Math.round(height * k)) };
}

/** remark percent-encodes the src it hands over; the file route wants the path written. */
export function decodeSrc(src: string): string {
  try { return decodeURI(src); } catch { return src; }
}

/** The smallest edit from one text to another, so whatever didn't change keeps its
 *  decorations (a mention spliced in beside an image doesn't redraw the image). */
export function minimalChange(a: string, b: string): { from: number; to: number; insert: string } {
  const max = Math.min(a.length, b.length);
  let p = 0;
  while (p < max && a[p] === b[p]) p++;
  let s = 0;
  while (s < max - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
  return { from: p, to: a.length - s, insert: b.slice(p, b.length - s) };
}
