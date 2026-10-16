import Foundation

/// One thing waiting on you — a row in the menu bar's "Waiting on you". `id` is
/// the session it opens: empty for a Rivendell offer, which has no session.
public struct WaitingSession: Equatable {
    public let id: String
    public let title: String
    public let label: String
}

/// Reads `GET /local/running`. Waiting on you is the bridge's NEEDS YOU set
/// (`needs`: cards, questions, logins, usage-limit choices and Rivendell offers),
/// so the menu bar, the panel and the dashboard's bell list the same things in
/// the bridge's order. A bridge from before `needs` gets the old reading: the
/// status map both web surfaces render from (bridge/runner.py `_build_status`),
/// where only `state == "awaiting"` counts — a question or a permission card, or
/// a turn that ended on a question.
public enum Running {
    public static func waiting(_ data: Data) -> [WaitingSession]? {
        guard let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else { return nil }
        if let needs = root["needs"] as? [[String: Any]] {
            return needs.map { n in
                let verb = n["verb"] as? String ?? ""
                let title = n["title"] as? String ?? "", body = n["body"] as? String ?? ""
                return WaitingSession(id: n["session_id"] as? String ?? "",
                                      title: title.isEmpty ? verb : title,
                                      label: body.isEmpty ? verb : "\(verb) · \(body)")
            }
        }
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

    /// Sessions mid-turn, from every source — a terminal session working is as
    /// busy as a bridge one. Drives the menu bar's busy glyph.
    public static func working(_ data: Data) -> Int {
        guard let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else { return 0 }
        let status = root["status"] as? [String: [String: Any]] ?? [:]
        return status.values.filter { $0["state"] as? String == "working" }.count
    }
}
