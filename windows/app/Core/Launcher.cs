namespace Mystical.Core;

/// How long `bin/mystical <verb>` may run through wsl.exe before the app gives
/// up on it. `status --json` is a quick read. A lifecycle verb is not:
/// `mystical start` rebuilds any stale web bundle first (a minute or more after
/// a pull), and killing wsl.exe mid-build would leave the dashboard unserved —
/// so start, stop and restart get ten minutes, and the timeout is a safety
/// net, not a budget.
public static class Launcher
{
    public static int TimeoutSeconds(string verb) => verb == "status" ? 30 : 600;
}
