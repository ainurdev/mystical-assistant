using System.Text.Json;

namespace Mystical.Core;

/// One of the launcher's surfaces: its port, the HTTP status its root answered
/// with (0 when nothing listened) and the URL to open it on.
public sealed record Surface(int Port, int Http, string? Url);

/// What `bin/mystical status --json` prints — the app's only source for the
/// port, the token and whether a bridge is up. Reading it rather than .env keeps
/// one parser of that file (the launcher's), and a rotated token is picked up on
/// the next status instead of going stale in the app.
public sealed record BridgeStatus(bool Running, int? Pid, string? Supervised, string? Log, Surface? Dashboard)
{
    /// Null for anything that isn't the launcher's JSON — a die line, a shell
    /// rc's chatter, an empty answer.
    public static BridgeStatus? Parse(string text)
    {
        try
        {
            using var doc = JsonDocument.Parse(text);
            var root = doc.RootElement;
            if (root.ValueKind != JsonValueKind.Object || !root.TryGetProperty("running", out var running))
                return null;
            Surface? dashboard = null;
            if (root.TryGetProperty("dashboard", out var d) && d.ValueKind == JsonValueKind.Object)
                dashboard = new Surface(Json.Int(d, "port"), Json.Int(d, "http"), Json.Str(d, "url"));
            return new BridgeStatus(running.ValueKind == JsonValueKind.True, Json.NullableInt(root, "pid"),
                                    Json.Str(root, "supervised"), Json.Str(root, "log"), dashboard);
        }
        catch (JsonException)
        {
            return null;
        }
    }

    /// Up and serving: the process is there and the dashboard answered 2xx/3xx.
    public bool Answering => Running && Dashboard is { Http: >= 200 and < 400 };

    /// The dashboard URL with its token — what the window loads.
    public Uri? DashboardUrl =>
        Dashboard?.Url is { } u && Uri.TryCreate(u, UriKind.Absolute, out var uri) ? uri : null;

    /// `http://127.0.0.1:<port>`: in-window navigation stays inside it.
    public Uri? Origin => Dashboard is { } d ? new Uri($"http://127.0.0.1:{d.Port}") : null;
}
