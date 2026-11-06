// Run: node --experimental-strip-types --no-warnings src/lib/mysticaldir.check.ts
import { deleteAsk, dirBody, dirQuery, groupEntries, imageUrl, isMarkdown, keepWorks, plural, soleFolder, type DirEntry } from "./mysticaldir.ts";

const ok = (cond: boolean, what: string) => {
  if (!cond) throw new Error(`FAIL: ${what}`);
  console.log(`ok - ${what}`);
};
const eq = (a: unknown, b: unknown, what: string) => ok(JSON.stringify(a) === JSON.stringify(b), `${what} (${JSON.stringify(a)})`);
const e = (name: string, kind: string, more: Partial<DirEntry> = {}): DirEntry => ({ name, path: name, dir: false, bytes: 10, at: 1, files: 1, kind, keep: false, preview: "none", deletable: kind !== "bridge", ...more });

const g = groupEntries({ entries: [e("x", "other"), e("dev.log", "bridge"), e("images", "images", { dir: true, files: 3, bytes: 90 }), e("weird", "newkind")] });
eq(g.map((x) => x.kind), ["images", "bridge", "other", "newkind"], "kinds in the panel's order, a new one last");
eq(g[0].bytes, 90, "a group's size");
eq(g[0].files, 3, "and its files");
ok(soleFolder(g[0])?.name === "images", "one folder opens on its contents");
ok(soleFolder(g[1]) === null, "a file doesn't");
eq(groupEntries({ entries: [] }), [], "nothing, no groups");

ok(keepWorks({ kind: "scratch", path: "scratch/probe" }), "keep works inside scratch");
ok(!keepWorks({ kind: "scratch", path: "scratch" }), "not on scratch itself: clearing looks inside it");
ok(!keepWorks({ kind: "scratch", path: "scratch/a/b" }), "nor deep: its parent would go with it");
ok(keepWorks({ kind: "other", path: "x" }), "keep works on top-level other");
ok(!keepWorks({ kind: "docs", path: "docs/a.md" }), "docs never clear, so no keep");

const img = deleteAsk(e("a.png", "images"));
ok(img.confirm && /Old chats/.test(img.text), "images warn and confirm");
ok(!deleteAsk(e("a.txt", "scratch")).confirm, "others don't send confirm");
ok(/3 files/.test(deleteAsk(e("p", "scratch", { dir: true, files: 3 })).text), "a folder says how much");

const u = new URL(imageUrl("images/a b.png", { project: "/p" }), "http://x");
eq(u.pathname, "/local/chat-images/file", "the chat's image route");
eq(u.searchParams.get("path"), ".mystical/images/a b.png", "under .mystical");
eq(u.searchParams.get("project"), "/p", "for the project");
eq(new URL(imageUrl("a.png", { session: "s" }), "http://x").searchParams.get("session"), "s", "or the session");
eq(dirQuery({ project: "/p", session: "s" }, { sub: "images" }), "?sub=images&project=%2Fp", "a project wins over a session");
eq(dirBody({ session: "s" }), { session_id: "s" }, "a session body");
ok(isMarkdown("A.MD") && !isMarkdown("a.log"), "markdown by name");
eq(plural(1, "file"), "1 file", "one");
eq(plural(2, "file"), "2 files", "two");
console.log("all ok");
