// Run: node bridge/dashboard/web/src/lib/queries.check.ts
import { hashKey } from "@tanstack/react-query";
import { CHANGES, changedBy, code, main, prHints, queryClient, rail, readWith, reads, urlOf } from "./queries.ts";

const eq = (a: unknown, b: unknown, what: string) => console.assert(JSON.stringify(a) === JSON.stringify(b), `${what}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);

// --- the same route and parameters give equal keys ---------------------------
console.assert(hashKey(code.git({ project: "a", branch: "b" }).queryKey) === hashKey(code.git({ branch: "b", project: "a" }).queryKey),
  "parameter order doesn't split a key");
console.assert(hashKey(main.sessions().queryKey) === hashKey(main.sessions({}).queryKey), "no parameters = empty parameters");
console.assert(hashKey(code.git({ project: "a" }).queryKey) === hashKey(code.git({ project: "a", branch: undefined }).queryKey),
  "an undefined parameter is no parameter");
console.assert(hashKey(code.git({ project: "a" }).queryKey) !== hashKey(code.git({ project: "b" }).queryKey), "other parameters, other key");
console.assert(hashKey(main.agents({ session: "x" }).queryKey) !== hashKey(main.flow({ session: "x" }).queryKey), "other route, other key");

// --- a key reads the URL the old calls built -----------------------------------
eq(urlOf("/local/git", { project: "my app", branch: undefined }), "/local/git?project=my+app", "query, undefined left out");
eq(urlOf("/local/sessions/:id", { id: "ab/c", cursor: 0, tail: 40 }), "/local/sessions/ab%2Fc?cursor=0&tail=40", "path segment filled");
eq(urlOf("/local/state"), "/local/state", "bare route");

// --- only notices and running poll while the page is hidden -------------------
const hidden = [...reads()].filter(([, p]) => p?.hidden).map(([r]) => r).sort();
eq(hidden, ["/local/notices", "/local/running"], "polls while hidden");
console.assert(rail.notices().refetchIntervalInBackground === true && main.state().refetchIntervalInBackground === false,
  "the options carry the hidden rule");
console.assert(main.commands().refetchInterval === false && rail.sysinfo().refetchInterval === 2000, "the options carry the interval");

// --- every key that a change invalidates exists -------------------------------
for (const [post, routes] of Object.entries(CHANGES))
  for (const r of routes) console.assert(reads().has(r), `${post} invalidates ${r}, which no read lists`);
eq(changedBy("/local/sessions/abc/archive"), ["/local/sessions", "/local/running"], "an archive changes the lists");
eq(changedBy("/local/run/j1/interrupt"), ["/local/running", "/local/sessions"], "a stop");
eq(changedBy("/local/run"), ["/local/sessions", "/local/running"], "a send");
eq(changedBy("/local/git/fetch?x=1"), ["/local/git", "/local/git/all", "/local/git/branchstatus", "/local/git/ledger",
  "/local/git/incoming", "/local/git/log", "/local/git/worktrees"], "a fetch, query ignored");
eq(changedBy("/local/restart"), [], "nothing listed, nothing invalidated");
// The code tabs: what a commit, a checkout, a save and a file op change reaches every panel showing it.
const filesRead = ["/local/files/tree", "/local/files/read", "/local/files/head", "/local/git"];
for (const post of ["/local/git/commit", "/local/git/checkout", "/local/files/write", "/local/files/op"])
  for (const r of filesRead) console.assert(changedBy(post).includes(r), `${post} changes ${r}`);
console.assert(changedBy("/local/git/commit").includes("/local/git/log") && changedBy("/local/git/commit").includes("/local/git/ledger"),
  "a commit moves the graph and the ledger");
console.assert(!changedBy("/local/git/commit-message").includes("/local/files/tree"), "writing a message touches no file");
eq(changedBy("/local/terminals/t1/close"), ["/local/terminals"], "closing a terminal");
eq(changedBy("/local/server"), ["/local/state"], "a dev server start: the state poll carries the servers");
// GIT's card and the chat header's chip share one PR read; the session rides in the URL, not the key.
console.assert(hashKey(code.pr({ project: "p", branch: "b" }).queryKey) === hashKey(code.pr({ branch: "b", project: "p" }).queryKey), "one PR key");

// --- a shared poll runs at its listed rate --------------------------------------
const asked: string[] = [];
readWith(async (url) => { asked.push(url); return { n: asked.length }; });
const o = rail.sysinfo();
await queryClient.fetchQuery({ ...o, staleTime: 0 });
await queryClient.fetchQuery({ ...o, staleTime: 0 });          // a second panel's tick, right after
eq(asked, ["/local/sysinfo"], "a second tick within half the interval is answered from the cache");
await queryClient.invalidateQueries({ queryKey: o.queryKey }); // a POST changed it: that one fetches
await queryClient.fetchQuery({ ...o, staleTime: 0 });
eq(asked.length, 2, "an invalidated key fetches at once");
await queryClient.fetchQuery({ ...main.commands({ project: "p" }), staleTime: 0 });
await queryClient.fetchQuery({ ...main.commands({ project: "p" }), staleTime: 0 });
eq(asked.slice(2), ["/local/commands?project=p", "/local/commands?project=p"], "an unpolled read isn't held back");
prHints.session = "s1";
await queryClient.fetchQuery(code.pr({ project: "p", branch: "b" }));
eq(asked.at(-1), "/local/github/pr/status?project=p&branch=b&session=s1", "the PR read carries the chip's session");
queryClient.clear();
