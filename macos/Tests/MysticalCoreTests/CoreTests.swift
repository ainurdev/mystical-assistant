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
        WaitingSession(id: "a", title: "fix the build", label: "awaiting your answer"),
        WaitingSession(id: "c", title: "needs a decision", label: "needs a decision"),
    ])
}

@Test func waitingIsNilForNonJSON() {
    #expect(Running.waiting(Data("<html>".utf8)) == nil)
}

// MARK: URL policy

let origin = URL(string: "http://127.0.0.1:8790")!

@Test func dashboardNavigationStaysInTheWindow() {
    for u in ["http://127.0.0.1:8790/?token=x", "http://localhost:8790/local/graph/html"] {
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

@Test func sessionLinkReplacesAnyEarlierOne() {
    let base = URL(string: "http://127.0.0.1:8790/?token=abc&s=old")!
    let u = URLPolicy.session(base, "new")
    let items = URLComponents(url: u, resolvingAgainstBaseURL: false)!.queryItems!
    #expect(items.filter { $0.name == "s" }.map(\.value) == ["new"])
    #expect(items.contains { $0.name == "token" && $0.value == "abc" })
    #expect(items.contains { $0.name == "skipboot" })
}

// MARK: notification shim

@Test func identifierIsTheTagSoRepeatsReplace() {
    #expect(NotificationShim.identifier(tag: "sess-1", fallback: "n1") == "tag:sess-1")
    #expect(NotificationShim.identifier(tag: "", fallback: "n1") == "n1")
    #expect(NotificationShim.identifier(tag: nil, fallback: "n1") == "n1")
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
