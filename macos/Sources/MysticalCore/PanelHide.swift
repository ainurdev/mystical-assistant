import Foundation

/// The WAITING ON YOU panel's HIDE (Mystical/FloatingPanel.swift). The panel
/// floats over whatever app you are in for as long as anything waits; HIDE puts
/// it away until something new needs you. The menu bar count and the Dock badge
/// stay, and their menus list the rows meanwhile.
///
/// New is a need you haven't been shown, from a session that isn't quiet. Shown
/// means on the panel when you pressed HIDE, or listed while the dashboard was
/// in front (it was on screen there). A need stays shown for as long as it
/// waits, so the row you hid never brings the panel back: not when its session
/// starts another turn, and not when a restarted bridge lists it again (offers
/// go missing until Rivendell reconnects). A need is its subject and when it
/// was raised: a session asking again raises a new one. An offer is its subject
/// alone: the restarted bridge stamps it with when it heard of it again.
///
/// A session is quiet for the rest of the turn it was shown in, however many
/// cards it asks, and stops being quiet once that turn is over (nothing of it
/// running or listed) or a later one starts: its next turn's ask is new, so one
/// session can't keep the panel quiet for days. A turn is the bridge's job id
/// (`Running.turns`) rather than "seen idle", because a flow's next step starts
/// in the same session faster than the 3 s poll. Why not every new ask: a
/// chatty session would bring the panel straight back, and you picked the
/// quieter rule.
///
/// shortcut: a restart resumes a cut turn as a new job, so that turn's next ask
/// counts as new; key on a turn id that survives restarts if that pops it often.
/// shortcut: a message steered into a turn that waits on a background command
/// runs in that same job, so its asks stay quiet up to the bridge's BG_WAIT_CAP
/// (2 h); a per-turn id from the bridge would end that too.
public struct PanelHide: Equatable {
    /// Needs shown (`need(_:)`), kept until the hide ends: a need never repeats.
    let needs: Set<String>
    /// Session → the turn it is quiet for.
    let quiet: [String: String]

    init(needs: Set<String>, quiet: [String: String]) {
        self.needs = needs
        self.quiet = quiet
    }

    /// HIDE: everything on the panel now is shown.
    public init(_ listed: [WaitingSession], turns: [String: String]) {
        self = PanelHide(needs: [], quiet: [:]).showing(listed, turns: turns)
    }

    /// The hide one poll later, or nil: something new waits, so the panel comes
    /// back with the full list and the hide is over. `turns` is nil after a
    /// failed poll, which lists nothing and runs nothing: no news.
    public func after(_ listed: [WaitingSession], turns: [String: String]?, dashboardInFront: Bool) -> PanelHide? {
        guard let turns else { return self }
        var next = PanelHide(needs: needs, quiet: quiet.filter { sid, turn in
            if let now = turns[sid] { return now == turn }   // a later turn: its asks are new
            return listed.contains { $0.id == sid }         // over, unless it still waits on you
        })
        if dashboardInFront { next = next.showing(listed, turns: turns) }
        let new = listed.contains { !next.needs.contains(Self.need($0)) && next.quiet[$0.id] == nil }
        return new ? nil : next
    }

    private func showing(_ listed: [WaitingSession], turns: [String: String]) -> PanelHide {
        var quiet = self.quiet
        for w in listed where !w.id.isEmpty && quiet[w.id] == nil { quiet[w.id] = turns[w.id] ?? "" }
        return PanelHide(needs: needs.union(listed.map(Self.need)), quiet: quiet)
    }

    private static func need(_ w: WaitingSession) -> String { w.id.isEmpty ? w.subject : "\(w.subject)@\(w.at ?? 0)" }

    /// Remembered across restarts, like the panel's place on screen. Holding
    /// nothing is still a hide: what you hid has gone, nothing new has come.
    public static func load(_ defaults: UserDefaults) -> PanelHide? {
        guard let d = defaults.dictionary(forKey: defaultsKey) else { return nil }
        return PanelHide(needs: Set(d["needs"] as? [String] ?? []), quiet: d["quiet"] as? [String: String] ?? [:])
    }

    public static func save(_ hide: PanelHide?, _ defaults: UserDefaults) {
        defaults.set(hide.map { ["needs": $0.needs.sorted(), "quiet": $0.quiet] as [String: Any] }, forKey: defaultsKey)
    }

    static let defaultsKey = "floatingHide"
}
