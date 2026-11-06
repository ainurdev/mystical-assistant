/* Images written in a message as markdown: `![alt](address)`, what bridge/chat_images.py
 * puts in the text. The same shape as its EMBED, so the bridge and this page agree on
 * what counts: a path with spaces goes in <...>, a "title" is optional. On top of EMBED,
 * this skips code spans and fences, because the bubble and the composer are plain text
 * with no markdown parser to do it. The rendered reply has remark for that.
 *
 * Pure, so lib/embeds.check.ts runs it under plain node. Fetching lives in lib/chatimg.
 *
 * ponytail: code is found by fence and backtick run only. Indented code and a fence past
 * a list marker read as text; add them if one is ever drawn by mistake.
 */

export interface Embed {
  start: number;
  end: number;
  /** The exact source, for finding it again after the text has moved. */
  raw: string;
  alt: string;
  /** Without the <...>. */
  address: string;
  title: string | null;
}

const EMBED = /!\[([^\]\n]*)\]\(\s*(<[^>\n]+>|[^)\s]+)(?:\s+"([^"\n]*)")?\s*\)/g;
const FENCE_OPEN = /^[ \t]*(?:>[ \t]*)*(`{3,}|~{3,})(.*)$/;

/** Inline code in one paragraph: a backtick run closed by a run of the same length. An
 *  unmatched run is plain text, and a span can't cross a blank line. */
function spansIn(text: string, from: number, to: number, out: [number, number][]) {
  let i = from;
  while (i < to) {
    const c = text[i];
    if (c === "\\") { i += 2; continue; }
    if (c !== "`") { i++; continue; }
    let n = i;
    while (n < to && text[n] === "`") n++;
    const len = n - i;
    let close = -1;
    for (let j = n; j < to;) {
      if (text[j] !== "`") { j++; continue; }
      let k = j;
      while (k < to && text[k] === "`") k++;
      if (k - j === len) { close = k; break; }
      j = k;
    }
    if (close < 0) { i = n; continue; }
    out.push([i, close]);
    i = close;
  }
}

/** Where code is, as [start, end) ranges. A fence that never closes runs to the end,
 *  as it does in markdown. */
export function codeRanges(text: string): [number, number][] {
  const out: [number, number][] = [];
  const prose = (from: number, to: number) => {
    const gap = /\n[ \t]*\n/g;
    gap.lastIndex = from;
    let at = from;
    for (let m = gap.exec(text); m && m.index < to; m = gap.exec(text)) {
      spansIn(text, at, m.index, out);
      at = m.index + m[0].length;
    }
    spansIn(text, at, to, out);
  };
  let pos = 0;
  let proseFrom = 0;
  while (pos < text.length) {
    const nl = text.indexOf("\n", pos);
    const lineEnd = nl < 0 ? text.length : nl;
    const open = FENCE_OPEN.exec(text.slice(pos, lineEnd));
    const next = nl < 0 ? text.length : nl + 1;
    // A backtick fence's info string can't hold a backtick: that's a span on one line.
    if (!open || (open[1][0] === "`" && open[2].includes("`"))) { pos = next; continue; }
    prose(proseFrom, pos);
    const mark = open[1];
    let end = text.length;
    let scan = next;
    while (scan < text.length) {
      const e = text.indexOf("\n", scan);
      const stop = e < 0 ? text.length : e;
      const line = text.slice(scan, stop).replace(/^[ \t]*(?:>[ \t]*)*/, "").trimEnd();
      if (line.length >= mark.length && line === mark[0].repeat(line.length)) { end = stop; break; }
      scan = e < 0 ? text.length : e + 1;
    }
    out.push([pos, end]);
    pos = end;
    proseFrom = end;
    if (pos < text.length) pos += 1;
  }
  prose(proseFrom, text.length);
  return out;
}

function stripBrackets(raw: string): string {
  return raw.startsWith("<") && raw.endsWith(">") ? raw.slice(1, -1) : raw;
}

export function parseEmbeds(text: string): Embed[] {
  if (!text.includes("![")) return [];
  const code = codeRanges(text);
  const out: Embed[] = [];
  EMBED.lastIndex = 0;
  for (let m = EMBED.exec(text); m; m = EMBED.exec(text)) {
    const start = m.index;
    const end = start + m[0].length;
    if (code.some(([a, b]) => a < end && b > start)) continue;
    let slashes = 0;
    for (let i = start - 1; i >= 0 && text[i] === "\\"; i--) slashes++;
    if (slashes % 2) continue;
    out.push({ start, end, raw: m[0], alt: m[1], address: stripBrackets(m[2].trim()), title: m[3] ?? null });
  }
  return out;
}

/** The text with its images pulled out, in order. Joining the strings and each embed's
 *  raw gives the text back, so nothing else in a bubble changes. */
export function splitEmbeds(text: string): (string | Embed)[] {
  const out: (string | Embed)[] = [];
  let at = 0;
  for (const e of parseEmbeds(text)) {
    if (e.start > at) out.push(text.slice(at, e.start));
    out.push(e);
    at = e.end;
  }
  if (at < text.length) out.push(text.slice(at));
  return out;
}

export type AddressKind = "local" | "remote" | "other";

/** remote is http(s). other is any other scheme, which the file route refuses and no
 *  surface draws (data:, file:, javascript:…). */
export function addressKind(address: string): AddressKind {
  if (/^https?:\/\//i.test(address)) return "remote";
  return /^[a-z][a-z0-9+.-]*:/i.test(address) ? "other" : "local";
}

/** What a typed address means: trimmed, and <...> is only markdown's wrapping. */
export function normalizeAddress(input: string): string {
  return stripBrackets(input.trim());
}

/** Whether markdown can hold it at all. */
export function writableAddress(address: string): boolean {
  return address.length > 0 && !/[<>\r\n]/.test(address);
}

export function formatEmbed(alt: string, address: string, title: string | null = null): string {
  const target = /[\s()]/.test(address) ? `<${address}>` : address;
  return `![${alt}](${target}${title === null ? "" : ` "${title}"`})`;
}

/** Where the embed is now: at its offsets, or else wherever its source moved to. */
function locate(text: string, e: Embed): number {
  return text.slice(e.start, e.end) === e.raw ? e.start : text.indexOf(e.raw);
}

/** The text with this embed pointing somewhere else; null when it's no longer there. */
export function replaceEmbed(text: string, e: Embed, address: string): string | null {
  const at = locate(text, e);
  if (at < 0) return null;
  return text.slice(0, at) + formatEmbed(e.alt, address, e.title) + text.slice(at + e.raw.length);
}

/** The text without this embed, and without the blank line or the double space that
 *  taking it out would leave. Null when it's no longer there. */
export function removeEmbed(text: string, e: Embed): string | null {
  const at = locate(text, e);
  if (at < 0) return null;
  const before = text.slice(0, at);
  let after = text.slice(at + e.raw.length);
  if ((before === "" || before.endsWith("\n")) && /^[ \t]*\n/.test(after)) after = after.replace(/^[ \t]*\n/, "");
  else if ((before === "" || /\s$/.test(before)) && after.startsWith(" ")) after = after.slice(1);
  return before + after;
}

/** Put markdown over the selection, spaced from what's around it, with the caret after
 *  the space so the next word doesn't touch it. */
export function insertAt(text: string, start: number, end: number, md: string): { text: string; caret: number } {
  const before = text.slice(0, start);
  const after = text.slice(end);
  const head = before && !/\s$/.test(before) ? `${before} ` : before;
  const body = head + md;
  if (/^\s/.test(after)) return { text: body + after, caret: body.length };
  return { text: `${body} ${after}`, caret: body.length + 1 };
}

/** react-markdown hands over an image's src percent-encoded ("a%20b.png"); the file
 *  route wants the path as written. A remote address is a URL and stays as it is. */
export function addressFromSrc(src: string): string {
  if (addressKind(src) !== "local") return src;
  try {
    return decodeURIComponent(src);
  } catch {
    return src;
  }
}
