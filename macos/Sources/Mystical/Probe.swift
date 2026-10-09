import AppKit
import WebKit

/// Lets an agent look at the app without Screen Recording permission (which a
/// bridge-hosted session doesn't have, so `screencapture -l` fails). Post
///
///     cloud.ainurhq.mystical.probe  object: "/abs/dir"
///
/// as a distributed notification (macos/probe.sh does) and the app writes
/// `<dir>/window.png` — WebKit's own in-process snapshot of the page, or the
/// placeholder — and `<dir>/state.json`. Read-only: it changes nothing.
@MainActor
enum Probe {
    static let name = Notification.Name("cloud.ainurhq.mystical.probe")

    static func install(window: DashboardWindow, bridge: Bridge, notifier: Notifier) {
        DistributedNotificationCenter.default().addObserver(
            forName: name, object: nil, queue: .main) { note in
            guard let dir = note.object as? String, dir.hasPrefix("/") else { return }
            MainActor.assumeIsolated { write(to: URL(fileURLWithPath: dir), window, bridge, notifier) }
        }
    }

    private static func write(to dir: URL, _ w: DashboardWindow, _ bridge: Bridge, _ notifier: Notifier) {
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let state: [String: Any] = [
            "visible": w.window?.isVisible ?? false,
            "page": w.webView.url?.absoluteString ?? NSNull(),
            "placeholder": w.placeholderText ?? NSNull(),
            "up": bridge.up,
            "misses": bridge.misses,
            "running": bridge.status?.running ?? NSNull(),
            "supervised": bridge.status?.supervised ?? NSNull(),
            "waiting": bridge.waiting.map { ["id": $0.id, "title": $0.title, "label": $0.label] },
            "permission": notifier.permission,
            "activationPolicy": NSApp.activationPolicy() == .regular ? "regular" : "accessory",
        ]
        if let data = try? JSONSerialization.data(withJSONObject: state, options: [.prettyPrinted, .sortedKeys]) {
            try? data.write(to: dir.appendingPathComponent("state.json"))
        }
        let png = dir.appendingPathComponent("window.png")
        if w.placeholderText == nil {
            w.webView.takeSnapshot(with: nil) { image, _ in
                if let image { try? pngData(image)?.write(to: png) }
            }
        } else if let view = w.window?.contentView,
                  let rep = view.bitmapImageRepForCachingDisplay(in: view.bounds) {
            view.cacheDisplay(in: view.bounds, to: rep)
            try? rep.representation(using: .png, properties: [:])?.write(to: png)
        }
    }

    private static func pngData(_ image: NSImage) -> Data? {
        guard let tiff = image.tiffRepresentation, let rep = NSBitmapImageRep(data: tiff) else { return nil }
        return rep.representation(using: .png, properties: [:])
    }
}
