// Run: node --experimental-strip-types --no-warnings src/lib/embeds.check.ts
import {
  addressChange, classifyAddress, cleanAddress, decodeSrc, embedMarkdown, findEmbeds, fitBox,
  formatAddress, imageName, imageSrc, isInlineImage, minimalChange,
} from "./embeds.ts";

const ok = (cond: boolean, what: string) => {
  if (!cond) throw new Error(`FAIL: ${what}`);
  console.log(`ok - ${what}`);
};
const addrs = (t: string) => findEmbeds(t).map((e) => e.address);
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

// The plain forms.
{
  const t = "see ![image](.mystical/images/a.png) ok";
  const [e] = findEmbeds(t);
  ok(e.alt === "image" && e.address === ".mystical/images/a.png", "alt and address");
  ok(t.slice(e.from, e.to) === "![image](.mystical/images/a.png)", "the range is the whole markup");
  ok(t.slice(e.addrFrom, e.addrTo) === ".mystical/images/a.png", "the address range is the address");
}
ok(same(addrs("![](a.png)"), ["a.png"]), "empty alt");
ok(same(addrs("![a](x.png)![b](y.png) ![c](z.png)"), ["x.png", "y.png", "z.png"]), "several on a line");
ok(same(addrs("![a](x.png)\n\n![b](y.png)"), ["x.png", "y.png"]), "several lines");
ok(same(addrs("![a]()"), []), "no address, no image");
ok(same(addrs("![a](x.png"), []), "a partial address isn't one yet");
ok(same(addrs("[a](x.png)"), []), "a link isn't an image");
ok(same(addrs("\\![a](x.png)"), []), "an escaped ! isn't an image");
ok(same(addrs("\\\\![a](x.png)"), ["x.png"]), "an escaped backslash leaves it one");
ok(same(addrs("![a ![b](c.png)"), ["c.png"]), "an unclosed bracket before one doesn't swallow it");
ok(same(addrs("[![badge](b.svg)](https://x.y)"), ["b.svg"]), "an image inside a link");

// Spaces, titles, parens.
{
  const t = "![shot](<my shots/a b.png>)";
  const [e] = findEmbeds(t);
  ok(e.address === "my shots/a b.png", "a path with spaces loses its brackets");
  ok(t.slice(e.addrFrom, e.addrTo) === "<my shots/a b.png>", "its range keeps them");
}
ok(same(addrs("![a](a b.png)"), []), "spaces without brackets aren't an address");
{
  const [e] = findEmbeds('![a](x.png "a title")');
  ok(e.address === "x.png" && e.title === "a title", "a double-quoted title");
  ok(findEmbeds("![a](x.png 'one')")[0].title === "one", "a single-quoted title");
  ok(findEmbeds('![a](<a b.png>  "t" )')[0].title === "t", "brackets and a title, loose spacing");
  ok(findEmbeds("![a]( x.png )")[0].address === "x.png", "spaces inside the parens");
}
ok(same(addrs("![a](foo(1).png)"), ["foo(1).png"]), "balanced parens in a bare path");
ok(same(addrs("(![a](x.png))"), ["x.png"]), "wrapped in parens");

// Never in code.
ok(same(addrs("`![a](x.png)`"), []), "not in a code span");
ok(same(addrs("``a ` ![a](x.png) ``"), []), "not in a double-tick span");
ok(same(addrs("` ![a](x.png)"), ["x.png"]), "an unclosed tick is only a tick");
ok(same(addrs("\\`![a](x.png)\\`"), ["x.png"]), "escaped ticks open nothing");
ok(same(addrs("`a\n\n![a](x.png) `"), ["x.png"]), "a code span stops at a blank line");
ok(same(addrs("```\n![a](x.png)\n```\n![b](y.png)"), ["y.png"]), "not in a fence, and after it again");
ok(same(addrs("~~~md\n![a](x.png)\n~~~"), []), "tilde fence");
ok(same(addrs("```\n![a](x.png)"), []), "an unclosed fence runs to the end");
ok(same(addrs("````\n```\n![a](x.png)\n```\n````"), []), "a longer fence isn't closed by a shorter");
ok(same(addrs("```\n![a](x.png)\n~~~\n![b](y.png)\n```"), []), "the other fence char doesn't close it");
ok(same(addrs("> ```\n> ![a](x.png)\n> ```"), []), "a fence in a quote");
ok(same(addrs("- ```\n  ![a](x.png)\n  ```"), []), "a fence in a list item");
ok(same(addrs("``` ![a](x.png) ```"), []), "a one-line triple tick is a span");
ok(same(addrs("`a` ![a](x.png) `b`"), ["x.png"]), "between two spans");
ok(same(addrs("![a](x`y.png) `"), []), "a span opening inside the markup wins, as in markdown");

// Classifying.
const kinds: [string, string][] = [
  [".mystical/images/a.png", "local"], ["a b.png", "local"], ["/abs/a.png", "local"], ["../a.png", "local"],
  ["http://x.y/a.png", "remote"], ["HTTPS://x.y/a.png", "remote"],
  ["http:a.png", "other"], ["https://", "other"], ["data:image/png;base64,AA", "other"], ["file:///a.png", "other"],
  ["javascript:alert(1)", "other"], ["~/a.png", "other"], ["//evil.y/a.png", "other"], ["", "other"], ["   ", "other"],
  ["C:\\a.png", "other"],
];
for (const [a, k] of kinds) ok(classifyAddress(a) === k, `${JSON.stringify(a)} is ${k}`);

// Where an address loads from.
ok(imageSrc("https://x.y/a.png", { session: "s" }) === "https://x.y/a.png", "a remote address loads directly");
ok(imageSrc("data:image/png;base64,AA", { session: "s" }) === null, "a data URL loads nothing");
ok(imageSrc("//evil.y/a.png", {}) === null, "a protocol-relative address never reaches the browser");
{
  const u = new URL(imageSrc("my shots/a&b.png", { session: "s1", project: "p/q" })!, "http://h");
  ok(u.pathname === "/local/chat-images/file", "the file route");
  ok(u.searchParams.get("path") === "my shots/a&b.png", "the path survives encoding");
  ok(u.searchParams.get("session") === "s1" && u.searchParams.get("project") === "p/q", "session and project");
  ok(!new URL(imageSrc("a.png", { project: "p" })!, "http://h").searchParams.has("session"), "no session, no session=");
  ok(!new URL(imageSrc("a.png", { session: "s", project: null })!, "http://h").searchParams.has("project"), "no project, no project=");
}

// Writing it back.
ok(formatAddress("a.png") === "a.png" && formatAddress("a b.png") === "<a b.png>", "brackets only for spaces");
ok(formatAddress("a(1).png") === "<a(1).png>", "brackets for parens, which chat_images.EMBED needs");
ok(embedMarkdown("x", "a b.png") === "![x](<a b.png>)", "markdown with brackets");
ok(embedMarkdown("", "a.png", "t") === '![](a.png "t")', "markdown with a title, no alt");
for (const w of ["![x](<a b.png>)", '![](a.png "t")', "![image](a(1).png)"]) {
  const [e] = findEmbeds(w);
  ok(findEmbeds(embedMarkdown(e.alt, e.address, e.title))[0].address === e.address, `${w} reads back`);
}
{
  const t = 'a ![x](old.png "keep") b';
  const [e] = findEmbeds(t);
  const c = addressChange(e, "new one.png");
  ok(t.slice(0, c.from) + c.insert + t.slice(c.to) === 'a ![x](<new one.png> "keep") b', "an address edit touches only the address");
}
ok(cleanAddress(" a.png ") === "a.png", "the box trims");
ok(cleanAddress("<a b.png>") === "a b.png", "the box takes brackets");
ok(cleanAddress("") === null && cleanAddress("  ") === null && cleanAddress("<>") === null, "empty isn't an address");
ok(cleanAddress("a>b.png") === null && cleanAddress("a\nb") === null, "what can't read back isn't an address");

// Odds and ends.
for (const m of ["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif", "image/bmp"]) ok(isInlineImage(m), `${m} goes in the chat`);
for (const m of ["image/svg+xml", "image/heic", "text/csv", "application/pdf", "video/mp4", ""]) ok(!isInlineImage(m), `${JSON.stringify(m)} stays an attachment`);
ok(imageName("a chart", "x/y.png") === "a chart", "the alt names it");
ok(imageName("image", ".mystical/images/y.png") === "y.png" && imageName("", "https://h/y.png?s=1") === "y.png", "or the file does");
ok(same(fitBox(1000, 800, 160), { width: 200, height: 160 }), "fit caps the height");
ok(same(fitBox(100, 50, 160), { width: 100, height: 50 }), "fit doesn't enlarge");
ok(fitBox(0, 0, 160) === null, "no size, no box");
ok(decodeSrc("my%20shots/a.png") === "my shots/a.png" && decodeSrc("100%.png") === "100%.png", "decoding survives a bare %");

const apply = (a: string, c: { from: number; to: number; insert: string }) => a.slice(0, c.from) + c.insert + a.slice(c.to);
for (const [a, b] of [["abc", "abc"], ["", "x"], ["x", ""], ["aXb", "aYb"], ["aaa", "aaaa"], ["aaaa", "aa"], ["ab ![i](a) cd", "ab @f ![i](a) cd"]] as const) {
  ok(apply(a, minimalChange(a, b)) === b, `${JSON.stringify(a)} becomes ${JSON.stringify(b)}`);
}
{
  const c = minimalChange("ab ![i](a) cd", "ab @f ![i](a) cd");
  ok(c.from === 3 && c.to === 3 && c.insert === "@f ", "a splice beside an image leaves the image alone");
}

console.log("embeds ok");
