using System.Diagnostics;
using System.Text;
using Mystical.Core;

namespace Mystical;

/// The app's only line to the bridge: `bin/mystical` through wsl.exe for
/// lifecycle and status, one HTTP GET for the live session map. No lifecycle
/// logic lives here — start, stop and restart mean exactly what they mean in a
/// WSL terminal, systemd handover included, because they are the same script.
///
/// `wsl.exe -d <distro> -u <user> -e env PATH=<path> <repo>/bin/mystical …`:
/// `-e` and `env`, not a login shell, so stdout is the launcher's and nothing a
/// shell rc prints; the PATH is the one the app was built with (Stamp), the way
/// the Mac bundle pins MysticalPath. The poll goes to 127.0.0.1 — Windows
/// forwards localhost into WSL in NAT and mirrored networking alike.
public sealed class Bridge
{
    public Stamp Stamp { get; }
    public BridgeStatus? Status { get; private set; }
    public IReadOnlyList<WaitingSession> Waiting { get; private set; } = Array.Empty<WaitingSession>();
    /// Sessions mid-turn, every source — the tray's tooltip.
    public int Working { get; private set; }
    /// Consecutive failed polls — one blip (a restart's first second) is not "down".
    public int Misses { get; private set; }
    public event Action? Changed;

    public bool Up => Misses == 0 && Status?.Answering == true;
    public string Launcher => Stamp.Repo + "/bin/mystical";
    /// The checkout this app was built from is not where the share says it is:
    /// moved, or the distro is gone.
    public bool RepoMissing => Stamp.Repo.Length == 0 || Stamp.Distro.Length == 0 || !File.Exists(Unc(Launcher));

    static readonly HttpClient Http = new() { Timeout = TimeSpan.FromSeconds(2.5) };
    readonly string dataDir;
    readonly System.Windows.Forms.Timer timer = new() { Interval = 3000 };
    DateTime lastStatusCheck = DateTime.MinValue;
    bool polling;

    public Bridge(Stamp stamp, string dataDir)
    {
        Stamp = stamp;
        this.dataDir = dataDir;
        timer.Tick += async (_, _) => await Poll();
    }

    /// A WSL path as Windows sees it: `/home/u/x` → `\\wsl.localhost\<distro>\home\u\x`.
    public string Unc(string wslPath) => $@"\\wsl.localhost\{Stamp.Distro}" + wslPath.Replace('/', '\\');

    public void Start()
    {
        _ = Kick();
        timer.Start();     // the dashboard's own cadence for the same map
    }

    async Task Kick()
    {
        await RefreshStatus();
        await Poll();
    }

    /// `mystical status --json`. Cheap enough to re-run every ~10 s while the
    /// bridge is down (to tell "stopped" from "starting"), and on every failure
    /// edge so a rotated token or moved port is picked up.
    public async Task RefreshStatus()
    {
        lastStatusCheck = DateTime.UtcNow;
        if (RepoMissing)
        {
            Status = null;
            Changed?.Invoke();
            return;
        }
        var (_, stdout, _) = await RunSplit("status", "--json");
        Status = BridgeStatus.Parse(stdout);
        Changed?.Invoke();
    }

    async Task Poll()
    {
        if (polling) return;     // a slow wsl.exe must not stack polls
        polling = true;
        try
        {
            var port = Status?.Dashboard?.Port ?? 8790;
            var wasUp = Up;
            string? body = null;
            try
            {
                using var resp = await Http.GetAsync($"http://127.0.0.1:{port}/local/running");
                if (resp.IsSuccessStatusCode) body = await resp.Content.ReadAsStringAsync();
            }
            catch (Exception e) when (e is HttpRequestException or TaskCanceledException) { }
            var waiting = body is null ? null : Running.Waiting(body);
            if (waiting is not null)
            {
                Waiting = waiting;
                Working = Running.Working(body!);
                Misses = 0;
                // Back from down: re-read status (new pid, maybe a new token).
                if (!wasUp || Status?.Answering != true) { await RefreshStatus(); return; }
            }
            else
            {
                Misses++;
                Waiting = Array.Empty<WaitingSession>();
                Working = 0;
                if (Misses == 1 || (DateTime.UtcNow - lastStatusCheck).TotalSeconds > 10)
                {
                    await RefreshStatus();
                    return;
                }
            }
            Changed?.Invoke();
        }
        finally
        {
            polling = false;
        }
    }

    /// Runs `bin/mystical <args>` and returns (exit code, stdout + stderr).
    public async Task<(int Code, string Output)> Run(params string[] args)
    {
        var (code, stdout, stderr) = await RunSplit(args);
        return (code, stdout + stderr);
    }

    ProcessStartInfo Wsl(IEnumerable<string> args, bool capture)
    {
        var psi = new ProcessStartInfo("wsl.exe") { UseShellExecute = false, CreateNoWindow = true };
        if (capture)
        {
            psi.RedirectStandardOutput = psi.RedirectStandardError = true;
            psi.StandardOutputEncoding = psi.StandardErrorEncoding = Encoding.UTF8;
        }
        foreach (var a in new[] { "-d", Stamp.Distro, "-u", Stamp.User, "-e", "env", $"PATH={Stamp.Path}" }.Concat(args))
            psi.ArgumentList.Add(a);
        return psi;
    }

    async Task<(int Code, string Stdout, string Stderr)> RunSplit(params string[] args)
    {
        try
        {
            using var p = Process.Start(Wsl(new[] { Launcher }.Concat(args), capture: true))!;
            var stdout = p.StandardOutput.ReadToEndAsync();
            var stderr = p.StandardError.ReadToEndAsync();
            var limit = Mystical.Core.Launcher.TimeoutSeconds(args.Length > 0 ? args[0] : "");
            using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(limit));
            try { await p.WaitForExitAsync(cts.Token); }
            catch (OperationCanceledException)
            {
                try { p.Kill(true); } catch (Exception) { }
                return (-1, "", $"mystical {args.FirstOrDefault()} gave no answer in {limit} s — is the distro booting?");
            }
            return (p.ExitCode, await stdout, await stderr);
        }
        catch (Exception e) when (e is System.ComponentModel.Win32Exception or InvalidOperationException)
        {
            return (-1, "", e.Message);
        }
    }

    /// start / stop / restart, then a fresh status. Returns the output on failure.
    public async Task<string?> Lifecycle(string verb)
    {
        var (code, output) = await Run(verb);
        Misses = 0;
        await RefreshStatus();
        return code == 0 ? null : output;
    }

    /// The build log's WSL path: beside the bridge's own log, as on the Mac.
    public string RebuildLog
    {
        get
        {
            var log = Status?.Log;
            var dir = log is { } l && l.LastIndexOf('/') > 0 ? l[..l.LastIndexOf('/')] : $"/home/{Stamp.User}/.bridge_state";
            return dir + "/app-build.log";
        }
    }

    /// `mystical app`, detached: build.sh quits and reopens this app when it is
    /// done, so the child can't share our pipes — a pipe whose reader has quit
    /// is a SIGPIPE mid-swap. The redirect happens inside WSL, into
    /// `RebuildLog`. `done` runs only when the build ends with us still here (a
    /// failure, or nothing to do); a success quits us first. Null = couldn't start.
    public string? RebuildApp(Action<int, string> done)
    {
        var log = RebuildLog;
        var psi = Wsl(new[] { "bash", "-c", $"'{Launcher}' app >> '{log}' 2>&1" }, capture: false);
        try
        {
            var p = new Process { StartInfo = psi, EnableRaisingEvents = true };
            var ui = SynchronizationContext.Current;
            p.Exited += (_, _) =>
            {
                string tail;
                try
                {
                    var text = File.ReadAllText(Unc(log));
                    tail = text.Length > 1500 ? text[^1500..] : text;
                }
                catch (Exception) { tail = ""; }
                var code = p.ExitCode;
                p.Dispose();
                ui?.Post(_ => done(code, tail), null);
            };
            if (!p.Start()) return null;
            return log;
        }
        catch (Exception e) when (e is System.ComponentModel.Win32Exception or InvalidOperationException)
        {
            return null;
        }
    }
}
