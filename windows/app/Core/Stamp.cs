using System.Text.Json;

namespace Mystical.Core;

/// What build.sh writes beside the exe as mystical.json — the Windows twin of the
/// Mac bundle's Info.plist keys: the checkout the app was built from (`Repo`, a
/// WSL path), the distro and user that checkout lives under, the building
/// shell's PATH (`wsl.exe -e` hands a command a bare one), and the build's
/// `git describe`. Rebuild from the checkout you run, after moving it or
/// changing your PATH.
public sealed record Stamp(string Repo, string Distro, string User, string Path, string Version)
{
    /// No file, or no key: empty strings and a "dev" version — the app then
    /// shows the *can't find the checkout* placeholder rather than guessing.
    public static Stamp Load(string dir)
    {
        try
        {
            using var doc = JsonDocument.Parse(File.ReadAllText(System.IO.Path.Combine(dir, "mystical.json")));
            var r = doc.RootElement;
            return new Stamp(Json.Str(r, "repo") ?? "", Json.Str(r, "distro") ?? "", Json.Str(r, "user") ?? "",
                             Json.Str(r, "path") ?? "", Json.Str(r, "version") ?? "dev");
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException or JsonException)
        {
            return new Stamp("", "", "", "", "dev");
        }
    }
}
