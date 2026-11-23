// Run: node --experimental-strip-types src/lib/routes.check.ts  (from web/)
//
// The dashboard's URLs: URL to place and back for a session and each Settings
// page, old ?s= links, and unknown values ignored.
import { fromLegacy, pathOf, placeOf, SETTINGS_PAGES, type Place } from "./routes.ts";

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
