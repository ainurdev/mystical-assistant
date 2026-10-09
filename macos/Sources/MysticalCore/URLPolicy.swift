import Foundation

/// Where a navigation goes. The window is the dashboard and nothing else: a link
/// to GitHub, a PR or a preview tunnel opens in the default browser, where it
/// has your logins and tabs, instead of replacing the dashboard in place.
public enum NavigationTarget: Equatable {
    case inView, browser, ignore
}

public enum URLPolicy {
    /// - Parameters:
    ///   - mainFrame: false for iframes — the preview pane frames a dev server on
    ///     another port, and that has to load where it is.
    ///   - newWindow: `target=_blank` / `window.open` — never a second web view.
    public static func decide(_ url: URL?, origin: URL?, mainFrame: Bool,
                              newWindow: Bool) -> NavigationTarget {
        guard let url else { return .ignore }
        let scheme = url.scheme?.lowercased() ?? ""
        if ["about", "blob", "data", "javascript"].contains(scheme) {
            return newWindow ? .ignore : .inView
        }
        if newWindow { return ["http", "https", "mailto"].contains(scheme) ? .browser : .ignore }
        if !mainFrame { return .inView }
        if sameOrigin(url, origin) { return .inView }
        return ["http", "https", "mailto"].contains(scheme) ? .browser : .ignore
    }

    /// 127.0.0.1, localhost and [::1] are the same dashboard (the server's Host
    /// allow-list takes all three); the port has to match.
    public static func sameOrigin(_ url: URL, _ origin: URL?) -> Bool {
        guard let origin, url.scheme == "http", url.port == origin.port else { return false }
        return ["127.0.0.1", "localhost", "::1", "[::1]"].contains(url.host ?? "")
    }

    /// The dashboard opened on one session: `?s=` is the dashboard's own deep
    /// link (App.tsx), `skipboot` skips the intro a reload would replay.
    public static func session(_ base: URL, _ sessionId: String) -> URL {
        var c = URLComponents(url: base, resolvingAgainstBaseURL: false)!
        var q = (c.queryItems ?? []).filter { !linkItems.contains($0.name) }
        q += [URLQueryItem(name: "s", value: sessionId), URLQueryItem(name: "skipboot", value: nil)]
        c.queryItems = q
        return c.url!
    }

    /// Whether the page loaded from `loaded` is still the dashboard at `current`:
    /// same port and token. A `session` link to it counts — reloading that
    /// would replay the intro the link skipped.
    public static func sameDashboard(_ loaded: URL?, _ current: URL) -> Bool {
        guard let loaded else { return false }
        let rest = { (u: URL) in
            (URLComponents(url: u, resolvingAgainstBaseURL: false)?.queryItems ?? [])
                .filter { !linkItems.contains($0.name) }
        }
        return loaded.port == current.port && rest(loaded) == rest(current)
    }

    private static let linkItems = ["s", "skipboot"]
}
