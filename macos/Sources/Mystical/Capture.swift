import AppKit
import MysticalCore
import ScreenCaptureKit

/// Real screen captures for bridge sessions (macos/capture.sh). A `claude -p`
/// child has no Screen Recording permission and never will — TCC grants it per
/// app — so its `screencapture` returns wallpaper, which is why Probe snapshots
/// only this app's own window. The app can hold the permission: post
///
///     cloud.ainurhq.mystical.capture  object: {"dir": "/abs", "window": "title"?}
///
/// and it writes `<dir>/capture.png` (the first window whose title or app name
/// contains `window`, else the main display) and `<dir>/capture.json` — `ok`,
/// an `error` that names the setting to flip, and the windows it could see.
/// Request-only: nothing is captured unless a local process asks.
///
/// shortcut: the bundle is ad-hoc signed, so TCC keys the permission to this
/// build's hash and every `mystical app` needs it re-granted; a stable
/// self-signed identity in build.sh fixes that, when captures are routine.
@MainActor
enum Capture {
    static let name = Notification.Name("cloud.ainurhq.mystical.capture")

    static func install() {
        DistributedNotificationCenter.default().addObserver(
            forName: name, object: nil, queue: .main) { note in
            guard let req = CaptureRequest.parse(note.object) else { return }
            Task { @MainActor in await run(req) }
        }
    }

    private static func run(_ req: CaptureRequest) async {
        let dir = URL(fileURLWithPath: req.dir)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        var out: [String: Any] = ["ok": false]
        if CGPreflightScreenCaptureAccess() {
            do { try await capture(req, into: dir, report: &out) } catch { out["error"] = "\(error)" }
        } else {
            // One macOS prompt the first time; afterwards this only opens System Settings.
            CGRequestScreenCaptureAccess()
            out["error"] = "Screen Recording is not allowed for Mystical — System Settings › "
                + "Privacy & Security › Screen Recording: add or re-tick Mystical, then quit and "
                + "reopen the app. (Each rebuild counts as a new app here.)"
        }
        if let data = try? JSONSerialization.data(withJSONObject: out, options: [.prettyPrinted, .sortedKeys]) {
            try? data.write(to: dir.appendingPathComponent("capture.json"))
        }
    }

    private static func capture(_ req: CaptureRequest, into dir: URL, report out: inout [String: Any]) async throws {
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
        let windows = content.windows.filter { !($0.title ?? "").isEmpty }
        out["windows"] = windows.prefix(60).map {
            ["app": $0.owningApplication?.applicationName ?? "", "title": $0.title ?? ""]
        }
        let scale = NSScreen.main?.backingScaleFactor ?? 2
        let cfg = SCStreamConfiguration()
        cfg.showsCursor = false
        let filter: SCContentFilter
        if let asked = req.window {
            guard let w = windows.first(where: {
                CaptureRequest.matches(asked, title: $0.title, app: $0.owningApplication?.applicationName)
            }) else {
                out["error"] = "no window whose title or app contains \"\(asked)\""
                return
            }
            filter = SCContentFilter(desktopIndependentWindow: w)
            cfg.width = Int(w.frame.width * scale)
            cfg.height = Int(w.frame.height * scale)
        } else {
            guard let display = content.displays.first(where: { $0.displayID == CGMainDisplayID() })
                    ?? content.displays.first else {
                out["error"] = "no display to capture"
                return
            }
            filter = SCContentFilter(display: display, excludingWindows: [])
            cfg.width = Int(CGFloat(display.width) * scale)
            cfg.height = Int(CGFloat(display.height) * scale)
        }
        let image = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: cfg)
        guard let png = NSBitmapImageRep(cgImage: image).representation(using: .png, properties: [:]) else {
            out["error"] = "couldn't encode the capture"
            return
        }
        try png.write(to: dir.appendingPathComponent("capture.png"))
        out["ok"] = true
        out["width"] = image.width
        out["height"] = image.height
    }
}
