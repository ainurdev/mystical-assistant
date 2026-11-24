import Foundation
import JavaScriptCore
import Testing
@testable import MysticalCore

// MARK: status --json

@Test func statusParsesARunningBridge() throws {
    let json = #"{"running":true,"pid":2095,"supervised":"launchd","log":"/x/mystical.log","dashboard":{"port":8790,"http":200,"url":"http://127.0.0.1:8790/?token=abc"},"miniapp":{"port":8787,"http":200,"url":null},"landing":{"port":8791,"http":200,"url":"http://127.0.0.1:8791/"}}"#
    let s = try #require(BridgeStatus.parse(Data(json.utf8)))
    #expect(s.answering)
    #expect(s.supervised == "launchd")
    #expect(s.dashboardURL?.absoluteString == "http://127.0.0.1:8790/?token=abc")
    #expect(s.origin?.absoluteString == "http://127.0.0.1:8790")
}

@Test func statusParsesAStoppedBridge() throws {
    let s = try #require(BridgeStatus.parse(Data(#"{"running":false,"pid":null,"log":"/x"}"#.utf8)))
    #expect(!s.running && !s.answering)
    #expect(s.dashboardURL == nil)
}

@Test func statusRejectsGarbage() {
    #expect(BridgeStatus.parse(Data("  ✘ .env not found".utf8)) == nil)
}

@Test func runningButNotAnsweringIsNotAnswering() throws {
    let json = #"{"running":true,"pid":1,"supervised":null,"log":"/x","dashboard":{"port":8790,"http":0,"url":"http://127.0.0.1:8790/"}}"#
    #expect(try #require(BridgeStatus.parse(Data(json.utf8))).answering == false)
}

// MARK: /local/running

@Test func waitingListsOnlyAwaitingSessionsTitledFromTheirJob() throws {
    let json = #"""
    {"jobs":[{"session_id":"a","title":"fix the build"},{"session_id":"b","title":"x"}],
     "status":{"a":{"state":"awaiting","kind":"question","label":"awaiting your answer"},
               "b":{"state":"working","label":"Bash"},
               "c":{"state":"awaiting","kind":null,"label":"needs a decision"}}}
    """#
    let w = try #require(Running.waiting(Data(json.utf8)))
    #expect(w == [
        WaitingSession(id: "a", subject: "a", title: "fix the build", label: "awaiting your answer", at: nil),
        WaitingSession(id: "c", subject: "c", title: "needs a decision", label: "needs a decision", at: nil),
    ])
}

@Test func waitingIsNilForNonJSON() {
    #expect(Running.waiting(Data("<html>".utf8)) == nil)
}

@Test func waitingPrefersNeeds() throws {
    // NEEDS YOU, in the bridge's order (not by title); the status map is ignored.
    let json = #"""
    {"status":{"s9":{"state":"awaiting","kind":"question","label":"awaiting your answer"}},
     "needs":[{"subject":"s1","kind":"approve","verb":"APPROVE","title":"Project logos and theme sync",
               "body":"Bash: rm -rf old-shots","at":1729090000.0,"session_id":"s1","meta":{}},
              {"subject":"rv:i1:r1","kind":"rv_offer","verb":"OFFERED","title":"Fix the login form",
               "body":"","at":1729090100.0,"session_id":null,"meta":{}}]}
    """#
    let w = try #require(Running.waiting(Data(json.utf8)))
    #expect(w == [
        WaitingSession(id: "s1", subject: "s1", title: "Project logos and theme sync", label: "APPROVE · Bash: rm -rf old-shots", at: 1729090000),
        WaitingSession(id: "", subject: "rv:i1:r1", title: "Fix the login form", label: "OFFERED", at: 1729090100),
    ])
}

@Test func waitingFallsBackToStatus() {
    // A bridge from before NEEDS YOU sends no "needs": the status map decides.
    let old = #"{"status":{"a":{"state":"awaiting","kind":"question","label":"awaiting your answer"}}}"#
    #expect(Running.waiting(Data(old.utf8)) == [
        WaitingSession(id: "a", subject: "a", title: "awaiting your answer", label: "awaiting your answer", at: nil),
    ])
    // An empty "needs" is a newer bridge with nothing waiting, not an older one.
    let none = #"{"needs":[],"status":{"a":{"state":"awaiting","kind":"question","label":"awaiting your answer"}}}"#
    #expect(Running.waiting(Data(none.utf8)) == [])
}

// MARK: URL policy

let origin = URL(string: "http://127.0.0.1:8790")!

@Test func dashboardNavigationStaysInTheWindow() {
    for u in ["http://127.0.0.1:8790/?token=x", "http://localhost:8790/local/graph/html",
              "http://127.0.0.1:8790/?skipboot#/s/abc", "http://127.0.0.1:8790/#/settings/system"] {
        #expect(URLPolicy.decide(URL(string: u), origin: origin, mainFrame: true, newWindow: false) == .inView)
    }
}

@Test func elsewhereOpensInTheBrowser() {
    for u in ["https://github.com/a/b/pull/1", "http://127.0.0.1:5173/", "mailto:x@y.z"] {
        #expect(URLPolicy.decide(URL(string: u), origin: origin, mainFrame: true, newWindow: false) == .browser, "\(u)")
    }
    // Even the dashboard itself, when a link asks for a new window.
    #expect(URLPolicy.decide(URL(string: "http://127.0.0.1:8790/share/x"), origin: origin, mainFrame: true, newWindow: true) == .browser)
}

@Test func iframesLoadWhereTheyAre() {
    // The preview pane frames a dev server on another port.
    #expect(URLPolicy.decide(URL(string: "http://localhost:5173/"), origin: origin, mainFrame: false, newWindow: false) == .inView)
}

@Test func oddSchemesNeverEscape() {
    #expect(URLPolicy.decide(URL(string: "blob:http://127.0.0.1:8790/1"), origin: origin, mainFrame: true, newWindow: false) == .inView)
    #expect(URLPolicy.decide(URL(string: "file:///etc/passwd"), origin: origin, mainFrame: true, newWindow: false) == .ignore)
    #expect(URLPolicy.decide(nil, origin: origin, mainFrame: true, newWindow: false) == .ignore)
}

@Test func settingsPanesOpenInSystemSettings() {
    let pane = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility")
    #expect(URLPolicy.decide(pane, origin: origin, mainFrame: true, newWindow: false) == .browser)
}

@Test func sessionLinkReplacesAnyEarlierOne() {
    let base = URL(string: "http://127.0.0.1:8790/?token=abc&s=old")!
    let u = URLPolicy.session(base, "new")
    let items = URLComponents(url: u, resolvingAgainstBaseURL: false)!.queryItems!
    #expect(items.filter { $0.name == "s" }.map(\.value) == ["new"])
    #expect(items.contains { $0.name == "token" && $0.value == "abc" })
    #expect(items.contains { $0.name == "skipboot" })
}

@Test func aSessionLinkIsStillTheSameDashboard() {
    // The menu bar opens a session with ?s=…&skipboot; the next poll must not
    // take that for a new dashboard and reload it, replaying the intro.
    for base in [URL(string: "http://127.0.0.1:8790/?token=abc")!, URL(string: "http://127.0.0.1:8790/")!] {
        #expect(URLPolicy.sameDashboard(URLPolicy.session(base, "s1"), base), "\(base)")
        #expect(URLPolicy.sameDashboard(base, base))
    }
    let base = URL(string: "http://127.0.0.1:8790/?token=abc")!
    #expect(!URLPolicy.sameDashboard(base, URL(string: "http://127.0.0.1:8790/?token=new")!))
    #expect(!URLPolicy.sameDashboard(base, URL(string: "http://127.0.0.1:8791/?token=abc")!))
    #expect(!URLPolicy.sameDashboard(nil, base))
}

// MARK: notification shim

@Test func identifierIsTheTagSoRepeatsReplace() {
    #expect(NotificationShim.identifier(tag: "sess-1", fallback: "n1") == "tag:sess-1")
    #expect(NotificationShim.identifier(tag: "", fallback: "n1") == "n1")
    #expect(NotificationShim.identifier(tag: nil, fallback: "n1") == "n1")
}

@Test func aBannersSessionIsItsTagOnlyWhenTheTagIsASession() {
    // The page is gone (reloaded): a click deep-links the tag's session — but the
    // feed's tags are subjects, and only a session id has no colon in it.
    #expect(NotificationShim.session(fromIdentifier: "tag:3f2a9c") == "3f2a9c")
    #expect(NotificationShim.session(fromIdentifier: "tag:rv:prod:r1") == nil)
    #expect(NotificationShim.session(fromIdentifier: "tag:pr:o/r:feat/x") == nil)
    #expect(NotificationShim.session(fromIdentifier: "n1730000-4") == nil)
}

@Test func permissionMapping() {
    #expect(NotificationShim.permission(authorized: true, denied: false) == "granted")
    #expect(NotificationShim.permission(authorized: false, denied: true) == "denied")
    #expect(NotificationShim.permission(authorized: nil, denied: false) == "default")
}

/// Runs the shim in JavaScriptCore with a fake message handler that records
/// what the page sent and answers requestPermission with `reply`.
func shimContext(permission: String, reply: String = "granted") -> (JSContext, () -> [[String: Any]]) {
    let ctx = JSContext()!
    ctx.exceptionHandler = { _, e in Issue.record("JS exception: \(e?.toString() ?? "?")") }
    ctx.evaluateScript("var window = this; var sent = [];")
    ctx.evaluateScript("""
    window.webkit = { messageHandlers: { mysticalNotify: { postMessage: function (m) {
      sent.push(JSON.parse(JSON.stringify(m)));
      return Promise.resolve(m.op === "request" ? "\(reply)" : null);
    } } } };
    """)
    ctx.evaluateScript(NotificationShim.source(permission: permission))
    return (ctx, { ctx.objectForKeyedSubscript("sent").toArray() as? [[String: Any]] ?? [] })
}

@Test func shimPostsOnlyWhenGranted() {
    let (ctx, sent) = shimContext(permission: "default")
    ctx.evaluateScript(#"new Notification("⏸ fix", { body: "waiting", tag: "s1" });"#)
    #expect(sent().isEmpty)
    let (ctx2, sent2) = shimContext(permission: "granted")
    ctx2.evaluateScript(#"new Notification("⏸ fix", { body: "waiting", tag: "s1", icon: "/favicon.svg" });"#)
    let m = sent2()
    #expect(m.count == 1)
    #expect(m.first?["op"] as? String == "show")
    #expect(m.first?["id"] as? String == "tag:s1")
    #expect(m.first?["body"] as? String == "waiting")
}

@Test func shimClickRunsThePagesHandler() {
    let (ctx, _) = shimContext(permission: "granted")
    ctx.evaluateScript(#"var clicked = 0; var n = new Notification("t", { tag: "s1" }); n.onclick = function () { clicked++; };"#)
    #expect(ctx.evaluateScript(#"window.__mysticalNotificationClick("tag:s1")"#).toBool())
    #expect(ctx.evaluateScript("clicked").toInt32() == 1)
    // A banner from before a reload: nothing to call, and the app is told so.
    #expect(!ctx.evaluateScript(#"window.__mysticalNotificationClick("tag:gone")"#).toBool())
}

@Test func shimCloseTellsTheApp() {
    let (ctx, sent) = shimContext(permission: "granted")
    ctx.evaluateScript(#"new Notification("t", { tag: "s1" }).close();"#)
    #expect(sent().map { $0["op"] as? String } == ["show", "close"])
    #expect(!ctx.evaluateScript(#"window.__mysticalNotificationClick("tag:s1")"#).toBool())
}

@Test func shimRequestPermissionAdoptsTheAnswer() async throws {
    let (ctx, _) = shimContext(permission: "default", reply: "denied")
    ctx.evaluateScript(#"var got = null; Notification.requestPermission().then(function (p) { got = p; });"#)
    // JSC drains its microtask queue at the end of each evaluateScript.
    ctx.evaluateScript("0")
    #expect(ctx.evaluateScript("got").toString() == "denied")
    #expect(ctx.evaluateScript("Notification.permission").toString() == "denied")
}

@Test func shimInstallsOnce() {
    let (ctx, _) = shimContext(permission: "granted")
    ctx.evaluateScript("var first = window.Notification;")
    ctx.evaluateScript(NotificationShim.source(permission: "denied"))
    #expect(ctx.evaluateScript("window.Notification === first && Notification.permission === 'granted'").toBool())
}

@Test func shimForwardsSubtitleAndThread() {
    let (ctx, sent) = shimContext(permission: "granted")
    ctx.evaluateScript(#"new Notification("⏸ fix", { body: "Bash", tag: "s1", subtitle: "mystical · master", thread: "s1" });"#)
    #expect(sent().first?["subtitle"] as? String == "mystical · master")
    #expect(sent().first?["thread"] as? String == "s1")
    // Not asked for: empty strings, never undefined.
    ctx.evaluateScript(#"new Notification("t", { tag: "s2" });"#)
    #expect(sent().last?["subtitle"] as? String == "")
    #expect(sent().last?["thread"] as? String == "")
}

// MARK: busy count

@Test func workingCountsEverySourceMidTurn() {
    let json = #"{"status":{"a":{"state":"working","source":"bridge"},"b":{"state":"awaiting"},"c":{"state":"working","source":"native"},"d":{"state":"live"}}}"#
    #expect(Running.working(Data(json.utf8)) == 2)
    #expect(Running.working(Data("nope".utf8)) == 0)
}

// MARK: turns

@Test func turnsAreTheJobEachSessionIsRunning() {
    // Every turn the bridge starts is a fresh job, so a new job id is a new turn.
    let json = #"{"jobs":[{"session_id":"a","job_id":"9f2c","title":"x"},{"session_id":null,"job_id":"77aa"},{"session_id":"b"}],"status":{}}"#
    #expect(Running.turns(Data(json.utf8)) == ["a": "9f2c"])
    #expect(Running.turns(Data("nope".utf8)) == [:])
}

// MARK: the panel's HIDE

/// A row for the HIDE tests: a session's, or an offer's (`rv:…`, no session), raised `at`.
private func row(_ subject: String, at: Double = 1) -> WaitingSession {
    WaitingSession(id: subject.hasPrefix("rv:") ? "" : subject, subject: subject, title: subject, label: "", at: at)
}

@Test func hideHoldsUntilSomethingNewWaits() throws {
    let hide = PanelHide([row("s1"), row("rv:i1:r1")], turns: ["s1": "j1"])
    let same = try #require(hide.after([row("rv:i1:r1"), row("s1")], turns: ["s1": "j1"], dashboardInFront: false))
    #expect(same == hide)
    #expect(same.after([row("s1"), row("s2")], turns: ["s1": "j1", "s2": "j9"], dashboardInFront: false) == nil)
}

@Test func aSessionStaysQuietForTheRestOfItsTurn() throws {
    var hide = PanelHide([row("s1")], turns: ["s1": "j1"])
    // Answered, still working on j1; then another card in the same turn.
    hide = try #require(hide.after([], turns: ["s1": "j1"], dashboardInFront: false))
    hide = try #require(hide.after([row("s1", at: 2)], turns: ["s1": "j1"], dashboardInFront: false))
    // The turn is over (nothing running, nothing listed): its next turn's ask is new.
    hide = try #require(hide.after([], turns: [:], dashboardInFront: false))
    #expect(hide.after([row("s1", at: 3)], turns: ["s1": "j2"], dashboardInFront: false) == nil)
}

@Test func aTurnThatStartsStraightAfterIsStillALaterTurn() throws {
    // A flow's next step starts in the same session between two polls, never seen idle.
    var hide = PanelHide([row("s1")], turns: ["s1": "j1"])
    hide = try #require(hide.after([], turns: ["s1": "j2"], dashboardInFront: false))
    #expect(hide.after([row("s1", at: 2)], turns: ["s1": "j2"], dashboardInFront: false) == nil)
}

@Test func theRowYouHidNeverBringsItBack() throws {
    // A ticket set waiting for approval stays listed while its session starts another turn.
    var hide = PanelHide([row("s9", at: 5)], turns: [:])
    hide = try #require(hide.after([row("s9", at: 5)], turns: ["s9": "j5"], dashboardInFront: false))
    // What that turn asks is new.
    #expect(hide.after([row("s9", at: 8)], turns: ["s9": "j5"], dashboardInFront: false) == nil)
}

@Test func anOfferStaysHiddenThroughABridgeRestart() throws {
    // A restarted bridge answers before Rivendell reconnects: its offers go missing a while,
    // then come back stamped with when it heard of them again (rivendell.py _catch_up).
    var hide = PanelHide([row("rv:i1:r1")], turns: [:])
    hide = try #require(hide.after([], turns: [:], dashboardInFront: false))
    #expect(hide.after([row("rv:i1:r1", at: 2)], turns: [:], dashboardInFront: false) != nil)
}

@Test func whatTheDashboardShowedCountsAsSeen() throws {
    var hide = PanelHide([row("s1")], turns: ["s1": "j1"])
    // s2 asks while the dashboard is in front, and you leave without answering it.
    hide = try #require(hide.after([row("s1"), row("s2")], turns: ["s1": "j1", "s2": "j7"], dashboardInFront: true))
    #expect(hide.after([row("s1"), row("s2")], turns: ["s1": "j1", "s2": "j7"], dashboardInFront: false) != nil)
}

@Test func aFailedPollIsNoNews() {
    // The bridge down or restarting lists nothing and runs nothing: not every turn over.
    let hide = PanelHide([row("s1"), row("rv:i1:r1")], turns: ["s1": "j1"])
    #expect(hide.after([], turns: nil, dashboardInFront: false) == hide)
}

@Test func theHideIsRememberedAcrossRestarts() {
    let d = UserDefaults(suiteName: "test.mystical.\(UUID().uuidString)")!
    #expect(PanelHide.load(d) == nil)   // never hidden
    let hide = PanelHide([row("s1"), row("rv:i1:r1")], turns: ["s1": "j1"])
    PanelHide.save(hide, d)
    #expect(PanelHide.load(d) == hide)
    // Holding nothing is still a hide: nothing new has come.
    PanelHide.save(PanelHide([], turns: [:]), d)
    #expect(PanelHide.load(d) == PanelHide([], turns: [:]))
    PanelHide.save(nil, d)
    #expect(PanelHide.load(d) == nil)
}

// MARK: deep links

@Test func deepLinksOpenSessionsAndTheWindow() {
    #expect(DeepLink.parse(URL(string: "mystical://session/abc-123")!) == .session("abc-123"))
    #expect(DeepLink.parse(URL(string: "mystical://open?s=abc")!) == .session("abc"))
    #expect(DeepLink.parse(URL(string: "mystical://open")!) == .open)
    #expect(DeepLink.parse(URL(string: "mystical://session")!) == .open)
    if let bare = URL(string: "mystical://") { #expect(DeepLink.parse(bare) == .open) }
}

@Test func deepLinksNeverCommand() {
    #expect(DeepLink.parse(URL(string: "mystical://restart")!) == nil)
    #expect(DeepLink.parse(URL(string: "https://example.com/session/x")!) == nil)
}

// MARK: prefs

@Test func prefsRoundTripThroughDefaults() {
    let d = UserDefaults(suiteName: "test.mystical.\(UUID().uuidString)")!
    var p = MacPrefs(d)
    #expect(p == MacPrefs())   // nothing stored yet: the defaults
    #expect(p.keepInDock && !p.floating && !p.titleFollowsSession)
    let known = p.set("floating", true), unknown = p.set("volume", true)
    #expect(known && !unknown)   // "volume" is not a setting
    p.save(d)
    #expect(MacPrefs(d).floating)
    #expect(MacPrefs(d).dict["keepInDock"] == true)
}

@Test func summonShortcutIsASwitchOnByDefault() {
    // ⌃⌘A, the Windows app's Win+Ctrl+A twin: on until you turn it off, like there.
    let d = UserDefaults(suiteName: "test.mystical.\(UUID().uuidString)")!
    var p = MacPrefs(d)
    #expect(p.hotkey && p.dict["hotkey"] == true)   // the page sees it, so SETTINGS shows the row
    let took = p.set("hotkey", false)
    #expect(took)
    p.save(d)
    #expect(!MacPrefs(d).hotkey)
}

// MARK: banner buttons

@Test func shimPostsActionsAndRunsOnaction() {
    let (ctx, sent) = shimContext(permission: "granted")
    ctx.evaluateScript(#"var got = null; var n = new Notification("⏸ fix", { tag: "s1", actions: [{ action: "allow", title: "Allow" }, { action: "deny", title: "Deny" }] }); n.onaction = function (a) { got = a; };"#)
    let acts = sent().first?["actions"] as? [[String: Any]]
    #expect(acts?.map { $0["id"] as? String } == ["allow", "deny"])
    #expect(acts?.map { $0["title"] as? String } == ["Allow", "Deny"])
    #expect(ctx.evaluateScript(#"window.__mysticalNotificationAction("tag:s1", "deny")"#).toBool())
    #expect(ctx.evaluateScript("got").toString() == "deny")
    #expect(!ctx.evaluateScript(#"window.__mysticalNotificationAction("tag:gone", "deny")"#).toBool())
    // No buttons asked for: an empty list, never undefined.
    ctx.evaluateScript(#"new Notification("t", { tag: "s2" });"#)
    #expect((sent().last?["actions"] as? [Any])?.isEmpty == true)
}

@Test func actionsAreSanitisedForTheCenter() {
    let raw: [[String: Any]] = [
        ["id": "allow", "title": "Allow"],
        ["id": "", "title": "no id"],
        ["id": "x", "title": ""],
        ["id": "allow", "title": "twice"],
        ["id": "long", "title": String(repeating: "a", count: 60)],
        ["id": "c", "title": "C"], ["id": "d", "title": "D"], ["id": "e", "title": "E"],
    ]
    let a = NotificationShim.actions(raw)
    #expect(a.map(\.id) == ["allow", "long", "c", "d"])
    #expect(a[1].title.count == 40)
    #expect(NotificationShim.actions(nil).isEmpty)
    #expect(NotificationShim.category(for: a) == NotificationShim.category(for: a))
    #expect(NotificationShim.category(for: []) != NotificationShim.category(for: a))
}

// MARK: capture

@Test func captureRequestNeedsAnAbsoluteDir() {
    let r = CaptureRequest.parse(#"{"dir":"/tmp/cap","window":" Safari "}"#)
    #expect(r == CaptureRequest(dir: "/tmp/cap", window: "Safari"))
    #expect(CaptureRequest.parse(#"{"dir":"/tmp/cap","window":""}"#)?.window == nil)
    #expect(CaptureRequest.parse(#"{"dir":"rel"}"#) == nil)
    #expect(CaptureRequest.parse("junk") == nil)
    #expect(CaptureRequest.matches("safari", title: "Apple — Safari", app: nil))
    #expect(CaptureRequest.matches("mystical", title: nil, app: "Mystical"))
    #expect(!CaptureRequest.matches("xcode", title: "a", app: "b"))
}

// MARK: computer use (ComputerCore)

@Test func chordsMapToKeyCodesAndFlags() throws {
    let c = try #require(ComputerCore.chord("cmd+shift+A"))
    #expect(c.key == 0 && c.flags == ComputerCore.command | ComputerCore.shift)
    #expect(ComputerCore.chord("Return")?.key == 36)
    #expect(ComputerCore.chord("ctrl+shift+tab")?.flags == ComputerCore.control | ComputerCore.shift)
    #expect(ComputerCore.chord("shift")?.key == nil)
    #expect(ComputerCore.chord("shift")?.modifierKeys == [56])
    #expect(ComputerCore.chord("cmd+nonsense") == nil)
    #expect(ComputerCore.chord("") == nil)
}

@Test func screenshotsShrinkToWhatTheModelReadsAndNeverGrow() {
    let (w, h) = ComputerCore.shotSize(width: 3024, height: 1964)
    #expect(w <= 1568 && w * h <= 1_150_000 + 2000)
    #expect(abs(Double(w) / Double(h) - 3024.0 / 1964.0) < 0.01)
    #expect(ComputerCore.shotSize(width: 800, height: 600) == (800, 600))
}

@Test func screenshotPixelsMapToScreenPointsAndBack() {
    let p = ComputerCore.toScreen(x: 728, y: 408, image: (1456, 816), origin: (0, 0), points: (1512, 847.5))
    #expect(abs(p.0 - 756) < 0.01 && abs(p.1 - 423.75) < 0.01)
    let clamped = ComputerCore.toScreen(x: -5, y: 9999, image: (1456, 816), origin: (0, 0), points: (1512, 847.5))
    #expect(clamped.0 == 0 && clamped.1 < 847.5)
    #expect(ComputerCore.toImage(x: 756, y: 423.75, image: (1456, 816), origin: (0, 0), points: (1512, 847.5)) == (728, 408))
}

@Test func grantedMatchesNameOrBundleAnyCase() {
    #expect(ComputerCore.granted(["Safari"], name: "safari", bundle: nil))
    #expect(ComputerCore.granted(["com.apple.Safari"], name: "Safari", bundle: "com.apple.safari"))
    #expect(!ComputerCore.granted(["Safari"], name: "Mail", bundle: "com.apple.mail"))
    #expect(!ComputerCore.granted(["Safari"], name: "", bundle: ""))
}

@Test func typingSplitsIntoShortRunsWithNewlinesAsReturns() {
    #expect(ComputerCore.typingRuns("hi\nthere") == ["hi", "\n", "there"])
    let long = String(repeating: "a", count: 45)
    #expect(ComputerCore.typingRuns(long).map(\.count) == [20, 20, 5])
}

@Test func aCharacterLongerThanARunNeverLeavesAnEmptyOne() {
    // One grapheme of 22 UTF-16 units: first, after a newline, and after text.
    let big = "e" + String(repeating: "\u{0301}", count: 21)
    #expect(big.count == 1 && big.utf16.count == 22)
    #expect(ComputerCore.typingRuns(big) == [big])
    #expect(ComputerCore.typingRuns("a\n" + big + "b") == ["a", "\n", big, "b"])
    #expect(!ComputerCore.typingRuns("hello " + big + big).contains(""))
}

@Test func tokenComesFromTheDashboardURL() {
    #expect(ComputerCore.token(from: URL(string: "http://127.0.0.1:8790/?token=abc")) == "abc")
    #expect(ComputerCore.token(from: URL(string: "http://127.0.0.1:8790/")) == nil)
}
