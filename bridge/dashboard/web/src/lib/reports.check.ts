// Run: node bridge/dashboard/web/src/lib/reports.check.ts
// The page's scrubber (lib/reports.ts): what a crash report may carry.
import assert from "node:assert/strict";
import type { Breadcrumb, ErrorEvent } from "@sentry/browser";
import { controlOf, isMissingChunk, keepBreadcrumb, options, scrubReport, tagsFor } from "./reports.ts";

const TOKEN = "s3cr3t-dash-token";
const ORIGIN = "http://127.0.0.1:8790";
const opts = options({ on: true, dsn: "http://k@127.0.0.1:1/1", user: "maziyar", os: "macos" }, TOKEN, "Mozilla/5.0 MysticalMac/1.2", ORIGIN);
const crumb = (c: Breadcrumb, target?: unknown) => opts.beforeBreadcrumb!(c, target ? { event: { target } } : undefined);
const send = (e: Partial<ErrorEvent>, original?: unknown) =>
  opts.beforeSend!({ type: undefined, ...e } as ErrorEvent, { originalException: original ?? new Error("x") }) as ErrorEvent | null;

// no console breadcrumbs, and nothing the three kinds don't name
assert.equal(crumb({ category: "console", message: `token=${TOKEN}` }), null);
assert.equal(crumb({ category: "ui.input", message: "textarea.prompt" }), null);
assert.equal(crumb({ category: "sentry.event" }), null);

// navigations: the hash route only, no query, no token
const nav = crumb({ category: "navigation", data: { from: `/?token=${TOKEN}#/s/0123abcd`, to: `/?token=${TOKEN}#/settings/system?x=1` } })!;
assert.deepEqual(nav.data, { from: "#/s/0123abcd", to: "#/settings/system" });

// bridge calls by path; anyone else's dropped
const call = crumb({ category: "fetch", data: { method: "GET", url: `/local/attachment?path=/Users/me/x.png&token=${TOKEN}`, status_code: 200 } })!;
assert.deepEqual(call.data, { method: "GET", url: "/local/attachment", status_code: 200 });
assert.equal(crumb({ category: "fetch", data: { method: "GET", url: "https://api.github.com/repos/x" } }), null);

// a click: the control's role and data-ctx-type, never its text
const el = (tag: string, attrs: Record<string, string>, parent?: unknown) => ({
  tagName: tag, textContent: "Fix the Elvou login bug",
  getAttribute: (n: string) => attrs[n] ?? null,
  closest: (sel: string) => (sel.includes(tag.toLowerCase()) || Object.keys(attrs).some((a) => sel.includes(`[${a}]`)) ? el(tag, attrs, parent) : parent ?? null),
});
const row = el("DIV", { role: "option", "data-ctx-type": "session", title: "Fix the Elvou login bug" });
const click = crumb({ category: "ui.click", message: 'div.row[title="Fix the Elvou login bug"]' }, el("SPAN", {}, row))!;
assert.equal(click.message, "option [session]");
assert.ok(!JSON.stringify(click).includes("Elvou"));
assert.equal(controlOf(el("BUTTON", { "aria-label": "Send elvou" })), "button");

// every report: the token, token shapes and URL queries gone; a prompt cut to its first line; strings capped
const out = send({
  message: `boom at ${ORIGIN}/?token=${TOKEN}&s=1 with sk-ant-oat01-abcdef and Bearer abc.def and bot123:AAxyz`,
  exception: { values: [{ type: "Error", value: `ghp_${"a".repeat(30)} in ${TOKEN}` }] },
  request: { url: `${ORIGIN}/?token=${TOKEN}` },
  contexts: { turn: { prompt: "fix the login\nsecret second line" } },
  extra: { long: "x".repeat(5000) },
  breadcrumbs: [{ category: "navigation", data: { from: "#/", to: "#/s/1" } }, { category: "console", message: TOKEN }],
})!;
const json = JSON.stringify(out);
for (const leak of [TOKEN, "sk-ant-", "abc.def", "AAxyz", "ghp_", "second line"]) assert.ok(!json.includes(leak), `${leak} in ${json}`);
assert.equal(out.request?.url, ORIGIN + "/");
assert.equal((out.contexts?.turn as { prompt: string }).prompt, "fix the login");
assert.equal((out.extra?.long as string).length, 1000);
assert.deepEqual(out.breadcrumbs?.map((b) => b.category), ["navigation"]);

// a script chunk missing after a newer build is never sent
for (const m of ["Failed to fetch dynamically imported module: http://x/assets/Settings-abc.js",
  "Importing a module script failed.", "error loading dynamically imported module", "Unable to preload CSS for /assets/a.css"]) {
  assert.ok(isMissingChunk(new Error(m)), m);
  assert.equal(send({ message: m }, new Error(m)), null);
}
assert.ok(!isMissingChunk(new Error("Cannot read properties of undefined")));

// the same crash twice in a minute: one report
const twice = { exception: { values: [{ type: "TypeError", value: "x", stacktrace: { frames: [{ filename: "/assets/a.js", lineno: 1, colno: 9 }] } }] } };
assert.ok(send(twice));
assert.equal(send(twice), null);

// what each report says about where it ran, and who
assert.deepEqual(tagsFor("Mozilla/5.0 (Macintosh) MysticalMac/1.2", "macos"), { side: "page", os: "macos", app: "Mystical.app" });
assert.deepEqual(tagsFor("Mozilla/5.0 (Windows NT 10.0) Edg/1 MysticalWin/1", "wsl"), { side: "page", os: "windows", app: "Mystical.exe" });
assert.deepEqual(tagsFor("Mozilla/5.0 (X11; Linux) MysticalLinux/1", "linux"), { side: "page", os: "linux", app: "linux window" });
assert.deepEqual(tagsFor("Mozilla/5.0 (Windows NT 10.0) Chrome/130", "wsl"), { side: "page", os: "windows", app: "browser" });
assert.deepEqual(opts.initialScope, { tags: { side: "page", os: "macos", app: "Mystical.app" }, user: { username: "maziyar" } });
assert.equal(opts.defaultIntegrations, false);

// a slow spot goes by its name: the synthetic stack SDK 11 puts on every message is dropped
// (Sentry titled the issue from it, "Module.tE"); a crash keeps its stack
const frames = [{ function: "Module.tE", filename: `${ORIGIN}/assets/index.js`, lineno: 9 }];
const spot = send({ message: "frame", tags: { kind: "slow spot" },
  exception: { values: [{ value: "frame", mechanism: { type: "generic", synthetic: true }, stacktrace: { frames } }] } })!;
assert.equal(spot.exception, undefined);
assert.equal(spot.message, "frame");
const crashed = send({ exception: { values: [{ type: "TypeError", value: "x is undefined", stacktrace: { frames } }] } })!;
assert.equal(crashed.exception?.values?.[0].stacktrace?.frames?.length, 1);

console.log("reports.check: ok");
