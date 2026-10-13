import Foundation

/// What macos/capture.sh posts as the distributed notification's object: a JSON
/// string `{"dir": "/abs/dir", "window": "title or app substring"}`. The dir has
/// to be absolute — the app's cwd is nowhere useful.
public struct CaptureRequest: Equatable {
    public let dir: String
    public let window: String?

    public init(dir: String, window: String?) {
        self.dir = dir
        self.window = window
    }

    public static func parse(_ object: Any?) -> CaptureRequest? {
        guard let s = object as? String,
              let o = try? JSONSerialization.jsonObject(with: Data(s.utf8)) as? [String: Any],
              let dir = o["dir"] as? String, dir.hasPrefix("/") else { return nil }
        let w = (o["window"] as? String)?.trimmingCharacters(in: .whitespaces) ?? ""
        return CaptureRequest(dir: dir, window: w.isEmpty ? nil : w)
    }

    /// The window a request means: the first whose title or app name contains
    /// the asked text, case-insensitively.
    public static func matches(_ asked: String, title: String?, app: String?) -> Bool {
        let a = asked.lowercased()
        return [title, app].contains { ($0 ?? "").lowercased().contains(a) }
    }
}
