import Foundation

/// A `mystical://` link — the scheme build.sh registers for the bundle. Two forms:
///
///     mystical://session/<id>      open that session, the way the menu bar does
///     mystical://open[?s=<id>]     show the window (on a session, if one is named)
///
/// A link opens things and nothing else — never start, stop or restart: any page
/// can point at a scheme, so the worst a link can do is bring the window up.
public enum DeepLink: Equatable {
    case open
    case session(String)

    public static func parse(_ url: URL) -> DeepLink? {
        guard url.scheme?.lowercased() == "mystical" else { return nil }
        let comps = URLComponents(url: url, resolvingAgainstBaseURL: false)
        let asked = comps?.queryItems?.first { $0.name == "s" }?.value ?? ""
        let path = url.pathComponents.filter { $0 != "/" }
        switch url.host?.lowercased() ?? "" {
        case "", "open":
            return asked.isEmpty ? .open : .session(asked)
        case "session":
            guard let id = path.first, !id.isEmpty else { return .open }
            return .session(id)
        default:
            return nil
        }
    }
}
