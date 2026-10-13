import Foundation

/// The MAC APP tab's switches. The app owns them: they live in UserDefaults and
/// the page reads and writes them over the message handler (`settings` / `set`),
/// so there is one copy — the Dock and the floating panel are right at launch,
/// before any page has loaded, and a reload never resets them.
public struct MacPrefs: Equatable {
    /// The Dock icon stays while the window is hidden (off = menu bar only then).
    public var keepInDock = true
    /// The always-on-top WAITING ON YOU panel.
    public var floating = false
    /// The window title is the open session's.
    public var titleFollowsSession = false

    public static let keys = ["keepInDock", "floating", "titleFollowsSession"]

    public init() {}

    public init(_ defaults: UserDefaults) {
        for key in Self.keys {
            if let v = defaults.object(forKey: key) as? Bool { set(key, v) }
        }
    }

    /// Applies one `set` from the page. False = not a setting.
    @discardableResult
    public mutating func set(_ key: String, _ value: Bool) -> Bool {
        switch key {
        case "keepInDock": keepInDock = value
        case "floating": floating = value
        case "titleFollowsSession": titleFollowsSession = value
        default: return false
        }
        return true
    }

    public func save(_ defaults: UserDefaults) {
        for (k, v) in dict { defaults.set(v, forKey: k) }
    }

    /// What the page gets back.
    public var dict: [String: Bool] {
        ["keepInDock": keepInDock, "floating": floating, "titleFollowsSession": titleFollowsSession]
    }
}
