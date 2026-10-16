using System.Text.Json;
using System.Text.Json.Nodes;
using Mystical.Core;

namespace Mystical;

/// The app — what AppDelegate is on the Mac. Owns the pieces (bridge, window,
/// notifier, tray, panel), the pipe's handlers and the link handler. An
/// ApplicationContext rather than a form, so the process outlives any one
/// window: the dashboard hides on close, and the tray's Quit ends the run.
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
    /// The tray's count, for the probe (Task 6 sets it).
    public string? Badge { get; private set; }
    /// The web permission the shim is seeded with.
    public string Permission => Notifier.Permission;
    bool busy;

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
        Notifier.Clicked += Dashboard.NotificationClicked;
        Notifier.ActionTapped += Dashboard.NotificationAction;
        Notifier.AppearanceChanged += Dashboard.ApplyAppearance;
        Bridge.Changed += Dashboard.Sync;
        Dashboard.StartRequested += () => Lifecycle("start");
        Bridge.Start();
        // Launched at login by the Startup entry, or by hand: either way, show it.
        Dashboard.ShowDashboard();
    }

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
            case "probe":
                return await Probe.Write(Str(req, "dir") ?? "", this);
            case "eval":
                // A driver for checks: the JSON text of the expression's value.
                var result = await Dashboard.Eval(Str(req, "js") ?? "");
                return result is null ? Error("no page") : new JsonObject { ["ok"] = true, ["result"] = result };
            case "quit":
                // Reply first — the pipe thread writes it once this returns —
                // and leave a beat later, so the client reads its line.
                var later = new System.Windows.Forms.Timer { Interval = 150 };
                later.Tick += (_, _) => { later.Stop(); ExitThread(); };
                later.Start();
                return Ok();
            default:
                return Error("unknown op");
        }
    }

    /// A mystical:// link, from the command line or a second instance.
    public void HandleLink(string url) { }

    /// start / stop / restart through `bin/mystical`; a failure's output in a box.
    public void Lifecycle(string verb) => _ = LifecycleAsync(verb);

    async Task LifecycleAsync(string verb)
    {
        if (busy) return;
        busy = true;
        try
        {
            var failure = await Bridge.Lifecycle(verb);
            if (failure is not null) Alert($"mystical {verb} failed", failure.Length > 1500 ? failure[^1500..] : failure);
        }
        finally
        {
            busy = false;
            Dashboard.Sync();
        }
    }

    static void Alert(string title, string text) =>
        MessageBox.Show(text, title, MessageBoxButtons.OK, MessageBoxIcon.Warning);

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
