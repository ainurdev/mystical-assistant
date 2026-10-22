// Self-check for src/lib/usage.ts: what the dashboard scrubs before PostHog sees it.
// node bridge/dashboard/web/tools/usage.check.mjs   (tests/test_usage_sharing.py runs it)
import assert from "node:assert/strict";
import { CONFIG, maskAttribute, scrubEvent, scrubUrl } from "../src/lib/usage.ts";

const TOKEN = "s3cr3t-dash-token";
const page = `http://127.0.0.1:8790/?token=${TOKEN}&s=0123abcd#x`;

// URLs keep their path and nothing else
assert.equal(scrubUrl(page), "https://mystical.local/");
assert.equal(scrubUrl("https://dash.example.dev/local/attachment?path=/Users/me/x.png&token=t"), "https://mystical.local/local/attachment");

// every event: URLs, hosts, referrers and the page title (the open session's) go
const ev = scrubEvent({
  uuid: "u", event: "$pageview",
  properties: {
    $current_url: page, $host: "127.0.0.1:8790", $pathname: "/", title: "Fix the Elvou login bug",
    $referrer: `https://github.com/ainurdev/x/pull/1?token=${TOKEN}`, $referring_domain: "github.com",
    $session_entry_url: page, $session_entry_host: "127.0.0.1:8790",
    $set_once: { $initial_current_url: page, $initial_host: "dash.example.dev" },
    $heatmap_data: { [page]: [{ x: 1, y: 2 }] },   // keyed by the page URL
  },
});
const out = JSON.stringify(ev);
for (const leak of [TOKEN, "8790", "Elvou", "github", "example.dev"]) assert.ok(!out.includes(leak), `${leak} in ${out}`);
assert.equal(ev.properties.$current_url, "https://mystical.local/");

// replays: what draws the page stays, anything that can hold words goes
for (const [n, v] of [["class", "ntf-pill rich"], ["d", "M12 2L2 7l10 5"], ["_cssText", ".a{color:red}"],
  ["rr_width", "120px"], ["data-fam", "flint"], ["id", "root"], ["aria-expanded", "true"]]) {
  assert.equal(maskAttribute(n, v), v, `${n} lost`);
}
for (const [n, v] of [["title", "/Users/me/client/secret.ts"], ["aria-label", "elvou"], ["href", page],
  ["src", "/local/attachment?token=x"], ["alt", "screenshot"], ["placeholder", "ask"], ["value", "hunter2"],
  ["data-ctx-label", "Fix login"], ["data-tip", "Open"], ["data-who", "maziyar"], ["data-fam", "a b/c"],
  ["id", "session-elvou"], ["rr_dataURL", "data:image/png;base64,AAAA"], ["rr_src", "http://localhost:5173/"]]) {
  assert.equal(maskAttribute(n, v), "*", `${n} kept`);
}
assert.equal(maskAttribute("style", "background:url(/local/attachment?path=/Users/me/x.png);color:red"), "background:url();color:red");
assert.equal(maskAttribute("_cssText", 'src:url("http://dash.example.dev:8790/assets/a.woff2")'), 'src:url("https://mystical.local/assets/a.woff2")');

// the switches a PostHog project could otherwise turn on from its side
assert.equal(CONFIG.disable_external_dependency_loading, true);
assert.equal(CONFIG.enable_recording_console_log, false);
assert.equal(CONFIG.capture_performance, false);
assert.equal(CONFIG.capture_exceptions, false);
assert.equal(CONFIG.capture_heatmaps, false);
assert.equal(CONFIG.session_recording.maskTextSelector, "*");
assert.equal(CONFIG.session_recording.maskCapturedNetworkRequestFn({ name: page }).name, "https://mystical.local/");

console.log("usage.check: ok");
