import AppKit
import ApplicationServices
import MysticalCore
import ScreenCaptureKit

/// Computer use's hands and eyes (bridge/computer.py decides what's allowed).
///
/// Orders come only from the bridge: the app dials POST /local/computer/app
/// with the dashboard token and gets them back on that connection. Nothing
/// listens, so no other local process can give it input orders. (Capture.swift's
/// distributed notification stays for read-only screenshots.)
///
/// Every order names the chat's apps. `see`: shown in screenshots, everything
/// else blanked (ScreenCaptureKit includes only them). `full`: may be clicked
/// and typed into, and input is refused unless one of them is in front, checked
/// here at the moment of the event, where the bridge can't see.
///
/// While a chat drives: a teal edge and a pill on the main screen (Overlay), and
/// an event tap that turns Esc into Stop. Our own posted events carry a marker
/// in eventSourceUserData, so `key escape` from Claude doesn't stop itself.
/// Posting events and the tap need Accessibility; screenshots need Screen
/// Recording. Both are this app's, which is why the bridge can't do this itself.
@MainActor
final class ComputerUse {
    static let marker: Int64 = 0x4D59_5354    // "MYST"

    private let bridge: Bridge
    private var results: [[String: Any]] = []
    private var running = false
    private var askedAccessibility = false
    /// Set by Stop until the bridge confirms ("end", or a pull that isn't driving):
    /// an order already here or a batch half done goes no further.
    private var halted = false
    private(set) var driving = false
    private(set) var title = ""
    /// The driving chat, for the menu bar's Open the chat.
    private(set) var session = ""
    var onChange: (() -> Void)?

    // The last full screenshot: what Claude's coordinates refer to.
    private var shot: (image: (Int, Int), origin: (Double, Double), points: (Double, Double))?
    private let overlay = Overlay()
    private var tap: CFMachPort?
    private lazy var source: CGEventSource? = {
        let s = CGEventSource(stateID: .hidSystemState)
        s?.userData = ComputerUse.marker
        return s
    }()

    init(bridge: Bridge) { self.bridge = bridge }

    func start() {
        guard !running else { return }
        running = true
        Task { await loop() }
    }

    /// The menu bar's Stop, and Esc: told to the bridge at once, not with the next pull.
    func stop(_ by: String) {
        halted = true
        end()
        if let req = request(["stop": by], timeout: 5) { URLSession.shared.dataTask(with: req).resume() }
    }

    /// POST /local/computer/app with the dashboard token. Nil until a status names the bridge.
    private func request(_ body: [String: Any], timeout: TimeInterval) -> URLRequest? {
        guard let base = bridge.status?.origin, let token = ComputerCore.token(from: bridge.status?.dashboardURL) else { return nil }
        var req = URLRequest(url: base.appendingPathComponent("local/computer/app"))
        req.httpMethod = "POST"
        req.timeoutInterval = timeout
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue(token, forHTTPHeaderField: "X-Dash-Token")
        req.httpBody = try? JSONSerialization.data(withJSONObject: body)
        return req
    }

    // MARK: the line to the bridge

    private func loop() async {
        while running {
            guard let req = request(["results": results, "perms": perms()], timeout: 35) else {
                try? await Task.sleep(for: .seconds(5)); continue
            }
            results = []
            guard let (data, resp) = try? await URLSession.shared.data(for: req),
                  (resp as? HTTPURLResponse)?.statusCode == 200,
                  let o = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
                // Down, or a bridge too old for the route: try again later.
                try? await Task.sleep(for: .seconds(10)); continue
            }
            for order in o["orders"] as? [[String: Any]] ?? [] {
                if let r = await run(order) { results.append(r) }
            }
            if (o["driving"] as? Bool) == false {
                halted = false
                if driving { end() }
            }
        }
    }

    private func perms() -> [String: Any] {
        ["screen": CGPreflightScreenCaptureAccess(), "accessibility": AXIsProcessTrusted(), "signed": signer()]
    }

    /// The signing certificate's name, or "ad-hoc": TCC keeps the permissions
    /// across rebuilds only for a real identity (build.sh's "Mystical Local").
    private func signer() -> String {
        var code: SecCode?
        var stat: SecStaticCode?
        var info: CFDictionary?
        guard SecCodeCopySelf([], &code) == errSecSuccess, let code,
              SecCodeCopyStaticCode(code, [], &stat) == errSecSuccess, let stat,
              SecCodeCopySigningInformation(stat, SecCSFlags(rawValue: kSecCSSigningInformation), &info) == errSecSuccess,
              let certs = (info as? [String: Any])?[kSecCodeInfoCertificates as String] as? [SecCertificate],
              let leaf = certs.first else { return "ad-hoc" }
        return (SecCertificateCopySubjectSummary(leaf) as String?) ?? "signed"
    }

    // MARK: orders

    private func run(_ order: [String: Any]) async -> [String: Any]? {
        let action = order["action"] as? String ?? ""
        if action == "end" { halted = false; end(); return nil }
        guard let id = order["id"] as? String else { return nil }
        if halted { return ["id": id, "ok": false, "text": "The user stopped computer use."] }
        let args = order["args"] as? [String: Any] ?? [:]
        let full = order["full"] as? [String] ?? []
        let see = order["see"] as? [String] ?? []
        begin(order["title"] as? String ?? "", apps: see, session: order["sid"] as? String ?? "")
        var out: [String: Any] = ["id": id]
        do {
            let r = try await act(action, args, full: full, see: see)
            out["ok"] = true
            out["text"] = r.text
            if let img = r.image { out["images"] = [img] }
        } catch let e as Refusal {
            out["ok"] = false
            out["text"] = e.text
        } catch {
            out["ok"] = false
            out["text"] = "\(error)"
        }
        return out
    }

    struct Refusal: Error { let text: String }
    typealias Result = (text: String, image: String?)

    private func act(_ action: String, _ a: [String: Any], full: [String], see: [String]) async throws -> Result {
        if action == "computer_batch" {
            var texts: [String] = []
            var last: String?
            for (i, step) in (a["actions"] as? [[String: Any]] ?? []).enumerated() {
                let name = step["action"] as? String ?? ""
                // A beat between steps: Stop gets heard, and the front app catches up
                // with a click that just changed it.
                if i > 0 { try await Task.sleep(for: .milliseconds(60)) }
                do {
                    try checkHalt()
                    let r = name == "wait" ? try await wait(step) : try await act(name, step, full: full, see: see)
                    if !r.text.isEmpty { texts.append("\(i + 1). \(name): \(r.text)") }
                    if let img = r.image { last = img }
                } catch let e as Refusal {
                    throw Refusal(text: (texts + ["\(i + 1). \(name) failed: \(e.text) The rest didn't run."]).joined(separator: "\n"))
                }
            }
            return (texts.joined(separator: "\n"), last)
        }
        switch action {
        case "screenshot": return try await screenshot(see: see)
        case "zoom": return try await zoom(a, see: see)
        case "cursor_position":
            let p = cursor()
            guard let s = shot else { return ("\(Int(p.x)), \(Int(p.y)) (points; no screenshot yet)", nil) }
            let i = ComputerCore.toImage(x: p.x, y: p.y, image: s.image, origin: s.origin, points: s.points)
            return ("\(i.0), \(i.1)", nil)
        case "read_clipboard": return (NSPasteboard.general.string(forType: .string) ?? "", nil)
        case "write_clipboard":
            NSPasteboard.general.clearContents()
            NSPasteboard.general.setString(a["text"] as? String ?? "", forType: .string)
            return ("Copied.", nil)
        case "open_application": return try await open(a["app"] as? String ?? "", see: see)
        default: break
        }
        let pointer: CGPoint? = switch action {
        case "left_click", "double_click", "triple_click", "right_click", "middle_click", "scroll":
            try point(a["coordinate"])
        case "left_click_drag": a["start_coordinate"] != nil ? try point(a["start_coordinate"]) : cursor()
        case "left_mouse_down", "left_mouse_up": cursor()
        default: nil
        }
        try ready(full: full, at: pointer, keys: ["type", "key", "hold_key"].contains(action))
        if action == "left_click_drag" { try ready(full: full, at: try point(a["coordinate"]), keys: false) }
        switch action {
        case "left_click", "double_click", "triple_click", "right_click", "middle_click":
            let p = try point(a["coordinate"])
            let mods = ComputerCore.chord(a["text"] as? String ?? "")?.flags ?? 0
            click(action, at: p, flags: mods)
            overlay.ring(at: p)
            return ("", nil)
        case "mouse_move":
            move(to: try point(a["coordinate"]))
            return ("", nil)
        case "left_click_drag":
            let end = try point(a["coordinate"])
            let start = a["start_coordinate"] != nil ? try point(a["start_coordinate"]) : cursor()
            try await drag(from: start, to: end)
            return ("", nil)
        case "scroll":
            let p = try point(a["coordinate"])
            move(to: p)
            let n = Int32(min(max(a["scroll_amount"] as? Int ?? 3, 0), 100))
            let dir = a["scroll_direction"] as? String ?? "down"
            let (dy, dx): (Int32, Int32) = dir == "up" ? (n, 0) : dir == "down" ? (-n, 0) : dir == "left" ? (0, n) : (0, -n)
            CGEvent(scrollWheelEvent2Source: source, units: .line, wheelCount: 2, wheel1: dy, wheel2: dx, wheel3: 0)?
                .post(tap: .cghidEventTap)
            return ("", nil)
        case "type":
            try await type(a["text"] as? String ?? "")
            return ("", nil)
        case "key":
            guard let c = ComputerCore.chord(a["text"] as? String ?? "") else {
                throw Refusal(text: "\(a["text"] ?? "") isn't a key I know.")
            }
            for _ in 0..<min(max(a["repeat"] as? Int ?? 1, 1), 100) { press(c) }
            return ("", nil)
        case "hold_key":
            guard let c = ComputerCore.chord(a["text"] as? String ?? "") else {
                throw Refusal(text: "\(a["text"] ?? "") isn't a key I know.")
            }
            press(c, down: true)
            try await Task.sleep(for: .seconds(min(max(a["duration"] as? Double ?? 0.5, 0), 100)))
            press(c, down: false)
            return ("", nil)
        case "left_mouse_down", "left_mouse_up":
            let down = action == "left_mouse_down"
            CGEvent(mouseEventSource: source, mouseType: down ? .leftMouseDown : .leftMouseUp,
                    mouseCursorPosition: cursor(), mouseButton: .left)?.post(tap: .cghidEventTap)
            return ("", nil)
        default:
            throw Refusal(text: "Mystical.app doesn't know \(action). Rebuild the app from its menu.")
        }
    }

    private func wait(_ a: [String: Any]) async throws -> Result {
        try await Task.sleep(for: .seconds(min(max(a["duration"] as? Double ?? 1, 0), 100)))
        return ("", nil)
    }

    private func checkHalt() throws {
        if halted { throw Refusal(text: "The user stopped computer use.") }
    }

    /// Input needs Accessibility and one of the chat's FULL apps in front. A pointer
    /// action also needs one of them on top under the point: a click lands on
    /// whatever window is there, which can be a LOOK app or one hidden from the
    /// screenshot. Keys go to the top window, so that has to be a FULL app's too.
    private func ready(full: [String], at p: CGPoint?, keys: Bool) throws {
        try checkHalt()
        guard AXIsProcessTrusted() else {
            if !askedAccessibility {
                askedAccessibility = true
                let opt = kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String
                _ = AXIsProcessTrustedWithOptions([opt: true] as CFDictionary)
            }
            throw Refusal(text: "Accessibility isn't allowed for Mystical, so it can't click or type. Tell the "
                + "user: System Settings › Privacy & Security › Accessibility, turn Mystical on.")
        }
        let front = NSWorkspace.shared.frontmostApplication
        guard ComputerCore.granted(full, name: front?.localizedName, bundle: front?.bundleIdentifier) else {
            let name = front?.localizedName ?? "Another app"
            throw Refusal(text: "\(name) is in front, and it isn't one of this chat's apps you may click or "
                + "type into, so nothing happened. Bring a granted app to the front (open_application), or "
                + "ask for \(name) with request_access.")
        }
        if let p {
            let o = owner(at: p)
            // The menu bar's menus are the Window Server's, and belong to the front app checked above.
            guard let o, o.name == "Window Server" || ComputerCore.granted(full, name: o.name, bundle: o.bundle) else {
                throw Refusal(text: "Under that point is \(o?.name ?? "the desktop"), not one of this chat's apps you "
                    + "may click, so nothing happened.")
            }
        } else if keys, let o = owner(at: nil), !ComputerCore.granted(full, name: o.name, bundle: o.bundle) {
            throw Refusal(text: "\(o.name ?? "Another app")'s window is on top, so the keys would go there. Nothing "
                + "was typed.")
        }
    }

    /// Whose window is on top at `p` (global top-left points), or the topmost
    /// normal window when `p` is nil. Ours (the overlay) and invisible ones skipped.
    private func owner(at p: CGPoint?) -> (name: String?, bundle: String?)? {
        guard let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID)
                as? [[String: Any]] else { return nil }
        let me = ProcessInfo.processInfo.processIdentifier
        for w in list {
            guard let pid = w[kCGWindowOwnerPID as String] as? Int32, pid != me,
                  (w[kCGWindowAlpha as String] as? Double ?? 1) > 0,
                  let layer = w[kCGWindowLayer as String] as? Int,
                  let b = w[kCGWindowBounds as String] as? NSDictionary,
                  let r = CGRect(dictionaryRepresentation: b) else { continue }
            if let p { if !r.contains(p) { continue } } else if layer != 0 { continue }
            let app = NSRunningApplication(processIdentifier: pid)
            return (app?.localizedName ?? w[kCGWindowOwnerName as String] as? String, app?.bundleIdentifier)
        }
        return nil
    }

    // MARK: input

    private func point(_ v: Any?) throws -> CGPoint {
        guard let xy = v as? [Any], xy.count == 2,
              let x = (xy[0] as? NSNumber)?.doubleValue, let y = (xy[1] as? NSNumber)?.doubleValue else {
            throw Refusal(text: "coordinate must be [x, y].")
        }
        guard let s = shot else { throw Refusal(text: "Take a screenshot first: coordinates refer to it.") }
        let p = ComputerCore.toScreen(x: x, y: y, image: s.image, origin: s.origin, points: s.points)
        return CGPoint(x: p.0, y: p.1)
    }

    /// The pointer in global, top-left-origin points (CGEvent's space).
    private func cursor() -> CGPoint {
        CGEvent(source: nil)?.location ?? .zero
    }

    private func move(to p: CGPoint) {
        CGEvent(mouseEventSource: source, mouseType: .mouseMoved, mouseCursorPosition: p, mouseButton: .left)?
            .post(tap: .cghidEventTap)
    }

    private func click(_ action: String, at p: CGPoint, flags: UInt64) {
        let (down, up, button): (CGEventType, CGEventType, CGMouseButton) =
            action == "right_click" ? (.rightMouseDown, .rightMouseUp, .right)
            : action == "middle_click" ? (.otherMouseDown, .otherMouseUp, .center)
            : (.leftMouseDown, .leftMouseUp, .left)
        let times = action == "double_click" ? 2 : action == "triple_click" ? 3 : 1
        move(to: p)
        for n in 1...times {
            for type in [down, up] {
                let e = CGEvent(mouseEventSource: source, mouseType: type, mouseCursorPosition: p, mouseButton: button)
                e?.setIntegerValueField(.mouseEventClickState, value: Int64(n))
                if flags != 0 { e?.flags = CGEventFlags(rawValue: flags) }
                e?.post(tap: .cghidEventTap)
            }
        }
    }

    private func drag(from a: CGPoint, to b: CGPoint) async throws {
        move(to: a)
        CGEvent(mouseEventSource: source, mouseType: .leftMouseDown, mouseCursorPosition: a, mouseButton: .left)?
            .post(tap: .cghidEventTap)
        for i in 1...12 {
            if halted { break }
            let t = Double(i) / 12
            let p = CGPoint(x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t)
            CGEvent(mouseEventSource: source, mouseType: .leftMouseDragged, mouseCursorPosition: p, mouseButton: .left)?
                .post(tap: .cghidEventTap)
            try await Task.sleep(for: .milliseconds(12))
        }
        CGEvent(mouseEventSource: source, mouseType: .leftMouseUp, mouseCursorPosition: b, mouseButton: .left)?
            .post(tap: .cghidEventTap)
    }

    private func press(_ c: ComputerCore.Chord, down: Bool? = nil) {
        let flags = CGEventFlags(rawValue: c.flags)
        let codes = c.key.map { [$0] } ?? c.modifierKeys
        for d in down.map({ [$0] }) ?? [true, false] {
            for code in codes {
                let e = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: d)
                e?.flags = flags
                e?.post(tap: .cghidEventTap)
            }
        }
    }

    private func type(_ text: String) async throws {
        for run in ComputerCore.typingRuns(text) {
            try checkHalt()
            if run == "\n" { press(ComputerCore.chord("return")!); continue }
            let units = Array(run.utf16)
            for d in [true, false] {
                let e = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: d)
                e?.keyboardSetUnicodeString(stringLength: units.count, unicodeString: units)
                e?.post(tap: .cghidEventTap)
            }
            try await Task.sleep(for: .milliseconds(8))
        }
    }

    private func open(_ name: String, see: [String]) async throws -> Result {
        guard ComputerCore.granted(see, name: name, bundle: name) else {
            throw Refusal(text: "\(name) isn't one of this chat's apps.")
        }
        let ws = NSWorkspace.shared
        let url = ws.urlForApplication(withBundleIdentifier: name)
            ?? ["/Applications", "/System/Applications", "/System/Applications/Utilities",
                NSHomeDirectory() + "/Applications"]
                .map { URL(fileURLWithPath: "\($0)/\(name).app") }
                .first { FileManager.default.fileExists(atPath: $0.path) }
        guard let url else { throw Refusal(text: "No app called \(name) is installed.") }
        let cfg = NSWorkspace.OpenConfiguration()
        cfg.activates = true
        _ = try await ws.openApplication(at: url, configuration: cfg)
        try await Task.sleep(for: .milliseconds(600))
        return ("Opened \(name).", nil)
    }

    // MARK: eyes

    private func screenshot(see: [String]) async throws -> Result {
        let (filter, display) = try await filter(see: see)
        let (w, h) = ComputerCore.shotSize(width: Double(display.width) * scale, height: Double(display.height) * scale)
        let cfg = SCStreamConfiguration()
        cfg.width = w
        cfg.height = h
        cfg.showsCursor = true
        let img = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: cfg)
        let b = CGDisplayBounds(display.displayID)
        shot = ((img.width, img.height), (b.origin.x, b.origin.y), (b.width, b.height))
        return ("Screenshot \(img.width)x\(img.height). Showing: \(see.joined(separator: ", ")); "
                + "other apps are blanked.", jpeg(img))
    }

    private func zoom(_ a: [String: Any], see: [String]) async throws -> Result {
        guard let s = shot else { throw Refusal(text: "Take a screenshot first.") }
        guard let r = a["region"] as? [Any], r.count == 4 else { throw Refusal(text: "region must be [x0, y0, x1, y1].") }
        let v = r.compactMap { ($0 as? NSNumber)?.doubleValue }
        guard v.count == 4, v[2] > v[0], v[3] > v[1] else { throw Refusal(text: "region must be [x0, y0, x1, y1].") }
        let a0 = ComputerCore.toScreen(x: v[0], y: v[1], image: s.image, origin: (0, 0), points: s.points)
        let a1 = ComputerCore.toScreen(x: v[2], y: v[3], image: s.image, origin: (0, 0), points: s.points)
        let rect = CGRect(x: a0.0, y: a0.1, width: a1.0 - a0.0, height: a1.1 - a0.1)
        let (filter, _) = try await filter(see: see)
        let (w, h) = ComputerCore.shotSize(width: rect.width * scale, height: rect.height * scale)
        let cfg = SCStreamConfiguration()
        cfg.sourceRect = rect
        cfg.width = w
        cfg.height = h
        let img = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: cfg)
        return ("Zoomed \(Int(rect.width))x\(Int(rect.height)) points to \(img.width)x\(img.height). "
                + "Coordinates still refer to the full screenshot.", jpeg(img))
    }

    /// The primary display's scale (screenshots are of CGMainDisplayID, i.e. NSScreen.screens[0]).
    private var scale: Double { Double(NSScreen.screens.first?.backingScaleFactor ?? 2) }

    /// The main display with only the chat's apps on it, and never our overlay.
    /// shortcut: the primary display only (no switch_display); add it when a task needs a second screen.
    private func filter(see: [String]) async throws -> (SCContentFilter, SCDisplay) {
        guard CGPreflightScreenCaptureAccess() else {
            CGRequestScreenCaptureAccess()
            throw Refusal(text: "Screen Recording isn't allowed for Mystical. Tell the user: System Settings › "
                + "Privacy & Security › Screen Recording, turn Mystical on, then quit and reopen it.")
        }
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
        guard let display = content.displays.first(where: { $0.displayID == CGMainDisplayID() }) ?? content.displays.first
        else { throw Refusal(text: "No display to capture.") }
        let apps = content.applications.filter {
            ComputerCore.granted(see, name: $0.applicationName, bundle: $0.bundleIdentifier)
        }
        let mine = Set(overlay.windowNumbers)
        let hidden = content.windows.filter { mine.contains(Int($0.windowID)) }
        return (SCContentFilter(display: display, including: apps, exceptingWindows: hidden), display)
    }

    private func jpeg(_ img: CGImage) -> String? {
        NSBitmapImageRep(cgImage: img).representation(using: .jpeg, properties: [.compressionFactor: 0.75])?
            .base64EncodedString()
    }

    // MARK: driving on / off

    private func begin(_ title: String, apps: [String], session: String) {
        guard !driving || title != self.title else { return }
        driving = true
        self.title = title
        self.session = session
        overlay.show(title: title, apps: apps)
        armEsc()
        onChange?()
    }

    private func end() {
        guard driving else { return }
        driving = false
        shot = nil
        overlay.hide()
        disarmEsc()
        onChange?()
    }

    private func armEsc() {
        guard tap == nil, AXIsProcessTrusted() else { return }
        let me = Unmanaged.passUnretained(self).toOpaque()
        tap = CGEvent.tapCreate(tap: .cgSessionEventTap, place: .headInsertEventTap, options: .defaultTap,
                                eventsOfInterest: CGEventMask(1 << CGEventType.keyDown.rawValue),
                                callback: { _, type, event, info in
            if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
                if let info {
                    let cu = Unmanaged<ComputerUse>.fromOpaque(info).takeUnretainedValue()
                    MainActor.assumeIsolated { if let t = cu.tap { CGEvent.tapEnable(tap: t, enable: true) } }
                }
                return Unmanaged.passUnretained(event)
            }
            guard type == .keyDown, event.getIntegerValueField(.keyboardEventKeycode) == 53,
                  event.getIntegerValueField(.eventSourceUserData) != ComputerUse.marker, let info else {
                return Unmanaged.passUnretained(event)
            }
            let cu = Unmanaged<ComputerUse>.fromOpaque(info).takeUnretainedValue()
            MainActor.assumeIsolated { cu.stop("esc") }
            return nil    // swallowed: Esc stops the drive and does nothing else
        }, userInfo: me)
        guard let tap else { return }
        CFRunLoopAddSource(CFRunLoopGetMain(), CFMachPortCreateRunLoopSource(nil, tap, 0), .commonModes)
        CGEvent.tapEnable(tap: tap, enable: true)
    }

    private func disarmEsc() {
        guard let t = tap else { return }
        CGEvent.tapEnable(tap: t, enable: false)
        CFMachPortInvalidate(t)
        tap = nil
    }
}

/// The teal edge, the pill and the click ring, over the main screen. It never
/// takes a click (ignoresMouseEvents) and is left out of screenshots.
@MainActor
final class Overlay {
    private var panel: NSPanel?
    private var pill: NSTextField?

    var windowNumbers: [Int] { panel.map { [$0.windowNumber] } ?? [] }

    func show(title: String, apps: [String]) {
        guard let screen = NSScreen.screens.first else { return }
        let p = panel ?? make(screen)
        panel = p
        p.setFrame(screen.frame, display: true)
        let parts = ["MYSTICAL IS DRIVING", String(title.prefix(40)), apps.prefix(3).joined(separator: ", ")]
        pill?.stringValue = parts.filter { !$0.isEmpty }.joined(separator: "  ·  ") + "   ESC STOPS"
        layoutPill(in: p)
        p.orderFrontRegardless()
    }

    func hide() { panel?.orderOut(nil) }

    func ring(at p: CGPoint) {
        guard let panel, let layer = panel.contentView?.layer, let screen = NSScreen.screens.first else { return }
        // CGEvent points are top-left; the layer's are bottom-left.
        let y = screen.frame.height - p.y
        let r = CAShapeLayer()
        r.path = CGPath(ellipseIn: CGRect(x: -14, y: -14, width: 28, height: 28), transform: nil)
        r.position = CGPoint(x: p.x - screen.frame.minX, y: y)
        r.fillColor = nil
        r.strokeColor = Overlay.teal.cgColor
        r.lineWidth = 2.5
        layer.addSublayer(r)
        let a = CABasicAnimation(keyPath: "transform.scale")
        a.fromValue = 0.6
        a.toValue = 1.6
        let f = CABasicAnimation(keyPath: "opacity")
        f.fromValue = 1
        f.toValue = 0
        let g = CAAnimationGroup()
        g.animations = [a, f]
        g.duration = 0.6
        r.opacity = 0
        r.add(g, forKey: nil)
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.7) { r.removeFromSuperlayer() }
    }

    static let teal = NSColor(srgbRed: 0x7f / 255, green: 0xe9 / 255, blue: 0xd8 / 255, alpha: 1)

    private func make(_ screen: NSScreen) -> NSPanel {
        let p = NSPanel(contentRect: screen.frame, styleMask: [.borderless, .nonactivatingPanel],
                        backing: .buffered, defer: false)
        p.level = .screenSaver
        p.ignoresMouseEvents = true
        p.isOpaque = false
        p.backgroundColor = .clear
        p.hasShadow = false
        p.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]
        let v = NSView(frame: NSRect(origin: .zero, size: screen.frame.size))
        v.wantsLayer = true
        v.layer?.borderColor = Overlay.teal.cgColor
        v.layer?.borderWidth = 4
        v.layer?.shadowColor = Overlay.teal.cgColor
        v.layer?.shadowOpacity = 0.7
        v.layer?.shadowRadius = 12
        v.layer?.shadowOffset = .zero
        v.autoresizingMask = [.width, .height]
        p.contentView = v
        let label = NSTextField(labelWithString: "")
        label.font = NSFont.monospacedSystemFont(ofSize: 12, weight: .bold)
        label.textColor = Overlay.teal
        label.wantsLayer = true
        label.drawsBackground = true
        label.backgroundColor = NSColor(srgbRed: 0.024, green: 0.04, blue: 0.04, alpha: 0.92)
        label.layer?.borderColor = Overlay.teal.cgColor
        label.layer?.borderWidth = 1
        label.alignment = .center
        v.addSubview(label)
        pill = label
        return p
    }

    private func layoutPill(in p: NSPanel) {
        guard let pill, let v = p.contentView else { return }
        pill.sizeToFit()
        let w = pill.frame.width + 28, h: CGFloat = 28
        // Below the menu bar, centred.
        pill.frame = NSRect(x: (v.bounds.width - w) / 2, y: v.bounds.height - 40 - h, width: w, height: h)
    }
}
