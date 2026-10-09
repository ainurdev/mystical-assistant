import AppKit
import MysticalCore
import UserNotifications
import WebKit

/// The native half of NotificationShim: the page's `new Notification(...)`
/// becomes a macOS banner, and a click on the banner runs the page's onclick.
@MainActor
final class Notifier: NSObject, WKScriptMessageHandlerWithReply,
                      UNUserNotificationCenterDelegate {
    private let center = UNUserNotificationCenter.current()
    /// Web-style permission, kept current so a page load is seeded correctly.
    private(set) var permission = "default"
    /// Called with the shim id of a clicked banner.
    var onClick: ((String) -> Void)?

    override init() {
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
            // No sound: the dashboard plays the one you picked for this event.
            center.add(UNNotificationRequest(identifier: id, content: content, trigger: nil))
            replyHandler(nil, nil)
        case "close":
            if let id = body["id"] as? String {
                center.removeDeliveredNotifications(withIdentifiers: [id])
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
        await MainActor.run { self.onClick?(id) }
    }
}
