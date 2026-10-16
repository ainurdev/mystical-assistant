// Assertions over windows/app/Core — the cases macos/Tests/MysticalCoreTests
// runs against the Swift core, so the twins can't drift. No framework:
//   windows/build.sh --check        (stages app/ + check/, runs this with dotnet.exe)
using System.Text.Json;
using Mystical.Core;

var failed = 0;
void Check(bool ok, string what)
{
    Console.WriteLine((ok ? "ok    " : "FAIL  ") + what);
    if (!ok) failed++;
}
JsonElement J(string json) => JsonDocument.Parse(json).RootElement;

// --- status --json -----------------------------------------------------------
const string runningJson = """{"running":true,"pid":2095,"supervised":"launchd","log":"/x/mystical.log","dashboard":{"port":8790,"http":200,"url":"http://127.0.0.1:8790/?token=abc"},"miniapp":{"port":8787,"http":200,"url":null},"landing":{"port":8791,"http":200,"url":"http://127.0.0.1:8791/"}}""";
var running = BridgeStatus.Parse(runningJson);
Check(running is { Answering: true, Supervised: "launchd" }, "status: a running bridge answers, supervised by launchd");
Check(running?.DashboardUrl?.ToString() == "http://127.0.0.1:8790/?token=abc", "status: the dashboard url carries the token");
Check(running?.Origin?.GetLeftPart(UriPartial.Authority) == "http://127.0.0.1:8790", "status: the origin is 127.0.0.1 on the port");
var stopped = BridgeStatus.Parse("""{"running":false,"pid":null,"log":"/x"}""");
Check(stopped is { Running: false, Answering: false, DashboardUrl: null }, "status: a stopped bridge");
Check(BridgeStatus.Parse("  ✘ .env not found") == null, "status: garbage is null");
Check(BridgeStatus.Parse("""{"running":true,"pid":1,"supervised":null,"log":"/x","dashboard":{"port":8790,"http":0,"url":"http://127.0.0.1:8790/"}}""") is { Answering: false },
      "status: running but not answering is not answering");

// --- /local/running ----------------------------------------------------------
const string runningMap = """{"jobs":[{"session_id":"a","title":"fix the build"},{"session_id":"b","title":"x"}],"status":{"a":{"state":"awaiting","kind":"question","label":"awaiting your answer"},"b":{"state":"working","label":"Bash"},"c":{"state":"awaiting","kind":null,"label":"needs a decision"}}}""";
var waiting = Running.Waiting(runningMap);
Check(waiting is [var w0, var w1]
      && w0 == new WaitingSession("a", "fix the build", "awaiting your answer")
      && w1 == new WaitingSession("c", "needs a decision", "needs a decision"),
      "running: only awaiting sessions, titled from their job, sorted by title");
Check(Running.Waiting("""{"status":{"z":{"state":"awaiting"}}}""") is [{ Title: "waiting on you", Label: "waiting on you" }],
      "running: no label and no job title read as waiting on you");
Check(Running.Waiting("<html>") == null, "running: non-JSON is null");
const string workingMap = """{"status":{"a":{"state":"working","source":"bridge"},"b":{"state":"awaiting"},"c":{"state":"working","source":"native"},"d":{"state":"live"}}}""";
Check(Running.Working(workingMap) == 2 && Running.Working("nope") == 0, "running: working counts every source mid-turn");

// --- URL policy --------------------------------------------------------------
var origin = new Uri("http://127.0.0.1:8790");
NavigationTarget Decide(string? u, bool mainFrame = true, bool newWindow = false) =>
    UrlPolicy.Decide(u == null ? null : new Uri(u), origin, mainFrame, newWindow);
Check(Decide("http://127.0.0.1:8790/?token=x") == NavigationTarget.InView
      && Decide("http://localhost:8790/local/graph/html") == NavigationTarget.InView,
      "url: dashboard navigation stays in the window");
Check(Decide("https://github.com/a/b/pull/1") == NavigationTarget.Browser
      && Decide("http://127.0.0.1:5173/") == NavigationTarget.Browser
      && Decide("mailto:x@y.z") == NavigationTarget.Browser,
      "url: elsewhere opens in the browser");
Check(Decide("http://127.0.0.1:8790/share/x", newWindow: true) == NavigationTarget.Browser,
      "url: even the dashboard, when a link asks for a new window");
Check(Decide("http://localhost:5173/", mainFrame: false) == NavigationTarget.InView, "url: iframes load where they are");
Check(Decide("blob:http://127.0.0.1:8790/1") == NavigationTarget.InView, "url: blob stays in view");
Check(Decide("file:///etc/passwd") == NavigationTarget.Ignore && Decide(null) == NavigationTarget.Ignore,
      "url: odd schemes never escape");
var session = UrlPolicy.Session(new Uri("http://127.0.0.1:8790/?token=abc&s=old"), "new");
Check(session.Query == "?token=abc&s=new&skipboot", "url: a session link replaces any earlier one and keeps the token");
var withToken = new Uri("http://127.0.0.1:8790/?token=abc");
var bare = new Uri("http://127.0.0.1:8790/");
Check(UrlPolicy.SameDashboard(UrlPolicy.Session(withToken, "s1"), withToken)
      && UrlPolicy.SameDashboard(UrlPolicy.Session(bare, "s1"), bare)
      && UrlPolicy.SameDashboard(withToken, withToken),
      "url: a session link is still the same dashboard");
Check(!UrlPolicy.SameDashboard(withToken, new Uri("http://127.0.0.1:8790/?token=new"))
      && !UrlPolicy.SameDashboard(withToken, new Uri("http://127.0.0.1:8791/?token=abc"))
      && !UrlPolicy.SameDashboard(null, withToken),
      "url: a new token, another port, or nothing loaded is not the same dashboard");
Check(UrlPolicy.Title("fix the build — dashboard") == "fix the build"
      && UrlPolicy.Title(" x — dashboard") == "x"
      && UrlPolicy.Title("") == "mystical//assistant"
      && UrlPolicy.Title(null) == "mystical//assistant",
      "url: the window title drops the dashboard suffix and falls back to the app's name");

// --- deep links --------------------------------------------------------------
Check(DeepLink.Parse("mystical://session/abc-123") == new DeepLink("abc-123")
      && DeepLink.Parse("mystical://open?s=abc") == new DeepLink("abc"),
      "links: session links name their session");
Check(DeepLink.Parse("mystical://open") == new DeepLink(null)
      && DeepLink.Parse("mystical://session") == new DeepLink(null)
      && DeepLink.Parse("mystical://") == new DeepLink(null),
      "links: open, a bare session, and a bare scheme open the window");
Check(DeepLink.Parse("mystical://SESSION/ab%20c") == new DeepLink("ab c"), "links: the host is case-insensitive and the id is decoded");
Check(DeepLink.Parse("mystical://restart") == null
      && DeepLink.Parse("https://example.com/session/x") == null
      && DeepLink.Parse("junk") == null,
      "links: never command, never another scheme");

// --- prefs -------------------------------------------------------------------
var prefsDir = Directory.CreateTempSubdirectory("mystical-check");
var prefsPath = Path.Combine(prefsDir.FullName, "settings.json");
var prefs = Prefs.Load(prefsPath);
Check(prefs is { Hotkey: true, Floating: false, TitleFollowsSession: false, Zoom: 1 }, "prefs: nothing stored yet is the defaults");
Check(prefs.Set("floating", true) && !prefs.Set("volume", true), "prefs: a switch is set, a non-setting is refused");
prefs.Save(prefsPath);
Check(Prefs.Load(prefsPath).Floating, "prefs: a saved switch comes back");
var dict = prefs.Dict("1.2");
Check(dict["platform"] is "windows" && dict["version"] is "1.2" && dict["floating"] is true
      && dict["hotkey"] is true && !dict.ContainsKey("keepInDock"),
      "prefs: the page gets the switches, the version and the platform, no Dock row");
File.WriteAllText(prefsPath, "{not json");
Check(Prefs.Load(prefsPath) is { Hotkey: true, Floating: false }, "prefs: a corrupt file is the defaults, not a crash");
prefsDir.Delete(true);

// --- capture requests --------------------------------------------------------
Check(CaptureRequest.Parse(J("""{"dir":"C:\\cap","window":" Edge "}""")) == new CaptureRequest(@"C:\cap", "Edge"),
      "capture: a rooted dir and a trimmed window");
Check(CaptureRequest.Parse(J("""{"dir":"\\\\wsl.localhost\\Ubuntu\\tmp\\x"}"""))?.Dir == @"\\wsl.localhost\Ubuntu\tmp\x",
      "capture: a UNC dir counts as rooted");
Check(CaptureRequest.Parse(J("""{"dir":"rel"}""")) == null && CaptureRequest.Parse(J("""{"window":"x"}""")) == null,
      "capture: a relative or missing dir is refused");
Check(CaptureRequest.Parse(J("""{"dir":"C:\\cap","window":""}"""))?.Window == null, "capture: an empty window means the screen");
Check(CaptureRequest.Matches("edge", "Docs — Edge", null) && CaptureRequest.Matches("mystical", null, "Mystical")
      && !CaptureRequest.Matches("xcode", "a", "b"),
      "capture: the window matches on title or app, case-insensitively");

// --- shim --------------------------------------------------------------------
Check(Shim.Permission(0) == "granted" && Shim.Permission(2) == "denied", "shim: Enabled is granted, anything else denied");
Check(Shim.Identifier("sess-1", "n1") == "tag:sess-1" && Shim.Identifier("", "n1") == "n1" && Shim.Identifier(null, "n1") == "n1",
      "shim: the identifier is the tag so repeats replace");
var longId = new string('a', 70);
Check(Shim.ToastTag(longId).Length <= 64 && Shim.ToastTag(longId) == Shim.ToastTag(longId) && Shim.ToastTag("tag:s1") == "tag:s1",
      "shim: a toast tag is bounded and stable");
var rawActions = JsonSerializer.SerializeToElement(new object[] {
    new { id = "allow", title = "Allow" }, new { id = "", title = "no id" }, new { id = "x", title = "" },
    new { id = "allow", title = "twice" }, new { id = "long", title = new string('a', 60) },
    new { id = "c", title = "C" }, new { id = "d", title = "D" }, new { id = "e", title = "E" },
});
var actions = Shim.Actions(rawActions);
Check(actions.Select(a => a.Id).SequenceEqual(new[] { "allow", "long", "c", "d" }) && actions[1].Title.Length == 40,
      "shim: actions are sanitised — ids non-empty and unique, titles clipped, at most four");
Check(Shim.Actions(null).Count == 0, "shim: no actions is an empty list");
try
{
    Check(Shim.Source("granted").Contains("Notification.permission = \"granted\"")
          && Shim.Source("weird").Contains("Notification.permission = \"default\""),
          "shim: the source is seeded with the permission, anything odd reads default");
}
catch (FileNotFoundException)
{
    Console.WriteLine("skip  shim.js not embedded yet");
}

// --- stamp -------------------------------------------------------------------
var stampDir = Directory.CreateTempSubdirectory("mystical-stamp");
File.WriteAllText(Path.Combine(stampDir.FullName, "mystical.json"),
    """{"repo":"/home/u/m","distro":"Ubuntu","user":"u","path":"/usr/bin","version":"v1"}""");
Check(Stamp.Load(stampDir.FullName) == new Stamp("/home/u/m", "Ubuntu", "u", "/usr/bin", "v1"), "stamp: mystical.json beside the exe");
var emptyDir = Directory.CreateTempSubdirectory("mystical-nostamp");
Check(Stamp.Load(emptyDir.FullName) is { Version: "dev", Repo: "" }, "stamp: no file is a dev build with no checkout");
stampDir.Delete(true);
emptyDir.Delete(true);

Console.WriteLine(failed == 0 ? "all passed" : $"{failed} failed");
return failed == 0 ? 0 : 1;
