using System.Text.Json;

namespace Mystical.Core;

/// One session blocked on you — a row in the tray's "Waiting on you".
public sealed record WaitingSession(string Id, string Title, string Label);

/// Reads `GET /local/running` — the same status map both web surfaces render
/// from (bridge/runner.py `_build_status`). Only `state == "awaiting"` counts:
/// a question or a permission card, or a turn that ended on a question.
public static class Running
{
    const string Fallback = "waiting on you";

    /// Null when the text isn't the map at all. Titles come from `jobs[].title`,
    /// then the label, then "waiting on you"; sorted by title, then id.
    public static IReadOnlyList<WaitingSession>? Waiting(string json)
    {
        JsonDocument doc;
        try { doc = JsonDocument.Parse(json); }
        catch (JsonException) { return null; }
        using (doc)
        {
            var root = doc.RootElement;
            if (root.ValueKind != JsonValueKind.Object) return null;
            var titles = new Dictionary<string, string>();
            if (root.TryGetProperty("jobs", out var jobs) && jobs.ValueKind == JsonValueKind.Array)
                foreach (var job in jobs.EnumerateArray())
                {
                    var sid = Json.Str(job, "session_id");
                    var title = Json.Str(job, "title");
                    if (!string.IsNullOrEmpty(sid) && !string.IsNullOrEmpty(title)) titles[sid] = title;
                }
            var rows = new List<WaitingSession>();
            foreach (var (sid, st) in Status(root))
            {
                if (Json.Str(st, "state") != "awaiting") continue;
                var label = Json.Str(st, "label") is { Length: > 0 } l ? l : Fallback;
                rows.Add(new WaitingSession(sid, titles.GetValueOrDefault(sid) ?? label, label));
            }
            return rows.OrderBy(w => w.Title, StringComparer.Ordinal).ThenBy(w => w.Id, StringComparer.Ordinal).ToList();
        }
    }

    /// Sessions mid-turn, from every source — a terminal session working is as
    /// busy as a bridge one. Drives the tray's tooltip.
    public static int Working(string json)
    {
        try
        {
            using var doc = JsonDocument.Parse(json);
            return Status(doc.RootElement).Count(kv => Json.Str(kv.State, "state") == "working");
        }
        catch (JsonException)
        {
            return 0;
        }
    }

    static IEnumerable<(string Id, JsonElement State)> Status(JsonElement root)
    {
        if (root.ValueKind != JsonValueKind.Object || !root.TryGetProperty("status", out var status)
            || status.ValueKind != JsonValueKind.Object)
            yield break;
        foreach (var p in status.EnumerateObject())
            if (p.Value.ValueKind == JsonValueKind.Object) yield return (p.Name, p.Value);
    }
}
