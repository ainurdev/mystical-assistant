import Foundation

/// One thing waiting on you — a row in the menu bar's "Waiting on you". `id` is
/// the session it opens: empty for a Rivendell offer, which has no session.
/// `subject` is what it is about (the bridge's `needs[].subject`: the session,
/// or the offer's `rv:…`) and `at` when it was raised: together they tell one
/// need from the next, for the panel's HIDE.
public struct WaitingSession: Equatable {
    public let id: String
    public let subject: String
    public let title: String
    public let label: String
    public let at: Double?
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
                let id = n["session_id"] as? String ?? ""
                return WaitingSession(id: id, subject: n["subject"] as? String ?? id,
                                      title: title.isEmpty ? verb : title,
                                      label: body.isEmpty ? verb : "\(verb) · \(body)",
                                      at: n["at"] as? Double)
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
            return WaitingSession(id: sid, subject: sid, title: titles[sid] ?? label, label: label, at: nil)
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

    /// Session → the turn it is running: the bridge's job id, fresh for every
    /// turn it starts (a message steered into a running turn joins its job).
    /// Only bridge sessions have one. The panel's HIDE tells turns apart with it.
    public static func turns(_ data: Data) -> [String: String] {
        guard let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else { return [:] }
        var out: [String: String] = [:]
        for job in root["jobs"] as? [[String: Any]] ?? [] {
            if let sid = job["session_id"] as? String, let id = job["job_id"] as? String { out[sid] = id }
        }
        return out
    }
}
