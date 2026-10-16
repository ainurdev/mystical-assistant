using System.Diagnostics;
using System.Text.Json;
using System.Text.Json.Nodes;
using Mystical.Core;

namespace Mystical;

/// The app — what AppDelegate is on the Mac. Owns the pieces (bridge, window,
/// notifier, tray, panel), the tray's menu, the pipe's handlers and the link
/// handler. An ApplicationContext rather than a form, so the process outlives
/// any one window: the dashboard hides on close, and the tray's Quit ends the run.
public sealed class App : ApplicationContext
{
    public Stamp Stamp { get; }
    public Prefs Prefs { get; }
    public string DataDir { get; }
    /// The UI thread, for the pipe thread's requests.
    public SynchronizationContext Ui { get; }
    public Bridge Bridge { get; }
    public Notifier Notifier { get; }
    public DashboardForm Dashboard { get; }
    public Tray Tray { get; }
    public FloatingPanel Panel { get; }
    /// A lifecycle verb in flight; a rebuild in flight.
    public bool Busy { get; private set; }
    public bool Rebuilding { get; private set; }
    /// The tray's count, for the probe.
    public string? Badge => Tray.Badge;
    /// The web permission the shim is seeded with.
    public string Permission => Notifier.Permission;

    public App(Stamp stamp, Prefs prefs, string dataDir)
    {
        Stamp = stamp;
        Prefs = prefs;
        DataDir = dataDir;
        // Who we are to the taskbar and the notification center, before any window.
        Notifier.EnsureAumid(Path.Combine(AppContext.BaseDirectory, "icon.png"));
        Notifier.SetProcessAumid();
        Ui = new WindowsFormsSynchronizationContext();
        SynchronizationContext.SetSynchronizationContext(Ui);
        var prefsPath = Path.Combine(dataDir, "settings.json");
        Bridge = new Bridge(stamp, dataDir);
        Notifier = new Notifier(prefs, prefsPath, stamp.Version);
        Dashboard = new DashboardForm(Bridge, prefs, prefsPath);
        // The shim goes in before the first navigation; the permission it was
        // seeded with is corrected after each load.
        Dashboard.OnCoreReady = async core =>
        {
            await core.AddScriptToExecuteOnDocumentCreatedAsync(Shim.Source(Notifier.Permission));
            Notifier.Attach(core);
        };
        Dashboard.OnPageLoaded = async () =>
        {
            var p = Notifier.RefreshPermission();
            await Dashboard.Eval($"window.__mysticalSetPermission?.('{p}')");
        };
        Panel = new FloatingPanel(Dashboard.Open, prefs, prefsPath);
        Tray = new Tray(FillMenu, Dashboard.ShowDashboard);
        Notifier.Clicked += Dashboard.NotificationClicked;
        Notifier.ActionTapped += Dashboard.NotificationAction;
        Notifier.AppearanceChanged += Dashboard.ApplyAppearance;
        Notifier.PrefsChanged += _ => { ApplyHotkey(); SyncFloating(); };
        Notifier.RebuildRequested += RebuildApp;
        Bridge.Changed += BridgeChanged;
        Dashboard.StartRequested += () => Lifecycle("start");
        // The panel yields to the dashboard: gone while it's in front, back when it isn't.
        Dashboard.VisibilityChanged += _ => SyncFloating();
        Dashboard.Activated += (_, _) => SyncFloating();
        Dashboard.Deactivate += (_, _) => SyncFloating();
        Bridge.Start();
        // Launched at login by the Startup entry, or by hand: either way, show it.
        Dashboard.ShowDashboard();
        ApplyHotkey();
    }

    void ApplyHotkey()
    {
        if (!Dashboard.SetHotkey(Prefs.Hotkey))
            Tray.Balloon("Win+Ctrl+A is taken", "Another app holds the shortcut; the switch stays on.");
    }

    void BridgeChanged()
    {
        Dashboard.Sync();
        Tray.Update(Bridge.Waiting.Count, Bridge.Working, Bridge.Up);
        SyncFloating();
    }

    void SyncFloating()
    {
        var inFront = Dashboard.Visible && Dashboard.WindowState != FormWindowState.Minimized && Form.ActiveForm == Dashboard;
        Panel.Sync(Bridge.Waiting, Prefs.Floating, inFront);
    }

    // MARK: the tray menu — rebuilt each time it opens, from the latest poll

    public string StateLine()
    {
        if (Rebuilding) return "● rebuilding the app…";
        if (Busy) return "● working…";
        var s = Bridge.Status;
        if (s is null) return Bridge.RepoMissing ? "● checkout not found — rebuild: mystical app" : "● checking…";
        if (!s.Running) return "○ bridge stopped";
        if (!Bridge.Up) return "◌ bridge starting…";
        var sup = s.Supervised switch { null => "", "hand-launched" => " · not supervised", var name => " · " + name };
        return "● bridge running" + sup;
    }

    void FillMenu(ContextMenuStrip menu)
    {
        // Supervision can change under us (the SYSTEM tab, a terminal); re-read
        // it for the next open rather than block this one on wsl.exe.
        if (!Busy) _ = Bridge.RefreshStatus();
        menu.Items.Add(Disabled(StateLine()));
        if (Bridge.Waiting.Count > 0)
        {
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add(Disabled("Waiting on you"));
            foreach (var w in Bridge.Waiting)
            {
                var row = new ToolStripMenuItem("    " + w.Title) { ToolTipText = w.Label, Tag = w.Id };
                row.Click += (s, _) => Dashboard.Open((string)((ToolStripMenuItem)s!).Tag!);
                menu.Items.Add(row);
            }
        }
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add(Item("Open Dashboard", Dashboard.ShowDashboard));
        menu.Items.Add(Item("Open in Browser", OpenInBrowser, Bridge.Up));
        menu.Items.Add(new ToolStripSeparator());
        var running = Bridge.Status?.Running == true;
        menu.Items.Add(Item("Start Bridge", () => Lifecycle("start"), !running && !Busy));
        menu.Items.Add(Item("Stop Bridge", () => Lifecycle("stop"), running && !Busy));
        menu.Items.Add(Item("Restart Bridge", () => Lifecycle("restart"), running && !Busy));
        menu.Items.Add(Item("Show Log", ShowLog, Bridge.Status?.Log is not null));
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add(Disabled($"Mystical {Stamp.Version}"));
        menu.Items.Add(Item("Rebuild App", RebuildApp, !Rebuilding && !Bridge.RepoMissing));
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add(Item("Quit Mystical", Quit));
    }

    static ToolStripMenuItem Disabled(string text) => new(text) { Enabled = false };

    static ToolStripMenuItem Item(string text, Action action, bool enabled = true)
    {
        var i = new ToolStripMenuItem(text) { Enabled = enabled };
        i.Click += (_, _) => action();
        return i;
    }

    void OpenInBrowser()
    {
        if (Bridge.Status?.DashboardUrl is not { } url) return;
        try { Process.Start(new ProcessStartInfo(url.ToString()) { UseShellExecute = true }); }
        catch (Exception) { }
    }

    /// A console tailing the bridge's log — `mystical logs`, in a window.
    void ShowLog()
    {
        if (Bridge.Status?.Log is not { } log) return;
        var psi = new ProcessStartInfo("wsl.exe") { UseShellExecute = true };
        foreach (var a in new[] { "-d", Stamp.Distro, "-u", Stamp.User, "-e", "tail", "-n", "200", "-f", log }) psi.ArgumentList.Add(a);
        try { Process.Start(psi); }
        catch (Exception) { }
    }

    void Quit()
    {
        Tray.Dispose();
        Panel.Close();
        ExitThread();
    }

    // MARK: the pipe, links, lifecycle

    /// One pipe request, on the UI thread. The reply node is written back as
    /// one line; `{"ok":false,"error":…}` for anything that can't be done.
    public async Task<JsonNode> HandlePipe(JsonElement req)
    {
        var op = Str(req, "op");
        switch (op)
        {
            case "show":
                Dashboard.ShowDashboard();
                return Ok();
            case "hide":
                Dashboard.HideDashboard();
                return Ok();
            case "open":
                HandleLink(Str(req, "url") ?? "");
                return Ok();
            case "probe":
                return await Probe.Write(Str(req, "dir") ?? "", this);
            case "capture":
                return CaptureRequest.Parse(req) is { } capture ? Capture.Run(capture) : Error("dir must be an absolute Windows path");
            case "eval":
                // A driver for checks: the JSON text of the expression's value.
                var result = await Dashboard.Eval(Str(req, "js") ?? "");
                return result is null ? Error("no page") : new JsonObject { ["ok"] = true, ["result"] = result };
            case "quit":
                // Reply first — the pipe thread writes it once this returns —
                // and leave a beat later, so the client reads its line.
                var later = new System.Windows.Forms.Timer { Interval = 150 };
                later.Tick += (_, _) => { later.Stop(); Quit(); };
                later.Start();
                return Ok();
            default:
                return Error("unknown op");
        }
    }

    /// A mystical:// link, from the command line or a second instance: it
    /// opens things and nothing else (DeepLink).
    public void HandleLink(string url)
    {
        if (DeepLink.Parse(url) is not { } link) return;
        if (link.SessionId is { } id) Dashboard.Open(id);
        else Dashboard.ShowDashboard();
    }

    /// start / stop / restart through `bin/mystical`; a failure's output in a box.
    public void Lifecycle(string verb) => _ = LifecycleAsync(verb);

    async Task LifecycleAsync(string verb)
    {
        if (Busy) return;
        Busy = true;
        try
        {
            var failure = await Bridge.Lifecycle(verb);
            if (failure is not null) Alert($"mystical {verb} failed", failure.Length > 1500 ? failure[^1500..] : failure);
        }
        finally
        {
            Busy = false;
            BridgeChanged();
        }
    }

    /// `mystical app`. A success quits and reopens us from build.sh, so `done`
    /// only ever reports a failure (or a build with nothing to swap).
    public void RebuildApp()
    {
        if (Rebuilding) return;
        Rebuilding = true;
        var log = Bridge.RebuildApp((code, tail) =>
        {
            Rebuilding = false;
            if (code != 0) Alert("mystical app failed", tail.Length > 0 ? tail : $"exit {code} — see {Bridge.RebuildLog}");
        });
        if (log is null)
        {
            Rebuilding = false;
            Alert("mystical app", $"couldn't start the build — is the checkout still at {Stamp.Repo}?");
        }
    }

    static void Alert(string title, string text)
    {
        Log($"{title}: {text.ReplaceLineEndings(" ")}");
        MessageBox.Show(text, title, MessageBoxButtons.OK, MessageBoxIcon.Warning);
    }

    static string? logPath;
    /// One line into %LOCALAPPDATA%\Mystical\app.log — what happened to a toast,
    /// a lifecycle call that failed; the probe's state.json is the rest.
    public static void Log(string line)
    {
        try
        {
            logPath ??= Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Mystical", "app.log");
            File.AppendAllText(logPath, $"{DateTime.Now:yyyy-MM-dd HH:mm:ss} {line}\n");
        }
        catch (Exception) { }
    }

    static string? Str(JsonElement o, string name) =>
        o.ValueKind == JsonValueKind.Object && o.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String
            ? v.GetString() : null;

    static JsonNode Ok() => new JsonObject { ["ok"] = true };
    static JsonNode Error(string message) => new JsonObject { ["ok"] = false, ["error"] = message };
}
