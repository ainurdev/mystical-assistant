using System.Text.RegularExpressions;

namespace Mystical.Core;

/// A `mystical://` link — the scheme build.sh registers for the exe. Two forms:
///
///     mystical://session/<id>      open that session, the way the tray does
///     mystical://open[?s=<id>]     show the window (on a session, if one is named)
///
/// A link opens things and nothing else — never start, stop or restart: any page
/// can point at a scheme, so the worst a link can do is bring the window up.
/// `SessionId` null means just the window; a null result means not ours.
public sealed record DeepLink(string? SessionId)
{
    // Not System.Uri: it refuses `mystical://` with no host, which is a valid
    // "open the window" here.
    static readonly Regex Link = new(@"^mystical://([^/?#]*)(?:/([^?#]*))?(?:\?([^#]*))?(?:#.*)?$",
                                     RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);

    public static DeepLink? Parse(string url)
    {
        var m = Link.Match(url.Trim());
        if (!m.Success) return null;
        var host = m.Groups[1].Value.ToLowerInvariant();
        var path = m.Groups[2].Value;
        var asked = m.Groups[3].Value.Split('&', StringSplitOptions.RemoveEmptyEntries)
            .Select(p => p.Split('=', 2))
            .Where(kv => kv[0] == "s")
            .Select(kv => kv.Length > 1 ? Uri.UnescapeDataString(kv[1]) : "")
            .FirstOrDefault() ?? "";
        switch (host)
        {
            case "":
            case "open":
                return new DeepLink(asked.Length == 0 ? null : asked);
            case "session":
                var first = path.Split('/', StringSplitOptions.RemoveEmptyEntries).FirstOrDefault() ?? "";
                var id = Uri.UnescapeDataString(first);
                return new DeepLink(id.Length == 0 ? null : id);
            default:
                return null;
        }
    }
}
