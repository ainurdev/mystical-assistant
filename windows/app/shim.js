// shim.js — window.Notification for the dashboard inside Mystical.exe, and the
// handler the page already talks to (lib/mac.ts): the Mac app's shim
// (macos/Sources/MysticalCore/NotificationShim.swift, its template) carried over
// chrome.webview. Injected at document creation; the top frame only, since the
// preview pane frames other pages. The permission placeholder is seeded by the app
// (Core/Shim.cs). Checked by windows/shim.check.mjs.
(() => {
  if (window !== window.top) return;
  if (window.__mysticalShim) return;
  window.__mysticalShim = true;
  // The Mac's handler, on Windows: a post rides over chrome.webview with an id
  // and resolves when the app answers it back — {id, result} or {id, error} —
  // so lib/mac.ts finds the same object on both platforms.
  const pending = new Map();
  let postSeq = 0;
  const bridge = window.chrome && window.chrome.webview;
  if (bridge) {
    bridge.addEventListener("message", (e) => {
      const d = e.data;
      if (!d || typeof d !== "object" || !pending.has(d.id)) return;
      const { resolve, reject } = pending.get(d.id);
      pending.delete(d.id);
      if (d.error != null) reject(new Error(String(d.error)));
      else resolve(d.result === undefined ? null : d.result);
    });
  }
  window.webkit = window.webkit || {};
  window.webkit.messageHandlers = window.webkit.messageHandlers || {};
  window.webkit.messageHandlers.mysticalNotify = {
    postMessage(msg) {
      if (!bridge) return Promise.resolve(null);
      const id = ++postSeq;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        try { bridge.postMessage({ id, ...msg }); }
        catch (err) { pending.delete(id); reject(err); }
      });
    },
  };
  const post = (msg) => {
    try { return window.webkit.messageHandlers.mysticalNotify.postMessage(msg); }
    catch (e) { return Promise.resolve(null); }
  };
  // id -> instance, so a click from Windows reaches the onclick the page set.
  // Bounded: toasts nobody clicks would otherwise pin their closures forever.
  const live = new Map();
  let seq = 0;
  class Notification {
    constructor(title, options) {
      const o = options || {};
      this.title = String(title);
      this.body = o.body == null ? "" : String(o.body);
      this.tag = o.tag == null ? "" : String(o.tag);
      // The standard shape ({action, title}); `id` accepted too.
      this.actions = Array.isArray(o.actions)
        ? o.actions.map((a) => ({ id: String(a.action == null ? a.id : a.action),
                                  title: String(a.title == null ? "" : a.title) }))
        : [];
      this.onclick = null; this.onclose = null; this.onshow = null; this.onerror = null;
      this.onaction = null;
      this._id = this.tag ? "tag:" + this.tag : "n" + Date.now() + "-" + (++seq);
      live.delete(this._id);
      live.set(this._id, this);
      while (live.size > 200) live.delete(live.keys().next().value);
      if (Notification.permission === "granted")
        post({ op: "show", id: this._id, title: this.title, body: this.body, actions: this.actions });
    }
    close() {
      if (live.get(this._id) === this) live.delete(this._id);
      post({ op: "close", id: this._id });
    }
    static requestPermission(cb) {
      return Promise.resolve(post({ op: "request" })).then((p) => {
        Notification.permission = p === "granted" || p === "denied" ? p : "default";
        if (typeof cb === "function") cb(Notification.permission);
        return Notification.permission;
      });
    }
  }
  Notification.permission = "__PERMISSION__";
  Object.defineProperty(window, "Notification",
    { value: Notification, configurable: true, writable: true });
  // Called by the app when a toast is clicked; false = the page that made it
  // is gone (reloaded), and the app falls back to opening the session.
  window.__mysticalNotificationClick = (id) => {
    const n = live.get(id);
    if (!n) return false;
    if (typeof n.onclick === "function") n.onclick.call(n, { type: "click", target: n });
    return true;
  };
  // A toast button was tapped: run the page's handler, window left alone.
  window.__mysticalNotificationAction = (id, action) => {
    const n = live.get(id);
    if (!n) return false;
    if (typeof n.onaction === "function") n.onaction.call(n, String(action));
    return true;
  };
  window.__mysticalSetPermission = (p) => { Notification.permission = p; };
})();
