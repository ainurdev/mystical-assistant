using System.Text.Json;

namespace Mystical.Core;

/// Tolerant reads off a JsonElement: a missing key, the wrong kind, or a
/// non-object all read as "not there", never as a throw — the bridge's JSON is
/// trusted for shape, not relied on for it.
internal static class Json
{
    public static string? Str(JsonElement o, string name) =>
        o.ValueKind == JsonValueKind.Object && o.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String
            ? v.GetString() : null;

    public static int? NullableInt(JsonElement o, string name) =>
        o.ValueKind == JsonValueKind.Object && o.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.Number
        && v.TryGetInt32(out var i) ? i : null;

    public static int Int(JsonElement o, string name) => NullableInt(o, name) ?? 0;

    public static bool Bool(JsonElement o, string name) =>
        o.ValueKind == JsonValueKind.Object && o.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.True;
}
