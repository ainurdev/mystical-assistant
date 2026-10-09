import Foundation

/// What `bin/mystical status --json` prints — the app's only source for the
/// port, the token and whether a bridge is up. Reading it rather than .env keeps
/// one parser of that file (the launcher's), and a rotated token is picked up on
/// the next status instead of going stale in the app.
public struct BridgeStatus: Decodable, Equatable {
    public struct Surface: Decodable, Equatable {
        public let port: Int
        public let http: Int
        public let url: String?
    }

    public let running: Bool
    public let pid: Int?
    /// "systemd" | "launchd" | "hand-launched" | nil (no supervisor installed).
    public let supervised: String?
    public let log: String?
    public let dashboard: Surface?

    public static func parse(_ data: Data) -> BridgeStatus? {
        try? JSONDecoder().decode(BridgeStatus.self, from: data)
    }

    /// Up and serving: the process is there and the dashboard answered 2xx/3xx.
    public var answering: Bool {
        guard running, let d = dashboard else { return false }
        return (200..<400).contains(d.http)
    }

    /// The dashboard URL with its token — what the window loads.
    public var dashboardURL: URL? { dashboard?.url.flatMap(URL.init(string:)) }

    /// `http://127.0.0.1:<port>`: in-window navigation stays inside it.
    public var origin: URL? {
        dashboard.flatMap { URL(string: "http://127.0.0.1:\($0.port)") }
    }
}
