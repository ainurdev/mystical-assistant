import AppKit
import MysticalCore
import WebKit

/// The one window: the dashboard in a WKWebView, plus the host duties a bare web
/// view silently drops — file pickers, confirm()/prompt(), downloads, links
/// that belong in a browser. Closing it only hides it, so the page (and with it
/// the notification rules) keeps running.
@MainActor
final class DashboardWindow: NSWindowController, NSWindowDelegate, WKNavigationDelegate,
                             WKUIDelegate, WKDownloadDelegate {
    let webView: WKWebView
    private let placeholder = Placeholder()
    private let bridge: Bridge
    private let notifier: Notifier
    /// The dashboard URL last loaded, and whether that load is showing.
    private var loaded: URL?
    private var showingPage = false
    var onVisibilityChange: ((Bool) -> Void)?
    var onStart: (() -> Void)?

    init(bridge: Bridge, notifier: Notifier) {
        self.bridge = bridge
        self.notifier = notifier
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .default()           // settings, drafts, sounds persist
        config.preferences.inactiveSchedulingPolicy = .none   // keep polling while hidden
        config.mediaTypesRequiringUserActionForPlayback = []  // chimes need no click
        let version = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "1"
        config.applicationNameForUserAgent = "MysticalMac/\(version)"
        let ucc = config.userContentController
        ucc.addScriptMessageHandler(notifier, contentWorld: .page, name: NotificationShim.handlerName)
        ucc.addUserScript(WKUserScript(source: NotificationShim.source(permission: notifier.permission),
                                       injectionTime: .atDocumentStart, forMainFrameOnly: true))
        webView = WKWebView(frame: .zero, configuration: config)
        webView.isInspectable = true
        webView.allowsBackForwardNavigationGestures = false
        let zoom = UserDefaults.standard.double(forKey: "pageZoom")
        webView.pageZoom = zoom > 0 ? zoom : 1

        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1440, height: 900),
                              styleMask: [.titled, .closable, .miniaturizable, .resizable],
                              backing: .buffered, defer: false)
        window.title = "mystical//assistant"
        window.minSize = NSSize(width: 720, height: 480)
        window.backgroundColor = Placeholder.ground
        window.isReleasedWhenClosed = false
        window.center()
        window.setFrameAutosaveName("Dashboard")
        super.init(window: window)
        window.delegate = self

        let root = NSView()
        for v in [webView, placeholder] as [NSView] {
            v.translatesAutoresizingMaskIntoConstraints = false
            root.addSubview(v)
            NSLayoutConstraint.activate([
                v.leadingAnchor.constraint(equalTo: root.leadingAnchor),
                v.trailingAnchor.constraint(equalTo: root.trailingAnchor),
                v.topAnchor.constraint(equalTo: root.topAnchor),
                v.bottomAnchor.constraint(equalTo: root.bottomAnchor),
            ])
        }
        window.contentView = root
        webView.navigationDelegate = self
        webView.uiDelegate = self
        placeholder.button.target = self
        placeholder.button.action = #selector(startPressed)
        placeholder.show(.waiting)
    }

    required init?(coder: NSCoder) { fatalError() }

    // MARK: state

    /// Called on every bridge change: load the dashboard when it answers, cover
    /// it with the native placeholder when it doesn't.
    func sync() {
        if bridge.repoMissing {
            return cover(.missing(bridge.repo))
        }
        if bridge.up, let url = bridge.status?.dashboardURL {
            // Same dashboard still showing: leave it alone — it reconnects itself.
            if showingPage, sameDashboard(loaded, url) { return }
            load(url)
            return
        }
        // One missed poll is a restart's first second; two is down.
        guard bridge.misses >= 2 || !(bridge.status?.answering ?? false) else { return }
        cover(bridge.status?.running == true ? .waiting : .stopped)
    }

    private func sameDashboard(_ a: URL?, _ b: URL) -> Bool {
        guard let a else { return false }
        return a.port == b.port && a.query == b.query
    }

    private func load(_ url: URL) {
        loaded = url
        showingPage = true
        placeholder.isHidden = true
        webView.load(URLRequest(url: url))
    }

    private func cover(_ state: Placeholder.State) {
        showingPage = false
        placeholder.show(state)
        placeholder.isHidden = false
    }

    /// Open one session: a full load of `?s=<id>` — the dashboard's own deep link.
    func open(session id: String) {
        guard let base = bridge.status?.dashboardURL else { return show() }
        load(URLPolicy.session(base, id))
        show()
    }

    /// A banner was clicked: let the page that made it handle it (it already
    /// knows how to open that session); if that page is gone, deep-link.
    func notificationClicked(_ id: String) {
        show()
        let arg = String(data: try! JSONSerialization.data(withJSONObject: [id]), encoding: .utf8)!
        webView.evaluateJavaScript("window.__mysticalNotificationClick?.(...\(arg)) === true") {
            [weak self] result, _ in
            guard (result as? Bool) != true, id.hasPrefix("tag:") else { return }
            Task { @MainActor in self?.open(session: String(id.dropFirst(4))) }
        }
    }

    func show() {
        onVisibilityChange?(true)
        showWindow(nil)
        window?.makeKeyAndOrderFront(nil)
        NSApp.activate()
    }

    func reload() {
        if showingPage { webView.reload() } else { sync() }
    }

    func zoom(_ factor: Double?) {
        webView.pageZoom = factor.map { min(3, max(0.5, webView.pageZoom * $0)) } ?? 1
        UserDefaults.standard.set(webView.pageZoom, forKey: "pageZoom")
    }

    @objc private func startPressed() { onStart?() }

    /// What the placeholder says, or nil when the dashboard is showing (Probe).
    var placeholderText: String? { placeholder.isHidden ? nil : placeholder.title.stringValue }

    // MARK: NSWindowDelegate

    func windowShouldClose(_ sender: NSWindow) -> Bool {
        sender.orderOut(nil)
        onVisibilityChange?(false)
        return false
    }

    // MARK: WKNavigationDelegate

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
                 preferences: WKWebpagePreferences)
        async -> (WKNavigationActionPolicy, WKWebpagePreferences) {
        if action.shouldPerformDownload { return (.download, preferences) }
        switch URLPolicy.decide(action.request.url, origin: bridge.status?.origin,
                                mainFrame: action.targetFrame?.isMainFrame ?? true,
                                newWindow: action.targetFrame == nil) {
        case .inView: return (.allow, preferences)
        case .browser:
            if let url = action.request.url { NSWorkspace.shared.open(url) }
            return (.cancel, preferences)
        case .ignore: return (.cancel, preferences)
        }
    }

    func webView(_ webView: WKWebView, decidePolicyFor response: WKNavigationResponse)
        async -> WKNavigationResponsePolicy {
        response.canShowMIMEType ? .allow : .download
    }

    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction,
                 didBecome download: WKDownload) { download.delegate = self }

    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse,
                 didBecome download: WKDownload) { download.delegate = self }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        // The script was seeded at creation; the answer may have changed since.
        Task {
            let p = await notifier.refreshPermission()
            _ = try? await webView.evaluateJavaScript("window.__mysticalSetPermission?.('\(p)')")
        }
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!,
                 withError error: Error) {
        // Not WebKit's error page: ours, and the poll brings the page back.
        cover(bridge.status?.running == true ? .waiting : .stopped)
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        webView.reload()
    }

    // MARK: WKUIDelegate

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if URLPolicy.decide(action.request.url, origin: bridge.status?.origin,
                            mainFrame: true, newWindow: true) == .browser,
           let url = action.request.url {
            NSWorkspace.shared.open(url)
        }
        return nil
    }

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo) async {
        _ = alert(message, buttons: ["OK"]).runModal()
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo) async -> Bool {
        alert(message, buttons: ["OK", "Cancel"]).runModal() == .alertFirstButtonReturn
    }

    func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String,
                 defaultText: String?, initiatedByFrame frame: WKFrameInfo) async -> String? {
        let a = alert(prompt, buttons: ["OK", "Cancel"])
        let field = NSTextField(string: defaultText ?? "")
        field.frame = NSRect(x: 0, y: 0, width: 300, height: 24)
        a.accessoryView = field
        a.window.initialFirstResponder = field
        return a.runModal() == .alertFirstButtonReturn ? field.stringValue : nil
    }

    func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters,
                 initiatedByFrame frame: WKFrameInfo) async -> [URL]? {
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        panel.canChooseDirectories = parameters.allowsDirectories
        panel.canChooseFiles = true
        return panel.runModal() == .OK ? panel.urls : nil
    }

    private func alert(_ text: String, buttons: [String]) -> NSAlert {
        let a = NSAlert()
        a.messageText = text
        buttons.forEach { a.addButton(withTitle: $0) }
        return a
    }

    // MARK: WKDownloadDelegate

    func download(_ download: WKDownload, decideDestinationUsing response: URLResponse,
                  suggestedFilename: String) async -> URL? {
        let dir = FileManager.default.urls(for: .downloadsDirectory, in: .userDomainMask)[0]
        let base = (suggestedFilename as NSString).deletingPathExtension
        let ext = (suggestedFilename as NSString).pathExtension
        var url = dir.appendingPathComponent(suggestedFilename)
        var n = 1
        while FileManager.default.fileExists(atPath: url.path) {
            n += 1
            url = dir.appendingPathComponent(ext.isEmpty ? "\(base) \(n)" : "\(base) \(n).\(ext)")
        }
        return url
    }

    func downloadDidFinish(_ download: WKDownload) {
        if let url = download.progress.fileURL { NSWorkspace.shared.activateFileViewerSelecting([url]) }
    }
}

/// What the window shows instead of WebKit's error page: the brand's ground and
/// phosphor teal, one line of state, and the one action that helps.
@MainActor
final class Placeholder: NSView {
    enum State: Equatable { case waiting, stopped, missing(String) }

    static let ground = NSColor(red: 0x06 / 255, green: 0x0a / 255, blue: 0x0a / 255, alpha: 1)
    static let teal = NSColor(red: 0x7f / 255, green: 0xe9 / 255, blue: 0xd8 / 255, alpha: 1)

    let title = NSTextField(labelWithString: "")
    let detail = NSTextField(wrappingLabelWithString: "")
    let button = NSButton(title: "Start the bridge", target: nil, action: nil)
    private let spinner = NSProgressIndicator()

    init() {
        super.init(frame: .zero)
        wantsLayer = true
        layer?.backgroundColor = Self.ground.cgColor
        let mono = { (size: CGFloat, w: NSFont.Weight) in NSFont.monospacedSystemFont(ofSize: size, weight: w) }
        title.font = mono(15, .semibold)
        title.textColor = Self.teal
        detail.font = mono(12, .regular)
        detail.textColor = Self.teal.withAlphaComponent(0.6)
        detail.alignment = .center
        detail.preferredMaxLayoutWidth = 460
        spinner.style = .spinning
        spinner.controlSize = .small
        let stack = NSStackView(views: [spinner, title, detail, button])
        stack.orientation = .vertical
        stack.spacing = 12
        stack.translatesAutoresizingMaskIntoConstraints = false
        addSubview(stack)
        NSLayoutConstraint.activate([
            stack.centerXAnchor.constraint(equalTo: centerXAnchor),
            stack.centerYAnchor.constraint(equalTo: centerYAnchor),
        ])
    }

    required init?(coder: NSCoder) { fatalError() }

    func show(_ state: State) {
        switch state {
        case .waiting:
            title.stringValue = "✦ waiting for the bridge…"
            detail.stringValue = "The dashboard loads the moment it answers."
            button.isHidden = true
            spinner.isHidden = false
            spinner.startAnimation(nil)
        case .stopped:
            title.stringValue = "✦ the bridge is stopped"
            detail.stringValue = "Sessions keep their history; nothing runs until it's back."
            button.isHidden = false
            spinner.isHidden = true
            spinner.stopAnimation(nil)
        case .missing(let repo):
            title.stringValue = "✦ can't find the checkout"
            detail.stringValue = "This app was built from \(repo.isEmpty ? "an unknown path" : repo), "
                + "which has no bin/mystical now. Rebuild it from your checkout: mystical app"
            button.isHidden = true
            spinner.isHidden = true
            spinner.stopAnimation(nil)
        }
    }
}
