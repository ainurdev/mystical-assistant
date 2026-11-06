// Run: node --experimental-strip-types --no-warnings bridge/miniapp/web/src/lib/embeds.check.ts
import {
  addressFromSrc, addressKind, codeRanges, formatEmbed, insertAt, normalizeAddress,
  parseEmbeds, removeEmbed, replaceEmbed, splitEmbeds, writableAddress,
} from "./embeds.ts";

const ok = (cond: boolean, what: string) => {
  if (!cond) throw new Error(`FAIL: ${what}`);
  console.log(`ok - ${what}`);
};
const addrs = (t: string) => parseEmbeds(t).map((e) => e.address).join("|");

// --- parsing -------------------------------------------------------------
ok(addrs("no images here") === "", "plain text has none");
ok(addrs("![image](.mystical/images/a.png)") === ".mystical/images/a.png", "the shape the bridge writes");
ok(addrs("a ![x](1.png) b ![y](2.png) c") === "1.png|2.png", "two in a sentence");
ok(addrs("![x](<my shots/a b.png>)") === "my shots/a b.png", "spaces in <...>, without the brackets");
ok(addrs("![x](a b.png)") === "", "spaces without <...> aren't an image");
ok(addrs("![x](") === "" && addrs("![x](a.png") === "", "half typed isn't an image");
ok(addrs("[x](a.png)") === "", "a link isn't an image");
ok(addrs("\\![x](a.png)") === "", "an escaped ! isn't an image");
ok(addrs("\\\\![x](a.png)") === "a.png", "an escaped backslash leaves the ! alone");
{
  const [e] = parseEmbeds('![a b](c.png "A title")');
  ok(e.alt === "a b" && e.address === "c.png" && e.title === "A title", "alt and title");
  const [f] = parseEmbeds('![](<c d.png>   "t")');
  ok(f.alt === "" && f.address === "c d.png" && f.title === "t", "empty alt, title after <...>");
  const [g] = parseEmbeds("x ![a](b.png) y");
  ok(g.start === 2 && g.end === 13 && g.raw === "![a](b.png)", "offsets and source");
  ok(parseEmbeds("![a](b.png)")[0].title === null, "no title is null");
}

// --- not in code ---------------------------------------------------------
ok(addrs("`![x](a.png)`") === "", "inside a span");
ok(addrs("``![x](a.png)``") === "", "inside a double span");
ok(addrs("`` ` ![x](a.png) ``") === "", "a span holding a backtick");
ok(addrs("`code` ![x](a.png) `code`") === "a.png", "between two spans");
ok(addrs("a ` b ![x](a.png)") === "a.png", "an unmatched backtick is text");
ok(addrs("a ` b\n\n![x](a.png) ` c") === "a.png", "a span can't cross a blank line");
ok(addrs("\\`![x](a.png)\\`") === "a.png", "escaped backticks open nothing");
ok(addrs("![x](`a.png`)") === "", "a span overlapping the address wins");
ok(addrs("```\n![x](a.png)\n```") === "", "inside a fence");
ok(addrs("```py\n![x](a.png)\n```\n![y](b.png)") === "b.png", "after a fence closes");
ok(addrs("~~~\n![x](a.png)\n~~~") === "", "a tilde fence");
ok(addrs("````\n```\n![x](a.png)\n```\n````\n![y](b.png)") === "b.png", "a shorter run doesn't close a longer fence");
ok(addrs("```\n![x](a.png)") === "", "an unclosed fence runs to the end");
ok(addrs("> ```\n> ![x](a.png)\n> ```") === "", "a fence in a quote");
ok(addrs("``` not a fence ``` ![x](a.png)") === "a.png", "backticks in an info string make it a span");
ok(addrs("![x](a.png)\n```\n![y](b.png)\n```\n![z](c.png)") === "a.png|c.png", "either side of a fence");
ok(codeRanges("no code").length === 0, "no ranges in plain text");

// --- splitting keeps the text --------------------------------------------
{
  const t = "first\n\n  ![a](1.png)\nsecond  ![b](<2 3.png>) `![c](x.png)`\n";
  const joined = splitEmbeds(t).map((p) => (typeof p === "string" ? p : p.raw)).join("");
  ok(joined === t, "whitespace survives the split");
  ok(splitEmbeds(t).filter((p) => typeof p !== "string").length === 2, "only the real ones split");
  ok(splitEmbeds("").length === 0, "empty stays empty");
  ok(splitEmbeds("![a](1.png)").length === 1, "no empty strings around one image");
}

// --- addresses -----------------------------------------------------------
ok(addressKind(".mystical/images/a.png") === "local", "relative is local");
ok(addressKind("/abs/a.png") === "local", "absolute is local");
ok(addressKind("//evil.example/a.png") === "local", "protocol-relative is a path, and the route refuses it");
ok(addressKind("https://x.io/a.png") === "remote" && addressKind("HTTP://x.io/a") === "remote", "http(s) is remote");
ok(addressKind("data:image/png;base64,AA") === "other", "data: is neither");
ok(addressKind("javascript:alert(1)") === "other" && addressKind("file:///etc/passwd") === "other", "other schemes");
ok(normalizeAddress("  <a b.png> ") === "a b.png", "typed brackets are markdown's");
ok(writableAddress("a b.png") && !writableAddress("") && !writableAddress("a>b") && !writableAddress("a\nb"), "writable");
ok(addressFromSrc("my%20shots/a%20b.png") === "my shots/a b.png", "remark's encoding comes off");
ok(addressFromSrc("100%.png") === "100%.png", "a bare percent survives");
ok(addressFromSrc("https://x.io/a%20b.png") === "https://x.io/a%20b.png", "a URL stays encoded");

// --- writing -------------------------------------------------------------
ok(formatEmbed("a", "b.png") === "![a](b.png)", "plain");
ok(formatEmbed("a", "b c.png") === "![a](<b c.png>)", "spaces get brackets");
ok(formatEmbed("a", "b(1).png") === "![a](<b(1).png>)", "parens get brackets");
ok(formatEmbed("a", "b.png", "T") === '![a](b.png "T")', "title");
for (const [alt, addr, title] of [["x", "a b/c.png", "t"], ["", "(1).png", null]] as const) {
  const [e] = parseEmbeds(formatEmbed(alt, addr, title));
  ok(e.alt === alt && e.address === addr && e.title === title, `round trip ${addr}`);
}
{
  const t = 'see ![a](old.png "T") now';
  const [e] = parseEmbeds(t);
  ok(replaceEmbed(t, e, "new one.png") === 'see ![a](<new one.png> "T") now', "replace keeps alt and title");
  ok(replaceEmbed(`typed ${t}`, e, "n.png") === 'typed see ![a](n.png "T") now', "replace finds a moved embed");
  ok(replaceEmbed("gone", e, "n.png") === null, "replace of a vanished embed");
  ok(removeEmbed(t, e) === "see now", "remove leaves one space");
  ok(removeEmbed("gone", e) === null, "remove of a vanished embed");
}
{
  const rm = (t: string) => removeEmbed(t, parseEmbeds(t)[0]);
  ok(rm("![a](b.png)") === "", "remove the only thing");
  ok(rm("![a](b.png)\nnext") === "next", "remove its own first line");
  ok(rm("one\n![a](b.png)\ntwo") === "one\ntwo", "remove its own middle line");
  ok(rm("one\n![a](b.png)") === "one\n", "remove a last line");
  ok(rm("x![a](b.png)y") === "xy", "remove between words touching it");
  ok(rm("![a](b.png) word") === "word", "remove at the head");
}
{
  const r = insertAt("", 0, 0, "![i](a.png)");
  ok(r.text === "![i](a.png) " && r.caret === 12, "into an empty draft");
  const s = insertAt("hello world", 5, 5, "![i](a.png)");
  ok(s.text === "hello ![i](a.png) world" && s.caret === 17, "mid-sentence, the space isn't doubled");
  const t = insertAt("hello", 5, 5, "![i](a.png)");
  ok(t.text === "hello ![i](a.png) " && t.caret === t.text.length, "at the end");
  const u = insertAt("swap THIS out", 5, 9, "![i](a.png)");
  ok(u.text === "swap ![i](a.png) out", "over a selection");
  const v = insertAt("line\nnext", 5, 5, "![i](a.png)");
  ok(v.text === "line\n![i](a.png) next", "at the start of a line");
  ok(parseEmbeds(insertAt(t.text, t.caret, t.caret, "![j](b.png)").text).length === 2, "two in a row both parse");
}

console.log("embeds: all checks passed");
