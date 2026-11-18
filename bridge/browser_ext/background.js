// The Mystical browser's extension, its one privileged half: it takes the screenshots and talks to
// the bridge (bridge/site_browser.py) for the page script, which can do neither. config.json is
// written by the bridge at launch and read fresh on every call, so a bridge that came back on a
// new port is found without reloading the extension.
const config = async () => (await fetch(chrome.runtime.getURL("config.json"), { cache: "no-store" })).json();

async function api(path, body) {
  const c = await config();
  const r = await fetch(`http://127.0.0.1:${c.port}${path}`, {
    method: body ? "POST" : "GET",
    headers: { "X-Mystical-Token": c.token, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const got = await r.json().catch(() => ({}));
  return r.ok ? got : { error: got.error || `The bridge answered ${r.status}.` };
}

chrome.runtime.onMessage.addListener((m, sender, reply) => {
  const work = m.kind === "capture"
    ? chrome.tabs.captureVisibleTab(sender.tab.windowId, { format: "png" }).then((shot) => ({ shot }))
    : m.kind === "api" ? api(m.path, m.body) : Promise.resolve({ error: "Unknown request." });
  work.then(reply, (e) => reply({ error: e && e.message ? `Mystical isn't answering: ${e.message}` : "Mystical isn't answering." }));
  return true;
});
