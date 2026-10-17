// shim.js under node with a fake chrome.webview — the cases
// macos/Tests/MysticalCoreTests runs against the Mac shim in JavaScriptCore, so
// the twins can't drift, plus the handler bridge that only the Windows one has.
//   node windows/shim.check.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "app", "shim.js"), "utf8");

// A page: window === window.top, and a chrome.webview that records every post
// and answers each by id a tick later, the way the app does — `request` with
// `reply`, anything else with an echo of its op.
function page(permission, reply = "granted", top = true) {
  const listeners = [];
  const sent = [];
  const window = {};
  window.window = window;
  window.top = top ? window : {};
  window.chrome = { webview: {
    postMessage(m) {
      sent.push(JSON.parse(JSON.stringify(m)));
      const result = m.op === "request" ? reply : { echo: m.op };
      queueMicrotask(() => listeners.forEach((fn) => fn({ data: { id: m.id, result } })));
    },
    addEventListener(type, fn) { if (type === "message") listeners.push(fn); },
  } };
  const run = (src) => new Function("window", src)(window);
  run(source.replaceAll("__PERMISSION__", permission));
  return { window, sent, run, deliver: (data) => listeners.forEach((fn) => fn({ data })) };
}

// --- the handler bridge ------------------------------------------------------
{
  const { window, sent } = page("granted");
  const r = await window.webkit.messageHandlers.mysticalNotify.postMessage({ op: "settings" });
  assert.deepEqual(r, { echo: "settings" }, "a post resolves with the app's reply");
  assert.equal(sent[0].op, "settings");
  assert.equal(typeof sent[0].id, "number", "every post carries an id");
}
{
  const { window, deliver } = page("granted");
  deliver({ id: 999, result: 1 });                       // nothing pending: ignored, no throw
  const p = window.webkit.messageHandlers.mysticalNotify.postMessage({ op: "settings" });
  deliver({ id: 999, error: "nope" });                   // not ours: ignored
  assert.deepEqual(await p, { echo: "settings" }, "a stray reply never settles another post");
}
{
  const { window, sent, deliver } = page("granted");
  const p = window.webkit.messageHandlers.mysticalNotify.postMessage({ op: "set", key: "volume", value: true });
  deliver({ id: sent.at(-1).id, error: "unknown setting" });
  await assert.rejects(p, /unknown setting/, "an error reply rejects");
}
{
  const { window } = page("granted", "granted", false);  // an iframe: the preview pane
  assert.equal(window.Notification, undefined, "the shim installs in the top frame only");
  assert.equal(window.webkit, undefined);
}

// --- window.Notification (the Mac cases) ---------------------------------------
{
  const { window, sent } = page("default");
  new window.Notification("⏸ fix", { body: "waiting", tag: "s1" });
  assert.equal(sent.length, 0, "nothing is posted until granted");
}
{
  const { window, sent } = page("granted");
  new window.Notification("⏸ fix", { body: "waiting", tag: "s1", icon: "/favicon.svg" });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].op, "show");
  assert.equal(sent[0].id, "tag:s1", "the id is the tag");
  assert.equal(sent[0].body, "waiting");
  assert.deepEqual(sent[0].actions, [], "no buttons asked for is an empty list, never undefined");
}
{
  const { window } = page("granted");
  let clicked = 0;
  const n = new window.Notification("t", { tag: "s1" });
  n.onclick = () => { clicked++; };
  assert.equal(window.__mysticalNotificationClick("tag:s1"), true, "a click runs the page's handler");
  assert.equal(clicked, 1);
  assert.equal(window.__mysticalNotificationClick("tag:gone"), false, "a toast from before a reload: the app is told");
}
{
  const { window, sent } = page("granted");
  new window.Notification("t", { tag: "s1" }).close();
  assert.deepEqual(sent.map((m) => m.op), ["show", "close"], "close tells the app");
  assert.equal(window.__mysticalNotificationClick("tag:s1"), false, "and forgets the instance");
}
{
  const { window } = page("default", "denied");
  assert.equal(await window.Notification.requestPermission(), "denied", "requestPermission adopts the answer");
  assert.equal(window.Notification.permission, "denied");
}
{
  const { window, run } = page("granted");
  const first = window.Notification;
  run(source.replaceAll("__PERMISSION__", "denied"));
  assert.equal(window.Notification, first, "installs once");
  assert.equal(window.Notification.permission, "granted");
}
{
  const { window } = page("default");
  window.__mysticalSetPermission("granted");
  assert.equal(window.Notification.permission, "granted", "the app can correct the permission after a load");
}
{
  const { window, sent } = page("granted");
  let got = null;
  const n = new window.Notification("⏸ fix", { tag: "s1",
    actions: [{ action: "allow", title: "Allow" }, { action: "deny", title: "Deny" }] });
  n.onaction = (a) => { got = a; };
  assert.deepEqual(sent[0].actions, [{ id: "allow", title: "Allow" }, { id: "deny", title: "Deny" }],
    "the standard actions option posts as id/title");
  assert.equal(window.__mysticalNotificationAction("tag:s1", "deny"), true, "a button runs onaction");
  assert.equal(got, "deny");
  assert.equal(window.__mysticalNotificationAction("tag:gone", "deny"), false);
}

console.log("all passed");
