using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace Mystical.Core;

/// `window.Notification` for a page that has none it can keep.
///
/// WebView2 does expose the Notification API, but not the one thing the dashboard
/// wants from a native shell: buttons on the banner (`actions`, which browsers
/// keep for service workers). The dashboard's own rules for when to notify
/// (lib/push.ts + the transitions in App.tsx) are the ones worth keeping, so
/// instead of re-implementing them natively, shim.js gives the page the API it
/// already calls — the same shim as the Mac app's, over `chrome.webview` — and
/// the app turns each call into a Windows toast. Because the window only hides
/// on close, the page, and so the rules, keep running.
///
/// The page talks to the app through one handler named `HandlerName`; every
/// message is `{op, ...}` and every reply is routed back by id (Notifier).
public static class Shim
{
    public const string HandlerName = "mysticalNotify";

    /// One button on a toast, as the page sent it.
    public sealed record Action(string Id, string Title);

    /// Web permission strings from `ToastNotifier.Setting`: Enabled (0) is
    /// granted; every Disabled* value is denied. Windows never prompts.
    public static string Permission(int toastSetting) => toastSetting == 0 ? "granted" : "denied";

    /// The notification's identifier: its tag, so a session that pings again
    /// replaces its own toast the way a browser collapses a tag.
    public static string Identifier(string? tag, string fallback) =>
        string.IsNullOrEmpty(tag) ? fallback : "tag:" + tag;

    /// A toast's Tag is capped at 64 characters by Windows; a longer id becomes
    /// a stable hash, so a repeat still replaces its own toast.
    public static string ToastTag(string id)
    {
        if (id.Length <= 64) return id;
        return "h:" + Convert.ToHexString(SHA1.HashData(Encoding.UTF8.GetBytes(id))).ToLowerInvariant();
    }

    /// The `actions` of a `show` message, made safe for a toast: ids and titles
    /// non-empty, ids unique, titles clipped, at most four (what the page's
    /// banner builds, lib/banner.ts).
    public static IReadOnlyList<Action> Actions(JsonElement? raw)
    {
        var list = new List<Action>();
        if (raw is not { ValueKind: JsonValueKind.Array } arr) return list;
        var seen = new HashSet<string>();
        foreach (var item in arr.EnumerateArray())
        {
            var id = Json.Str(item, "id")?.Trim();
            var title = Json.Str(item, "title")?.Trim();
            if (string.IsNullOrEmpty(id) || string.IsNullOrEmpty(title) || !seen.Add(id)) continue;
            if (title.Length > 40) title = title[..39] + "…";
            list.Add(new Action(id, title));
            if (list.Count == 4) break;
        }
        return list;
    }

    /// shim.js, seeded with the permission the page should start from.
    public static string Source(string permission)
    {
        using var stream = typeof(Shim).Assembly.GetManifestResourceStream("shim.js")
            ?? throw new FileNotFoundException("shim.js is not embedded in this build");
        using var reader = new StreamReader(stream, Encoding.UTF8);
        var p = permission is "granted" or "denied" ? permission : "default";
        return reader.ReadToEnd().Replace("__PERMISSION__", p);
    }
}
