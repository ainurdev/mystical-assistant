import Foundation

/// One session blocked on you — a row in the menu bar's "Waiting on you".
public struct WaitingSession: Equatable {
    public let id: String
    public let title: String
    public let label: String
}

/// Reads `GET /local/running` — the same status map both web surfaces render
/// from (bridge/runner.py `_build_status`). Only `state == "awaiting"` counts:
/// a question or a permission card, or a turn that ended on a question.
public enum Running {
    public static func waiting(_ data: Data) -> [WaitingSession]? {
        guard let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else { return nil }
        let status = root["status"] as? [String: [String: Any]] ?? [:]
        var titles: [String: String] = [:]
        for job in root["jobs"] as? [[String: Any]] ?? [] {
            if let sid = job["session_id"] as? String, let t = job["title"] as? String,
               !t.isEmpty {
                titles[sid] = t
            }
        }
        return status.compactMap { sid, st -> WaitingSession? in
            guard st["state"] as? String == "awaiting" else { return nil }
            let label = st["label"] as? String ?? "waiting on you"
            return WaitingSession(id: sid, title: titles[sid] ?? label, label: label)
        }.sorted { ($0.title, $0.id) < ($1.title, $1.id) }
    }
}
