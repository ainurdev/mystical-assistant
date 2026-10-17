using System.Text.Json;

namespace Mystical.Core;

/// The WINDOWS APP tab's switches, and the app's own remembered state, in one
/// JSON file (`%LOCALAPPDATA%\Mystical\settings.json`). The app owns the
/// switches: the page reads and writes them over the message handler
/// (`settings` / `set`), so there is one copy — the tray, the hotkey and the
/// panel are right at launch, before any page has loaded, and a reload never
/// resets them. The rest (window bounds, zoom, appearance, panel position) is
/// the app's alone and never reaches the page.
public sealed class Prefs
{
    // The switches (Keys): what the page can set.
    public bool Floating { get; set; }
    public bool TitleFollowsSession { get; set; }
    public bool Hotkey { get; set; } = true;
    // The app's own.
    public bool Light { get; set; }
    public double Zoom { get; set; } = 1;
    public int[]? Window { get; set; }   // x, y, w, h
    public bool Maximized { get; set; }
    public int[]? Panel { get; set; }    // x, y

    public static readonly string[] Keys = { "floating", "titleFollowsSession", "hotkey" };

    static readonly JsonSerializerOptions Options = new() { WriteIndented = true, PropertyNameCaseInsensitive = true };

    /// A missing or unreadable file is the defaults, never a crash.
    public static Prefs Load(string path)
    {
        try
        {
            return JsonSerializer.Deserialize<Prefs>(File.ReadAllText(path), Options) ?? new Prefs();
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException or JsonException)
        {
            return new Prefs();
        }
    }

    public void Save(string path)
    {
        var dir = Path.GetDirectoryName(path);
        if (!string.IsNullOrEmpty(dir)) Directory.CreateDirectory(dir);
        File.WriteAllText(path, JsonSerializer.Serialize(this, Options));
    }

    /// Applies one `set` from the page. False = not a setting.
    public bool Set(string key, bool value)
    {
        switch (key)
        {
            case "floating": Floating = value; return true;
            case "titleFollowsSession": TitleFollowsSession = value; return true;
            case "hotkey": Hotkey = value; return true;
            default: return false;
        }
    }

    /// What the page gets back from `settings` and `set`: the switches, the
    /// app's version and the platform — no `keepInDock`, which is the Mac's.
    public Dictionary<string, object> Dict(string version) => new()
    {
        ["floating"] = Floating,
        ["titleFollowsSession"] = TitleFollowsSession,
        ["hotkey"] = Hotkey,
        ["version"] = version,
        ["platform"] = "windows",
    };
}
