// Run: node bridge/dashboard/web/src/lib/queries.check.ts
import { hashKey } from "@tanstack/react-query";
import { CHANGES, changedBy, code, main, queryClient, rail, readWith, reads, settings, urlOf } from "./queries.ts";

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
eq(changedBy("/local/git/commit?x=1"), ["/local/git", "/local/git/all", "/local/git/branchstatus"], "a commit, query ignored");
eq(changedBy("/local/restart"), [], "nothing listed, nothing invalidated");
// Settings: a switch shows at once wherever it's read (the prompt box, the rail, the sidebar).
eq(changedBy("/local/aifeatures"), ["/local/aifeatures"], "an AI switch");
eq(changedBy("/local/flows"), ["/local/flows", "/local/aifeatures"], "a flow setting, which can be an AI switch");
eq(changedBy("/local/integrations"), ["/local/integrations"], "an install or remove");
eq(changedBy("/local/rivendell"), ["/local/rivendell", "/local/integrations"], "an instance saved: the integration's count");
eq(changedBy("/local/move/export"), ["/local/move/plan", "/local/move/files", "/local/move/read", "/local/move/jobs"], "a move started");
eq(changedBy("/local/acp/login"), [], "a sign-in's status poll changes nothing");
eq(changedBy("/local/skills/check"), [], "a skills update check changes nothing");
console.assert(hashKey(settings.skills({ project: "/r" }).queryKey) === hashKey(settings.skills({ project: "/r" }).queryKey)
  && hashKey(settings.skills({ project: undefined }).queryKey) === hashKey(settings.skills().queryKey), "Settings ▸ Skills and the rail's count share a key");
eq(urlOf(settings.projectSettings.route, { project: "/a b" }), "/local/project/settings?project=%2Fa+b", "a project's settings");

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
queryClient.clear();
