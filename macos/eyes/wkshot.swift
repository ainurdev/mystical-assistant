// swift macos/eyes/wkshot.swift <url> <out.png> <w> <h> <waitMs> [js] [wait2Ms]
// Screenshot through real WebKit, the engine Mystical.app's WKWebView runs.
// cdp.mjs is Chrome, so it can't see WebKit-only bugs (stacking, fill-mode).
// js is a function body run by callAsyncJavaScript: `await` works, `return x` is printed.
import AppKit
import WebKit

let a = CommandLine.arguments
let url = URL(string: a[1])!, out = a[2]
let w = Double(a[3])!, h = Double(a[4])!, wait1 = Double(a[5])! / 1000
let js = a.count > 6 ? a[6] : "", wait2 = a.count > 7 ? Double(a[7])! / 1000 : 0.5

let app = NSApplication.shared
app.setActivationPolicy(.prohibited)
let win = NSWindow(contentRect: NSRect(x: -20000, y: -20000, width: w, height: h),
                   styleMask: [.borderless], backing: .buffered, defer: false)
// PRELOAD=<js> runs at document start (localStorage seeding, like cdp.mjs).
// A driven page says so, as headless Chrome does: the dashboard starts no reports for one (lib/reports.ts).
let driven = "Object.defineProperty(Navigator.prototype, 'webdriver', { get: () => true })"
let cfg = WKWebViewConfiguration()
for src in [driven, ProcessInfo.processInfo.environment["PRELOAD"] ?? ""] where !src.isEmpty {
    cfg.userContentController.addUserScript(WKUserScript(source: src, injectionTime: .atDocumentStart, forMainFrameOnly: true))
}
let web = WKWebView(frame: NSRect(x: 0, y: 0, width: w, height: h), configuration: cfg)
win.contentView = web
// Off screen, so WebKit would call the page hidden and freeze its animation clock;
// the SPI switch makes it ignore occlusion (document.visibilityState stays "visible").
typealias SetBool = @convention(c) (AnyObject, Selector, Bool) -> Void
let occl = NSSelectorFromString("_setWindowOcclusionDetectionEnabled:")
if web.responds(to: occl) { unsafeBitCast(web.method(for: occl), to: SetBool.self)(web, occl, false) }
win.orderFrontRegardless()
web.load(URLRequest(url: url))

Task { @MainActor in
    try await Task.sleep(nanoseconds: UInt64(wait1 * 1e9))
    if !js.isEmpty {
        do { print("js ->", try await web.callAsyncJavaScript(js, contentWorld: .page) ?? "nil") }
        catch { print("js error:", error) }
    }
    try await Task.sleep(nanoseconds: UInt64(wait2 * 1e9))
    let img = try await web.takeSnapshot(configuration: nil)
    let rep = NSBitmapImageRep(data: img.tiffRepresentation!)!
    try rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: out))
    print(out)
    exit(0)
}
app.run()
