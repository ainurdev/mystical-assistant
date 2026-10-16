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

    public App(Stamp stamp, Prefs prefs, string dataDir)
    {
        Stamp = stamp;
        Prefs = prefs;
        DataDir = dataDir;
        Ui = new WindowsFormsSynchronizationContext();
        SynchronizationContext.SetSynchronizationContext(Ui);
    }

    /// One pipe request, on the UI thread. The reply node is written back as
    /// one line; `{"ok":false,"error":…}` for anything that can't be done.
    public Task<JsonNode> HandlePipe(JsonElement req)
    {
        var op = req.ValueKind == JsonValueKind.Object && req.TryGetProperty("op", out var o)
                 && o.ValueKind == JsonValueKind.String ? o.GetString() : null;
        switch (op)
        {
            case "show":
            case "hide":
                return Task.FromResult(Ok());
            case "quit":
                // Reply first — the pipe thread writes it once this returns —
                // and leave a beat later, so the client reads its line.
                var later = new System.Windows.Forms.Timer { Interval = 150 };
                later.Tick += (_, _) => { later.Stop(); ExitThread(); };
                later.Start();
                return Task.FromResult(Ok());
            default:
                return Task.FromResult(Error("unknown op"));
        }
    }

    /// A mystical:// link, from the command line or a second instance.
    public void HandleLink(string url) { }

    static JsonNode Ok() => new JsonObject { ["ok"] = true };
    static JsonNode Error(string message) => new JsonObject { ["ok"] = false, ["error"] = message };
}
