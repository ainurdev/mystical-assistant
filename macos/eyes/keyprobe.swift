// swiftc macos/eyes/keyprobe.swift -o /tmp/keyprobe && /tmp/keyprobe <url> <waitMs> <key>...
//   keys like ctrl+tab cmd+. esc cmd+shift+p; PRELOAD=<js> runs before the page's scripts, as in wkshot.
// What a key press does in Mystical.app's kind of window, without the user's screen or focus: a
// WKWebView in a window that is never shown (key and visible are faked), each key sent as a real
// NSEvent the way NSApp would. Prints, per key, whether the page got it and called preventDefault,
// and what AppKit got back: WebKit hands a key the page left alone to the window, which is how a
// loose Esc or ⌘. ends up in cancelOperation: and leaves full screen. The window's own handlers
// are recorded and swallowed, and nothing beeps. There's no main menu, so the app's menu keys
// (Window ▸ Dashboard ⌘1) can't take a key here.
import AppKit
import WebKit

final class App: NSApplication {
    weak var target: NSWindow?
    // Keys go to the key window and this process never has one (it must not take focus), so they go
    // to the hidden window: ⌘ keys to its key equivalents first, as NSApp does before the menu.
    override func sendEvent(_ event: NSEvent) {
        guard event.type == .keyDown, let t = target else { return super.sendEvent(event) }
        if event.modifierFlags.contains(.command), t.performKeyEquivalent(with: event) { return }
        t.sendEvent(event)
    }
}
let app = App.shared as! App
app.setActivationPolicy(.prohibited)   // no Dock icon, never activates
app.finishLaunching()

final class Win: NSWindow {
    var got: [String] = []
    override var isVisible: Bool { true }
    override var isKeyWindow: Bool { true }
    override var canBecomeKey: Bool { true }
    override func keyDown(with e: NSEvent) { got.append("keyDown"); super.keyDown(with: e) }
    override func cancelOperation(_ sender: Any?) { got.append("cancelOperation") }
    override func selectNextKeyView(_ sender: Any?) { got.append("selectNextKeyView") }
    override func selectPreviousKeyView(_ sender: Any?) { got.append("selectPreviousKeyView") }
    override func noResponder(for eventSelector: Selector) { got.append("unhandled") }   // AppKit would beep
}
func spin(_ s: Double) { RunLoop.main.run(until: Date().addingTimeInterval(s)) }
func js(_ web: WKWebView, _ src: String) -> Any? {
    var r: Any?, done = false
    web.evaluateJavaScript(src) { v, _ in r = v; done = true }
    while !done { spin(0.05) }
    return r
}

let a = CommandLine.arguments
guard a.count > 3, let url = URL(string: a[1]), let wait = Double(a[2]) else {
    print("usage: keyprobe <url> <waitMs> <key>...   e.g. ctrl+tab cmd+. esc"); exit(2)
}
// Before the page's own scripts, so this capture listener on window hears every key first.
let spy = """
window.__keys = [];
addEventListener("keydown", (e) => {
  const r = { key: e.key, mods: [e.metaKey && "cmd", e.ctrlKey && "ctrl", e.altKey && "alt", e.shiftKey && "shift"].filter(Boolean).join("+") };
  __keys.push(r); setTimeout(() => { r.prevented = e.defaultPrevented; });
}, true);
"""
let cfg = WKWebViewConfiguration()
cfg.websiteDataStore = .nonPersistent()   // never the user's own WebKit data
for src in [ProcessInfo.processInfo.environment["PRELOAD"] ?? "", spy] where !src.isEmpty {
    cfg.userContentController.addUserScript(WKUserScript(source: src, injectionTime: .atDocumentStart, forMainFrameOnly: true))
}
let frame = NSRect(x: 0, y: 0, width: 1425, height: 743)
let web = WKWebView(frame: frame, configuration: cfg)
let win = Win(contentRect: frame, styleMask: [.titled, .resizable], backing: .buffered, defer: false)
win.contentView = web
app.target = win
web.load(URLRequest(url: url))
spin(wait / 1000)
win.makeFirstResponder(web)
spin(0.3)

// keyCode and the character it types, US layout.
let named: [String: (UInt16, String)] = [
    "tab": (48, "\t"), "esc": (53, "\u{1b}"), "enter": (36, "\r"), "space": (49, " "), "up": (126, "\u{F700}"), "down": (125, "\u{F701}"),
    "left": (123, "\u{F702}"), "right": (124, "\u{F703}"), ".": (47, "."), "/": (44, "/"), ",": (43, ","), "`": (50, "`"),
    "1": (18, "1"), "2": (19, "2"), "3": (20, "3"), "4": (21, "4"), "5": (23, "5"), "6": (22, "6"), "7": (26, "7"), "8": (28, "8"), "9": (25, "9"), "0": (29, "0"),
    "a": (0, "a"), "s": (1, "s"), "d": (2, "d"), "f": (3, "f"), "h": (4, "h"), "g": (5, "g"), "z": (6, "z"), "x": (7, "x"), "c": (8, "c"), "v": (9, "v"),
    "b": (11, "b"), "q": (12, "q"), "w": (13, "w"), "e": (14, "e"), "r": (15, "r"), "y": (16, "y"), "t": (17, "t"), "o": (31, "o"), "u": (32, "u"),
    "i": (34, "i"), "p": (35, "p"), "l": (37, "l"), "j": (38, "j"), "k": (40, "k"), "n": (45, "n"), "m": (46, "m"),
]
let mods: [String: NSEvent.ModifierFlags] = ["cmd": .command, "ctrl": .control, "alt": .option, "opt": .option, "shift": .shift]
for spec in a[3...] {
    var parts = spec.lowercased().split(separator: "+").map(String.init)
    guard let last = parts.popLast(), let (code, ch) = named[last], parts.allSatisfy({ mods[$0] != nil }) else {
        print("\(spec)\tunknown key"); continue
    }
    let flags = parts.reduce(into: NSEvent.ModifierFlags()) { $0.formUnion(mods[$1]!) }
    _ = js(web, "__keys.length = 0")
    win.got = []
    app.sendEvent(NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: flags, timestamp: ProcessInfo.processInfo.systemUptime,
                                   windowNumber: win.windowNumber, context: nil, characters: ch, charactersIgnoringModifiers: ch,
                                   isARepeat: false, keyCode: code)!)
    spin(0.6)
    let page = (js(web, "JSON.stringify(__keys)") as? String) ?? "?"
    print("\(spec)\tpage: \(page == "[]" ? "never got it" : page)\tAppKit: \(win.got.isEmpty ? "nothing" : win.got.joined(separator: ", "))")
}
