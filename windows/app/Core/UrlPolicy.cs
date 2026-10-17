namespace Mystical.Core;

/// Where a navigation goes. The window is the dashboard and nothing else: a link
/// to GitHub, a PR or a preview tunnel opens in the default browser, where it
/// has your logins and tabs, instead of replacing the dashboard in place.
public enum NavigationTarget { InView, Browser, Ignore }

public static class UrlPolicy
{
    static readonly string[] Opaque = { "about", "blob", "data", "javascript" };
    static readonly string[] Outbound = { "http", "https", "mailto" };
    static readonly string[] LinkItems = { "s", "skipboot" };
    public const string AppName = "mystical//assistant";

    /// - mainFrame: false for iframes — the preview pane frames a dev server on
    ///   another port, and that has to load where it is.
    /// - newWindow: `target=_blank` / `window.open` — never a second web view.
    public static NavigationTarget Decide(Uri? url, Uri? origin, bool mainFrame, bool newWindow)
    {
        if (url is null) return NavigationTarget.Ignore;
        var scheme = url.Scheme.ToLowerInvariant();
        if (Opaque.Contains(scheme)) return newWindow ? NavigationTarget.Ignore : NavigationTarget.InView;
        if (newWindow) return Outbound.Contains(scheme) ? NavigationTarget.Browser : NavigationTarget.Ignore;
        if (!mainFrame) return NavigationTarget.InView;
        if (SameOrigin(url, origin)) return NavigationTarget.InView;
        return Outbound.Contains(scheme) ? NavigationTarget.Browser : NavigationTarget.Ignore;
    }

    /// 127.0.0.1, localhost and [::1] are the same dashboard (the server's Host
    /// allow-list takes all three); the port has to match.
    public static bool SameOrigin(Uri url, Uri? origin)
    {
        if (origin is null || url.Scheme != "http" || url.Port != origin.Port) return false;
        return url.Host is "127.0.0.1" or "localhost" or "::1" or "[::1]";
    }

    /// The dashboard opened on one session: `?s=` is the dashboard's own deep
    /// link (App.tsx), `skipboot` skips the intro a reload would replay.
    public static Uri Session(Uri dashboard, string sessionId)
    {
        var items = Items(dashboard).Where(kv => !LinkItems.Contains(kv.Key)).ToList();
        items.Add(("s", Uri.EscapeDataString(sessionId)));
        items.Add(("skipboot", null));
        var b = new UriBuilder(dashboard)
        {
            Query = string.Join("&", items.Select(kv => kv.Value is null ? kv.Key : $"{kv.Key}={kv.Value}")),
        };
        return b.Uri;
    }

    /// Whether the page loaded from `loaded` is still the dashboard at `current`:
    /// same port and token. A `Session` link to it counts — reloading that
    /// would replay the intro the link skipped.
    public static bool SameDashboard(Uri? loaded, Uri current)
    {
        if (loaded is null) return false;
        static List<(string Key, string? Value)> Rest(Uri u) =>
            Items(u).Where(kv => !LinkItems.Contains(kv.Key)).ToList();
        return loaded.Port == current.Port && Rest(loaded).SequenceEqual(Rest(current));
    }

    /// The window title from the page's: an older dist's " — dashboard" suffix
    /// dropped, the app's own name when the page has none.
    public static string Title(string? pageTitle)
    {
        var t = (pageTitle ?? "").Replace(" — dashboard", "").Trim();
        return t.Length == 0 ? AppName : t;
    }

    /// The query as (key, raw value) pairs, a bare key's value null.
    static List<(string Key, string? Value)> Items(Uri u)
    {
        var q = u.Query.TrimStart('?');
        if (q.Length == 0) return new();
        return q.Split('&', StringSplitOptions.RemoveEmptyEntries).Select(part =>
        {
            var i = part.IndexOf('=');
            return i < 0 ? (part, (string?)null) : (part[..i], part[(i + 1)..]);
        }).ToList();
    }
}
