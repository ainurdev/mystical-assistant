using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Mystical.Core;

namespace Mystical;

/// Mystical.exe runs the app; with a `mystical://` argument it opens that link
/// in the running instance (or starts one). The `--` forms are pipe clients for
/// the WSL side — windows/probe.sh and capture.sh — and for build.sh's swap:
///
///     --probe <dir>                 window.png + state.json into dir
///     --capture <dir> [-w <text>]   capture.png + capture.json into dir
///     --eval <js>                   run JS in the page, print the result
///     --show | --hide | --quit
///
/// They print the reply line and exit 0 when it says ok, 1 when it doesn't,
/// 2 when no instance answers. No nib, no designer: everything is built in code.
static class Program
{
    [STAThread]
    static int Main(string[] args)
    {
        if (args.Length > 0 && args[0].StartsWith("--")) return Client(args);
        var link = args.FirstOrDefault(a => a.StartsWith("mystical://", StringComparison.OrdinalIgnoreCase));
        using var mutex = new Mutex(true, @"Local\mystical-app", out var fresh);
        if (!fresh)
        {
            // Another instance owns the window: hand it the link, or just raise it.
            Pipe.Send(link is null ? """{"op":"show"}""" : new JsonObject { ["op"] = "open", ["url"] = link }.ToJsonString());
            return 0;
        }
        // The PowerShell tray's mutex too: a Startup entry that still starts
        // tray.ps1 gets a tray that exits at once, so there is never a second icon.
        using var trayMutex = new Mutex(true, @"Local\mystical-tray", out _);

        ApplicationConfiguration.Initialize();
        var stamp = Stamp.Load(AppContext.BaseDirectory);
        var dataDir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Mystical");
        Directory.CreateDirectory(dataDir);
        var prefs = Prefs.Load(Path.Combine(dataDir, "settings.json"));
        var app = new App(stamp, prefs, dataDir);
        using var serving = new CancellationTokenSource();
        Pipe.Serve(app.HandlePipe, app.Ui, serving.Token);
        if (link is not null) app.Ui.Post(_ => app.HandleLink(link), null);
        Application.Run(app);
        serving.Cancel();
        return 0;
    }

    static int Client(string[] args)
    {
        JsonObject req;
        switch (args[0])
        {
            case "--quit": req = new JsonObject { ["op"] = "quit" }; break;
            case "--show": req = new JsonObject { ["op"] = "show" }; break;
            case "--hide": req = new JsonObject { ["op"] = "hide" }; break;
            case "--probe":
                if (args.Length < 2) return Usage();
                req = new JsonObject { ["op"] = "probe", ["dir"] = args[1] };
                break;
            case "--capture":
                if (args.Length < 2) return Usage();
                req = new JsonObject { ["op"] = "capture", ["dir"] = args[1] };
                var w = Array.IndexOf(args, "-w");
                if (w >= 0 && w + 1 < args.Length) req["window"] = args[w + 1];
                break;
            case "--eval":
                if (args.Length < 2) return Usage();
                req = new JsonObject { ["op"] = "eval", ["js"] = args[1] };
                break;
            default:
                return Usage();
        }
        var reply = Pipe.Send(req.ToJsonString());
        if (reply is null)
        {
            Say("Mystical is not running — open it first: mystical app open");
            return 2;
        }
        Say(reply);
        try
        {
            using var doc = JsonDocument.Parse(reply);
            return doc.RootElement.TryGetProperty("ok", out var ok) && ok.ValueKind == JsonValueKind.True ? 0 : 1;
        }
        catch (JsonException)
        {
            return 1;
        }
    }

    /// A WinExe may have no stdout at all; when it does (interop hands it a
    /// pipe), the reply goes there as UTF-8 bytes — Console.Out would use the
    /// OEM code page and mangle a title's dash.
    static void Say(string line)
    {
        try
        {
            using var stdout = Console.OpenStandardOutput();
            stdout.Write(Encoding.UTF8.GetBytes(line + "\n"));
            stdout.Flush();
        }
        catch (IOException) { }
    }

    static int Usage()
    {
        Say("usage: Mystical.exe [mystical://…] | --probe <dir> | --capture <dir> [-w <text>] | --eval <js> | --show | --hide | --quit");
        return 2;
    }
}
