import AppKit
import MysticalCore
import UserNotifications
import WebKit

/// The page's line to the app — every `{op, …}` the shim's handler carries.
///
/// Notifications first: the page's `new Notification(...)` becomes a macOS
/// banner, a click runs the page's onclick, and a banner button runs the page's
/// onaction (NotificationShim). Then the MAC APP tab's ops: `settings` / `set`
/// for the app-owned switches (MacPrefs), `appearance` so native chrome follows
/// the theme, `rebuild` for `mystical app`, `drag` to move the window from the
/// HUD's top row (the title bar's stand-in). One handler, because the page has
/// one `postMessage` target and every op is a few lines.
@MainActor
final class Notifier: NSObject, WKScriptMessageHandlerWithReply,
                      UNUserNotificationCenterDelegate {
    private let center = UNUserNotificationCenter.current()
    /// Web-style permission, kept current so a page load is seeded correctly.
    private(set) var permission = "default"
    /// Called with the shim id of a clicked banner.
    var onClick: ((String) -> Void)?
    /// Called with (shim id, action id) when a banner button is tapped.
    var onAction: ((String, String) -> Void)?
    /// The page changed a switch (already saved).
    var onPrefs: ((MacPrefs) -> Void)?
    /// The page's theme is light (true) or dark.
    var onAppearance: ((Bool) -> Void)?
    var onRebuild: (() -> Void)?

    /// The MAC APP tab's switches, UserDefaults-backed; the app reads them here.
    private(set) var prefs = MacPrefs(.standard)
    private let version: String
    /// Button sets already registered with the center, by category id.
    private var categories: [String: UNNotificationCategory] = [:]

    init(version: String) {
        self.version = version
        super.init()
        center.delegate = self
        Task { await refreshPermission() }
    }

    @discardableResult
    func refreshPermission() async -> String {
        let s = await center.notificationSettings()
        permission = NotificationShim.permission(
            authorized: [.authorized, .provisional].contains(s.authorizationStatus),
            denied: s.authorizationStatus == .denied)
        return permission
    }

    /// What the page's `settings` / `set` get back.
    private var settingsReply: [String: Any] {
        var d: [String: Any] = prefs.dict
        d["version"] = version
        return d
    }

    // MARK: page -> app

    func userContentController(_ ucc: WKUserContentController, didReceive message: WKScriptMessage,
                               replyHandler: @escaping (Any?, String?) -> Void) {
        guard let body = message.body as? [String: Any], let op = body["op"] as? String else {
            return replyHandler(nil, "bad message")
        }
        switch op {
        case "request":
            Task {
                // Ask only once: after a denial macOS won't prompt again, and the
                // page's toggle should simply read "denied".
                if await refreshPermission() == "default" {
                    _ = try? await center.requestAuthorization(options: [.alert, .badge])
                }
                replyHandler(await refreshPermission(), nil)
            }
        case "show":
            let id = body["id"] as? String ?? UUID().uuidString
            let content = UNMutableNotificationContent()
            content.title = body["title"] as? String ?? ""
            content.body = body["body"] as? String ?? ""
            content.userInfo = ["id": id]
            let actions = NotificationShim.actions(body["actions"])
            if !actions.isEmpty {
                let cat = NotificationShim.category(for: actions)
                if categories[cat] == nil {
                    // No .foreground: a button answers the card where you are.
                    categories[cat] = UNNotificationCategory(
                        identifier: cat,
                        actions: actions.map { UNNotificationAction(identifier: $0.id, title: $0.title, options: []) },
                        intentIdentifiers: [], options: [])
                    center.setNotificationCategories(Set(categories.values))
                }
                content.categoryIdentifier = cat
            }
            // No sound: the dashboard plays the one you picked for this event.
            center.add(UNNotificationRequest(identifier: id, content: content, trigger: nil))
            replyHandler(nil, nil)
        case "close":
            if let id = body["id"] as? String {
                center.removeDeliveredNotifications(withIdentifiers: [id])
            }
            replyHandler(nil, nil)
        case "settings":
            replyHandler(settingsReply, nil)
        case "set":
            guard let key = body["key"] as? String, let value = body["value"] as? Bool,
                  prefs.set(key, value) else { return replyHandler(nil, "unknown setting") }
            prefs.save(.standard)
            onPrefs?(prefs)
            replyHandler(settingsReply, nil)
        case "appearance":
            let light = body["light"] as? Bool ?? false
            UserDefaults.standard.set(light, forKey: "appearanceLight")
            onAppearance?(light)
            replyHandler(nil, nil)
        case "rebuild":
            onRebuild?()
            replyHandler(nil, nil)
        case "drag":
            // The press that sent this is still the current event (the page posts
            // on mousedown); moving the mouse first just makes it the drag.
            if let e = NSApp.currentEvent, [.leftMouseDown, .leftMouseDragged].contains(e.type) {
                message.webView?.window?.performDrag(with: e)
            }
            replyHandler(nil, nil)
        default:
            replyHandler(nil, "unknown op")
        }
    }

    // MARK: macOS -> app

    /// Show banners while the app is frontmost too: the page already skipped
    /// the session you're looking at, so anything that reaches here is news.
    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter,
                                            willPresent notification: UNNotification)
        async -> UNNotificationPresentationOptions {
        [.banner, .list]
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter,
                                            didReceive response: UNNotificationResponse) async {
        let id = response.notification.request.content.userInfo["id"] as? String
            ?? response.notification.request.identifier
        let action = response.actionIdentifier
        await MainActor.run {
            if action == UNNotificationDefaultActionIdentifier { self.onClick?(id) }
            else if action != UNNotificationDismissActionIdentifier { self.onAction?(id, action) }
        }
    }
}
