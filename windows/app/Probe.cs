using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace Mystical;

/// Lets an agent look at the app. `windows/probe.sh` sends `{"op":"probe",
/// "dir":"<Windows path>"}` over the pipe and the app writes `<dir>\window.png`
/// — WebView2's own capture of the page, or the placeholder drawn — and
/// `<dir>\state.json`. Read-only: it changes nothing.
public static class Probe
{
    static readonly Regex Rooted = new(@"^([A-Za-z]:\\|\\\\)", RegexOptions.CultureInvariant);
    static readonly JsonSerializerOptions Pretty = new() { WriteIndented = true, Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping };

    public static async Task<JsonNode> Write(string dir, App app)
    {
        if (!Rooted.IsMatch(dir))
            return new JsonObject { ["ok"] = false, ["error"] = "dir must be an absolute Windows path" };
        try
        {
            Directory.CreateDirectory(dir);
            var d = app.Dashboard;
            var b = app.Bridge;
            var state = new JsonObject
            {
                ["visible"] = d.Visible,
                ["page"] = d.PageShowing ? d.PageUrl : null,
                ["placeholder"] = d.PlaceholderText,
                ["up"] = b.Up,
                ["misses"] = b.Misses,
                ["running"] = b.Status?.Running,
                ["supervised"] = b.Status?.Supervised,
                ["waiting"] = new JsonArray(b.Waiting.Select(w => (JsonNode)new JsonObject
                    { ["id"] = w.Id, ["title"] = w.Title, ["label"] = w.Label }).ToArray()),
                ["badge"] = app.Badge,
                ["permission"] = app.Permission,
                ["hotkey"] = app.Prefs.Hotkey,
                ["fullscreen"] = d.FullScreen,
                ["version"] = app.Stamp.Version,
            };
            File.WriteAllText(Path.Combine(dir, "state.json"), state.ToJsonString(Pretty));
            var png = await d.Snapshot();
            if (png is not null) File.WriteAllBytes(Path.Combine(dir, "window.png"), png);
            return new JsonObject { ["ok"] = true, ["png"] = png is not null };
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            return new JsonObject { ["ok"] = false, ["error"] = e.Message };
        }
    }
}
