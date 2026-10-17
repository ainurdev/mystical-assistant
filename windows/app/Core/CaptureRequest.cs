using System.Text.Json;
using System.Text.RegularExpressions;

namespace Mystical.Core;

/// What windows/capture.sh sends over the pipe: `{"dir": "C:\\abs", "window":
/// "title or app substring"}`. The dir has to be a rooted Windows path — a
/// drive or a UNC share such as `\\wsl.localhost\<distro>\tmp\x`, which is how a
/// WSL path arrives after `wslpath -w` — because the app's cwd is nowhere useful.
public sealed record CaptureRequest(string Dir, string? Window)
{
    static readonly Regex Rooted = new(@"^([A-Za-z]:\\|\\\\)", RegexOptions.CultureInvariant);

    public static CaptureRequest? Parse(JsonElement body)
    {
        var dir = Json.Str(body, "dir");
        if (dir is null || !Rooted.IsMatch(dir)) return null;
        var window = Json.Str(body, "window")?.Trim();
        return new CaptureRequest(dir, string.IsNullOrEmpty(window) ? null : window);
    }

    /// The window a request means: the first whose title or app name contains
    /// the asked text, case-insensitively.
    public static bool Matches(string asked, string? title, string? app) =>
        (title ?? "").Contains(asked, StringComparison.OrdinalIgnoreCase)
        || (app ?? "").Contains(asked, StringComparison.OrdinalIgnoreCase);
}
