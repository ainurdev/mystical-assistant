// Run: node --experimental-strip-types src/lib/routes.check.ts  (from web/)
//
// The dashboard's URLs: URL to place and back for a session and each Settings
// page, old ?s= links, and unknown values ignored.
import { extrasOf, fromLegacy, ownSearch, pathOf, placeOf, searchOf, SETTINGS_PAGES, type Extras, type Place } from "./routes.ts";

const eq = (a: unknown, b: unknown, what: string) =>
  console.assert(JSON.stringify(a) === JSON.stringify(b), `${what}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
const round = (p: Place, what: string) => eq(placeOf(pathOf(p)), p, what);

round({ kind: "home" }, "home round-trips");
round({ kind: "session", id: "0f3c2a1e-77aa-4b1c-9d2e-123456789abc" }, "a session round-trips");
eq(pathOf({ kind: "session", id: "abc-1" }), "/s/abc-1", "a session's path");
for (const page of SETTINGS_PAGES) round({ kind: "settings", page }, `settings page ${page} round-trips`);
eq(pathOf({ kind: "settings", page: "system" }), "/settings/system", "a settings page's path");
eq(pathOf({ kind: "settings" }), "/settings/appearance", "settings with no page opens on the first");
// A name an older caller still uses passes through for the modal to map.
eq(placeOf("/settings/clock"), { kind: "settings", page: "clock" }, "a legacy page passes through");

// Unknown values are ignored.
eq(placeOf("/settings/bogus"), { kind: "settings" }, "an unknown settings page opens settings on its default");
eq(placeOf("/nope"), { kind: "home" }, "an unknown path is home");
eq(placeOf("/s/"), { kind: "home" }, "a session with no id is home");
eq(placeOf("/s/a%20b"), { kind: "home" }, "a session id with a space is home");
eq(placeOf("/s/abc/extra"), { kind: "home" }, "a deeper path is home");
eq(placeOf(""), { kind: "home" }, "empty is home");

// ?s=<id> goes to #/s/<id>, with or without skipboot; the token stays.
eq(fromLegacy("http://127.0.0.1:8790/?s=abc-1"), "http://127.0.0.1:8790/#/s/abc-1", "?s= becomes the hash");
eq(fromLegacy("http://127.0.0.1:8790/?s=abc-1&skipboot"), "http://127.0.0.1:8790/?skipboot=#/s/abc-1", "skipboot stays");
eq(fromLegacy("http://127.0.0.1:8790/?skipboot&s=abc-1&token=t"), "http://127.0.0.1:8790/?skipboot=&token=t#/s/abc-1", "token stays");
eq(fromLegacy("http://127.0.0.1:8790/?s=abc-1#/settings/system"), "http://127.0.0.1:8790/#/s/abc-1", "an old link wins over a hash");
eq(fromLegacy("http://127.0.0.1:8790/?token=t"), null, "no ?s= changes nothing");
eq(fromLegacy("http://127.0.0.1:8790/?s=%3Cx%3E#/s/k"), "http://127.0.0.1:8790/#/s/k", "a garbled ?s= is dropped and ignored");

// The rail's tab and the pop-ups, in the search.
const RAILS = ["home", "git", "files"];
const roundX = (e: Extras, what: string) => eq(extrasOf(searchOf(e), RAILS), e, what);
roundX({}, "no extras round-trip");
roundX({ rail: "git" }, "a rail tab round-trips");
roundX({ rail: "files", popup: { kind: "analyze", project: "ainurhq/arda" } }, "analyze round-trips");
roundX({ popup: { kind: "edit", project: "mystical-assistant", path: "bridge/a b:c.py" } }, "edit round-trips");
roundX({ rail: "home", popup: { kind: "pic", turn: "t-12", pic: "k3x9" } }, "pic round-trips");
eq(searchOf({ rail: "git" }), "?rail=git", "a rail tab's search");
eq(searchOf({}), "", "nothing is no search");
// Unknown values are ignored.
eq(extrasOf("?rail=bogus", RAILS), {}, "an unknown rail tab is ignored");
eq(extrasOf("?analyze=", RAILS), {}, "analyze with no project is ignored");
eq(extrasOf("?edit=proj", RAILS), {}, "edit with no file is ignored");
eq(extrasOf("?edit=:a.py", RAILS), {}, "edit with no project is ignored");
eq(extrasOf("?pic=t1", RAILS), {}, "pic with no picture is ignored");
eq(extrasOf("?pic=t1.a.b", RAILS), {}, "a garbled pic is ignored");
eq(extrasOf("?zoom=1&rail=git", RAILS), { rail: "git" }, "an unknown key is ignored");
// At most one pop-up: a hand-made URL naming two opens the first.
eq(extrasOf("?pic=t1.k&analyze=p", RAILS), { popup: { kind: "analyze", project: "p" } }, "two pop-ups open one");

// The page's own query (the token) never reads as the hash's search.
eq(ownSearch("?rail=git?skipboot=1&token=t", "?skipboot=1&token=t"), "?rail=git", "the page's query is cut off");
eq(ownSearch("?skipboot=1&token=t", "?skipboot=1&token=t"), "", "no hash search is none");
eq(ownSearch("?rail=git", ""), "?rail=git", "no page query leaves it whole");
