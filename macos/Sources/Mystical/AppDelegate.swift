import AppKit
import MysticalCore

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate, NSMenuDelegate {
    private let bridge = Bridge()
    private let notifier = Notifier()
    private var dashboard: DashboardWindow!
    private var statusItem: NSStatusItem!
    private var busy = false

    func applicationDidFinishLaunching(_ note: Notification) {
        NSApp.mainMenu = MainMenu.build(target: self)
        dashboard = DashboardWindow(bridge: bridge, notifier: notifier)
        // Dock icon while the window is up; menu bar only while it's hidden.
        dashboard.onVisibilityChange = { visible in
            NSApp.setActivationPolicy(visible ? .regular : .accessory)
        }
        dashboard.onStart = { [weak self] in self?.lifecycle("start") }
        notifier.onClick = { [weak self] id in self?.dashboard.notificationClicked(id) }

        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        let image = NSImage(systemSymbolName: "sparkle", accessibilityDescription: "mystical")
        image?.isTemplate = true
        statusItem.button?.image = image
        statusItem.button?.imagePosition = .imageLeading
        let menu = NSMenu()
        menu.delegate = self
        statusItem.menu = menu

        Probe.install(window: dashboard, bridge: bridge, notifier: notifier)
        bridge.onChange = { [weak self] in self?.bridgeChanged() }
        bridge.start()
        // Launched at login by the window agent, or by hand: either way, show it.
        dashboard.show()
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ app: NSApplication) -> Bool { false }

    func applicationShouldHandleReopen(_ app: NSApplication, hasVisibleWindows: Bool) -> Bool {
        dashboard.show()
        return true
    }

    private func bridgeChanged() {
        dashboard.sync()
        let n = bridge.waiting.count
        statusItem.button?.title = n > 0 ? " \(n)" : ""
        statusItem.button?.toolTip = n > 0 ? "\(n) waiting on you" : "mystical//assistant"
        statusItem.button?.appearsDisabled = !bridge.up
    }

    // MARK: menu bar menu — rebuilt each time it opens, from the latest poll

    func menuNeedsUpdate(_ menu: NSMenu) {
        // Supervision can change under us (the SYSTEM tab, a terminal); re-read
        // it for the next open rather than block this one on a subprocess.
        if !busy { Task { await bridge.refreshStatus() } }
        menu.removeAllItems()
        menu.addItem(disabled(stateLine()))
        if !bridge.waiting.isEmpty {
            menu.addItem(.separator())
            menu.addItem(disabled("Waiting on you"))
            for w in bridge.waiting {
                let item = NSMenuItem(title: w.title, action: #selector(openWaiting(_:)), keyEquivalent: "")
                item.target = self
                item.representedObject = w.id
                item.toolTip = w.label
                item.indentationLevel = 1
                menu.addItem(item)
            }
        }
        menu.addItem(.separator())
        menu.addItem(item("Open Dashboard", #selector(showDashboard), "0"))
        menu.addItem(item("Open in Browser", #selector(openInBrowser), "", enabled: bridge.up))
        menu.addItem(.separator())
        let running = bridge.status?.running == true
        menu.addItem(item("Start Bridge", #selector(startBridge), "", enabled: !running && !busy))
        menu.addItem(item("Stop Bridge", #selector(stopBridge), "", enabled: running && !busy))
        menu.addItem(item("Restart Bridge", #selector(restartBridge), "", enabled: running && !busy))
        menu.addItem(item("Show Log", #selector(showLog), "", enabled: bridge.status?.log != nil))
        menu.addItem(.separator())
        menu.addItem(item("Quit Mystical", #selector(NSApplication.terminate(_:)), "q", target: NSApp))
    }

    private func stateLine() -> String {
        if busy { return "● working…" }
        guard let s = bridge.status else {
            return bridge.repoMissing ? "● checkout not found — rebuild: mystical app" : "● checking…"
        }
        if !s.running { return "○ bridge stopped" }
        if !bridge.up { return "◌ bridge starting…" }
        let sup = s.supervised.map { $0 == "hand-launched" ? " · not supervised" : " · \($0)" } ?? ""
        return "● bridge running\(sup)"
    }

    private func disabled(_ title: String) -> NSMenuItem {
        let i = NSMenuItem(title: title, action: nil, keyEquivalent: "")
        i.isEnabled = false
        return i
    }

    private func item(_ title: String, _ action: Selector, _ key: String,
                      enabled: Bool = true, target: AnyObject? = nil) -> NSMenuItem {
        let i = NSMenuItem(title: title, action: enabled ? action : nil, keyEquivalent: key)
        i.target = target ?? self
        return i
    }

    // MARK: actions

    @objc func showDashboard() { dashboard.show() }
    @objc func reloadDashboard() { dashboard.reload() }
    @objc func zoomIn() { dashboard.zoom(1.1) }
    @objc func zoomOut() { dashboard.zoom(1 / 1.1) }
    @objc func actualSize() { dashboard.zoom(nil) }

    @objc private func openWaiting(_ sender: NSMenuItem) {
        if let id = sender.representedObject as? String { dashboard.open(session: id) }
    }

    @objc private func openInBrowser() {
        if let url = bridge.status?.dashboardURL { NSWorkspace.shared.open(url) }
    }

    @objc private func showLog() {
        guard let log = bridge.status?.log else { return }
        NSWorkspace.shared.open([URL(fileURLWithPath: log)],
                                withApplicationAt: URL(fileURLWithPath: "/System/Applications/Utilities/Console.app"),
                                configuration: NSWorkspace.OpenConfiguration())
    }

    @objc private func startBridge() { lifecycle("start") }
    @objc private func stopBridge() { lifecycle("stop") }
    @objc private func restartBridge() { lifecycle("restart") }

    private func lifecycle(_ verb: String) {
        guard !busy else { return }
        busy = true
        Task {
            let failure = await bridge.lifecycle(verb)
            busy = false
            bridgeChanged()
            if let failure {
                let a = NSAlert()
                a.messageText = "mystical \(verb) failed"
                a.informativeText = String(failure.suffix(1500))
                a.runModal()
            }
        }
    }
}

/// The menu bar at the top of the screen. Built in code, and the Edit menu is
/// not decoration: without its responder-chain selectors, ⌘C/⌘V/⌘A/⌘Z do
/// nothing inside a WKWebView.
enum MainMenu {
    @MainActor
    static func build(target: AppDelegate) -> NSMenu {
        let main = NSMenu()
        func submenu(_ title: String, _ items: [NSMenuItem]) {
            let holder = NSMenuItem(title: title, action: nil, keyEquivalent: "")
            let m = NSMenu(title: title)
            items.forEach(m.addItem)
            holder.submenu = m
            main.addItem(holder)
        }
        func item(_ t: String, _ a: Selector?, _ k: String = "",
                  _ mods: NSEvent.ModifierFlags = .command, to: AnyObject? = nil) -> NSMenuItem {
            let i = NSMenuItem(title: t, action: a, keyEquivalent: k)
            i.keyEquivalentModifierMask = mods
            i.target = to
            return i
        }
        submenu("Mystical", [
            item("About Mystical", #selector(NSApplication.orderFrontStandardAboutPanel(_:)), to: NSApp),
            .separator(),
            item("Hide Mystical", #selector(NSApplication.hide(_:)), "h", to: NSApp),
            item("Hide Others", #selector(NSApplication.hideOtherApplications(_:)), "h", [.command, .option], to: NSApp),
            item("Show All", #selector(NSApplication.unhideAllApplications(_:)), to: NSApp),
            .separator(),
            item("Quit Mystical", #selector(NSApplication.terminate(_:)), "q", to: NSApp),
        ])
        submenu("Edit", [
            item("Undo", Selector(("undo:")), "z"),
            item("Redo", Selector(("redo:")), "z", [.command, .shift]),
            .separator(),
            item("Cut", #selector(NSText.cut(_:)), "x"),
            item("Copy", #selector(NSText.copy(_:)), "c"),
            item("Paste", #selector(NSText.paste(_:)), "v"),
            item("Paste and Match Style", #selector(NSTextView.pasteAsPlainText(_:)), "v", [.command, .option, .shift]),
            item("Delete", #selector(NSText.delete(_:))),
            item("Select All", #selector(NSText.selectAll(_:)), "a"),
        ])
        submenu("View", [
            item("Reload", #selector(AppDelegate.reloadDashboard), "r", to: target),
            .separator(),
            item("Actual Size", #selector(AppDelegate.actualSize), "0", to: target),
            item("Zoom In", #selector(AppDelegate.zoomIn), "=", to: target),
            item("Zoom Out", #selector(AppDelegate.zoomOut), "-", to: target),
            .separator(),
            item("Enter Full Screen", #selector(NSWindow.toggleFullScreen(_:)), "f", [.command, .control]),
        ])
        let window = [
            item("Dashboard", #selector(AppDelegate.showDashboard), "1", to: target),
            .separator(),
            item("Minimize", #selector(NSWindow.performMiniaturize(_:)), "m"),
            item("Zoom", #selector(NSWindow.performZoom(_:))),
            item("Close", #selector(NSWindow.performClose(_:)), "w"),
        ]
        submenu("Window", window)
        NSApp.windowsMenu = main.items.last?.submenu
        return main
    }
}
