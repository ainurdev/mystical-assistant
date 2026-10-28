// Run: node bridge/dashboard/web/src/lib/sessionedits.check.ts
import { sessionEdits } from "./sessionedits.ts";

const ok = (cond: boolean, what: string) => {
  if (!cond) throw new Error(`FAIL: ${what}`);
  console.log(`ok - ${what}`);
};
const tool = (name: string, summary: string, detail?: string) => ({ type: "tool", name, summary, detail });
const R = "/u/p/repo";

{
  const { edited, now } = sessionEdits([{ status: "done", events: [
    tool("Edit", `${R}/src/App.tsx`), tool("Read", `${R}/README.md`), tool("Write", `${R}/new.ts`),
    tool("Bash", "ls"), { type: "tool_done" },
  ] }], R);
  ok([...edited].sort().join() === "new.ts,src/App.tsx", `writes only, made relative: ${[...edited]}`);
  ok(now === null, "a finished turn lights nothing");
}

// Another worktree of the same repo, or a file outside it: not this tree's.
{
  const { edited } = sessionEdits([{ status: "done", events: [
    tool("Edit", "/u/p/.worktrees/repo/feat-x/src/App.tsx"), tool("Edit", "/u/p/repo-other/a.ts"),
    tool("Write", "/u/.claude/memory/x.md"),
  ] }], R);
  ok(edited.size === 0, `outside the root is skipped: ${[...edited]}`);
}

// A cut summary: the whole path rides in `detail`.
{
  const { edited } = sessionEdits([{ status: "done", events: [tool("Edit", `${R}/src/compon`, `${R}/src/components/Long.tsx`)] }], `${R}/`);
  ok(edited.has("src/components/Long.tsx") && edited.size === 1, "detail wins over a cut summary, root with a slash");
}

// The running turn's last write is the one lit.
{
  const { now } = sessionEdits([
    { status: "done", events: [tool("Edit", `${R}/old.ts`)] },
    { status: "running", events: [tool("Edit", `${R}/a.ts`), tool("MultiEdit", `${R}/b.ts`), tool("Read", `${R}/c.ts`)] },
  ], R);
  ok(now === "b.ts", `last write of the running turn: ${now}`);
}

ok(sessionEdits([{ status: "running", events: [tool("Edit", `${R}/a.ts`)] }], null).edited.size === 0, "no root, no marks");
