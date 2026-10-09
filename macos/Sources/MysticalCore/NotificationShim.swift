import Foundation

/// `window.Notification` for a page that has none.
///
/// WKWebView doesn't expose the Notification API, and the dashboard's own rules
/// for when to notify (lib/push.ts + the transitions in App.tsx: finished,
/// question, permission, parked, started elsewhere — with its sounds and its
/// "not the session you're looking at") are the ones worth keeping. So instead
/// of re-implementing them natively, this script gives the page the API it
/// already calls, and the app turns each call into a macOS notification. Because
/// the window only hides on close, the page — and so the rules — keep running.
///
/// The page talks to the app through one `WKScriptMessageHandlerWithReply`
/// named `handlerName`; every message is `{op, ...}`.
public enum NotificationShim {
    public static let handlerName = "mysticalNotify"

    /// Web permission strings from the macOS authorization state.
    public static func permission(authorized: Bool?, denied: Bool) -> String {
        if denied { return "denied" }
        return authorized == true ? "granted" : "default"
    }

    /// The notification's identifier: its tag, so a session that pings again
    /// replaces its own banner the way a browser collapses a tag.
    public static func identifier(tag: String?, fallback: String) -> String {
        guard let tag, !tag.isEmpty else { return fallback }
        return "tag:" + tag
    }

    public static func source(permission: String) -> String {
        let p = ["granted", "denied"].contains(permission) ? permission : "default"
        return template.replacingOccurrences(of: "__PERMISSION__", with: p)
    }

    static let template = #"""
    (() => {
      if (window.__mysticalShim) return;
      window.__mysticalShim = true;
      const post = (msg) => {
        try { return window.webkit.messageHandlers.mysticalNotify.postMessage(msg); }
        catch (e) { return Promise.resolve(null); }
      };
      // id -> instance, so a click from macOS reaches the onclick the page set.
      // Bounded: banners nobody clicks would otherwise pin their closures forever.
      const live = new Map();
      let seq = 0;
      class Notification {
        constructor(title, options) {
          const o = options || {};
          this.title = String(title);
          this.body = o.body == null ? "" : String(o.body);
          this.tag = o.tag == null ? "" : String(o.tag);
          this.onclick = null; this.onclose = null; this.onshow = null; this.onerror = null;
          this._id = this.tag ? "tag:" + this.tag : "n" + Date.now() + "-" + (++seq);
          live.delete(this._id);
          live.set(this._id, this);
          while (live.size > 200) live.delete(live.keys().next().value);
          if (Notification.permission === "granted")
            post({ op: "show", id: this._id, title: this.title, body: this.body });
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
      // Called by the app when a banner is clicked; false = the page that made
      // it is gone (reloaded), and the app falls back to opening the session.
      window.__mysticalNotificationClick = (id) => {
        const n = live.get(id);
        if (!n) return false;
        if (typeof n.onclick === "function") n.onclick.call(n, { type: "click", target: n });
        return true;
      };
      window.__mysticalSetPermission = (p) => { Notification.permission = p; };
    })();
    """#
}
