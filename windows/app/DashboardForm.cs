using System.Diagnostics;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using System.Text.Json;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;
using Mystical.Core;

namespace Mystical;

/// The one window: the dashboard in a WebView2, plus the host duties a bare web
/// view leaves to the host — links that belong in a browser, full screen, the
/// placeholder when the bridge is down. Closing it only hides it, so the page
/// (and with it the notification rules) keeps running. Copy/paste, the file
/// picker, alert/confirm/prompt and downloads are WebView2's own.
public sealed class DashboardForm : Form
{
    readonly Bridge bridge;
    readonly Prefs prefs;
    readonly string prefsPath;
    readonly string dataDir;
    readonly WebView2 web = new() { Dock = DockStyle.Fill };
    readonly Placeholder placeholder = new() { Dock = DockStyle.Fill };
    /// The dashboard URL last loaded, and whether that load is showing.
    Uri? loaded;
    bool showingPage;
    bool ready;              // CoreWebView2 is up
    Uri? pendingLoad;        // asked for before it was
    FormWindowState beforeFullScreen;

    public event Action<bool>? VisibilityChanged;
    public event Action? StartRequested;
    /// Called with the permission after each page load, so the shim's seed is
    /// corrected (Task 5's Notifier hooks it).
    [System.ComponentModel.Browsable(false)]
    [System.ComponentModel.DesignerSerializationVisibility(System.ComponentModel.DesignerSerializationVisibility.Hidden)]
    public Func<CoreWebView2, Task>? OnCoreReady { get; set; }
    [System.ComponentModel.Browsable(false)]
    [System.ComponentModel.DesignerSerializationVisibility(System.ComponentModel.DesignerSerializationVisibility.Hidden)]
    public Func<Task>? OnPageLoaded { get; set; }

    public bool PageShowing => showingPage;
    /// What the placeholder says, or null when the dashboard is showing (Probe).
    public string? PlaceholderText => placeholder.Visible ? placeholder.Title : null;
    public string? PageUrl => ready ? web.CoreWebView2.Source : loaded?.ToString();
    public bool FullScreen { get; private set; }
    public CoreWebView2? Core => ready ? web.CoreWebView2 : null;

    public DashboardForm(Bridge bridge, Prefs prefs, string prefsPath)
    {
        this.bridge = bridge;
        this.prefs = prefs;
        this.prefsPath = prefsPath;
        dataDir = Path.GetDirectoryName(prefsPath) ?? AppContext.BaseDirectory;
        Text = UrlPolicy.AppName;
        MinimumSize = new Size(720, 480);
        BackColor = Placeholder.Ground;
        var ico = Path.Combine(AppContext.BaseDirectory, "app.ico");
        if (File.Exists(ico)) Icon = new Icon(ico);
        RestoreBoundsFromPrefs();
        Controls.Add(web);
        Controls.Add(placeholder);
        placeholder.Start.Click += (_, _) => StartRequested?.Invoke();
        placeholder.Show(Placeholder.State.Waiting, bridge.Stamp);
        placeholder.BringToFront();
        Load += (_, _) => _ = InitWeb();
        FormClosing += OnClosing;
        ResizeEnd += (_, _) => SaveBounds();
        VisibleChanged += (_, _) => VisibilityChanged?.Invoke(Visible);
    }

    protected override void OnHandleCreated(EventArgs e)
    {
        base.OnHandleCreated(e);
        ApplyAppearance(prefs.Light);
        // A recreated handle lost the registration.
        if (hotkeyWanted && !hotkeyOn) SetHotkey(true);
    }

    // MARK: WebView2

    async Task InitWeb()
    {
        try
        {
            var options = new CoreWebView2EnvironmentOptions
            {
                // Chimes play unprompted; the page keeps polling while the window
                // is hidden — a hidden WebView2 is a background tab to Chromium.
                AdditionalBrowserArguments = "--autoplay-policy=no-user-gesture-required "
                    + "--disable-background-timer-throttling --disable-renderer-backgrounding",
            };
            var env = await CoreWebView2Environment.CreateAsync(null, Path.Combine(dataDir, "WebView2"), options);
            await web.EnsureCoreWebView2Async(env);
        }
        catch (Exception e)
        {
            placeholder.Show(Placeholder.State.Waiting, bridge.Stamp);
            placeholder.Detail.Text = "WebView2 couldn't start: " + e.Message;
            return;
        }
        var core = web.CoreWebView2;
        core.Settings.UserAgent += " MysticalWin/" + bridge.Stamp.Version;
        core.Settings.AreDevToolsEnabled = true;
        core.Settings.IsStatusBarEnabled = false;
        if (OnCoreReady is { } hook) await hook(core);
        core.DocumentTitleChanged += (_, _) => Text = UrlPolicy.Title(core.DocumentTitle);
        core.NavigationStarting += (_, e) =>
        {
            Uri.TryCreate(e.Uri, UriKind.Absolute, out var uri);
            switch (UrlPolicy.Decide(uri, bridge.Status?.Origin, mainFrame: true, newWindow: false))
            {
                case NavigationTarget.InView: break;
                case NavigationTarget.Browser: e.Cancel = true; OpenInBrowser(e.Uri); break;
                default: e.Cancel = true; break;
            }
        };
        core.NewWindowRequested += (_, e) =>
        {
            e.Handled = true;    // never a second web view
            Uri.TryCreate(e.Uri, UriKind.Absolute, out var uri);
            if (UrlPolicy.Decide(uri, bridge.Status?.Origin, mainFrame: true, newWindow: true) == NavigationTarget.Browser)
                OpenInBrowser(e.Uri);
        };
        core.ProcessFailed += (_, _) => core.Reload();
        core.NavigationCompleted += (_, e) =>
        {
            if (!e.IsSuccess && showingPage)
            {
                // Not WebView2's error page: ours, and the poll brings the page back.
                Cover(bridge.Status?.Running == true ? Placeholder.State.Waiting : Placeholder.State.Stopped);
                return;
            }
            if (OnPageLoaded is { } loadedHook) _ = loadedHook();
        };
        core.ContainsFullScreenElementChanged += (_, _) => SetFullScreen(core.ContainsFullScreenElement);
        web.ZoomFactor = prefs.Zoom > 0 ? prefs.Zoom : 1;
        web.ZoomFactorChanged += (_, _) => { prefs.Zoom = web.ZoomFactor; prefs.Save(prefsPath); };
        // F11 from the page: the WinForms control exposes no accelerator event,
        // so a keydown listener posts a web message with no id — the shim's
        // posts all carry one (Notifier leaves these alone).
        await core.AddScriptToExecuteOnDocumentCreatedAsync(
            "if (window === window.top) document.addEventListener('keydown', (e) => { if (e.key === 'F11') "
            + "{ e.preventDefault(); window.chrome.webview.postMessage({ op: 'fullscreen' }); } }, true);");
        core.WebMessageReceived += (_, e) =>
        {
            try
            {
                using var doc = JsonDocument.Parse(e.WebMessageAsJson);
                var r = doc.RootElement;
                if (r.ValueKind == JsonValueKind.Object && !r.TryGetProperty("id", out JsonElement _)
                    && r.TryGetProperty("op", out var op) && op.GetString() == "fullscreen")
                    SetFullScreen(!FullScreen);
            }
            catch (JsonException) { }
        };
        ready = true;
        if (pendingLoad is { } url) LoadPage(url);
        else Sync();
    }

    static void OpenInBrowser(string url)
    {
        try { Process.Start(new ProcessStartInfo(url) { UseShellExecute = true }); }
        catch (Exception) { }
    }

    // MARK: state

    /// Called on every bridge change: load the dashboard when it answers, cover
    /// it with the native placeholder when it doesn't.
    public void Sync()
    {
        if (bridge.RepoMissing)
        {
            Cover(Placeholder.State.Missing);
            return;
        }
        if (bridge.Up && bridge.Status?.DashboardUrl is { } url)
        {
            // Same dashboard still showing: leave it alone — it reconnects itself.
            if (showingPage && UrlPolicy.SameDashboard(loaded, url)) return;
            LoadPage(url);
            return;
        }
        // One missed poll is a restart's first second; two is down.
        if (bridge.Misses < 2 && bridge.Status?.Answering == true) return;
        Cover(bridge.Status?.Running == true ? Placeholder.State.Waiting : Placeholder.State.Stopped);
    }

    void LoadPage(Uri url)
    {
        loaded = url;
        showingPage = true;
        placeholder.Visible = false;
        if (!ready) { pendingLoad = url; return; }
        pendingLoad = null;
        web.CoreWebView2.Navigate(url.ToString());
    }

    void Cover(Placeholder.State state)
    {
        showingPage = false;
        placeholder.Show(state, bridge.Stamp);
        placeholder.Visible = true;
        placeholder.BringToFront();
    }

    /// Open one session: the page showing switches to it in place (App.tsx
    /// `__mysticalOpenSession`); without one, a full load of `?s=<id>` — the
    /// dashboard's own deep link.
    public void Open(string sessionId) => _ = OpenAsync(sessionId);

    async Task OpenAsync(string sessionId)
    {
        ShowDashboard();
        if (bridge.Status?.DashboardUrl is not { } baseUrl) return;
        if (showingPage && await EvalIsTrue($"window.__mysticalOpenSession?.({JsonSerializer.Serialize(sessionId)}) === true")) return;
        LoadPage(UrlPolicy.Session(baseUrl, sessionId));
    }

    /// A toast was clicked: let the page that made it handle it (it already
    /// knows how to open that session); if that page is gone, deep-link.
    public void NotificationClicked(string id) => _ = Route(id, $"window.__mysticalNotificationClick?.({JsonSerializer.Serialize(id)}) === true", show: true);

    /// A toast button was tapped: run the page's handler where it is — the
    /// window stays wherever it was. If that page is gone, open the session.
    public void NotificationAction(string id, string action) =>
        _ = Route(id, $"window.__mysticalNotificationAction?.({JsonSerializer.Serialize(id)}, {JsonSerializer.Serialize(action)}) === true", show: false);

    async Task Route(string id, string js, bool show)
    {
        if (show) ShowDashboard();
        if (await EvalIsTrue(js)) return;
        if (id.StartsWith("tag:")) Open(id[4..]);
    }

    async Task<bool> EvalIsTrue(string js) => await Eval(js) == "true";

    /// Runs JS in the page; the JSON text of its result, or null without a page.
    public async Task<string?> Eval(string js)
    {
        if (!ready || !showingPage) return null;
        try { return await web.CoreWebView2.ExecuteScriptAsync(js); }
        catch (Exception) { return null; }
    }

    // MARK: window

    public void ShowDashboard()
    {
        if (!Visible) Show();
        if (WindowState == FormWindowState.Minimized)
            WindowState = prefs.Maximized ? FormWindowState.Maximized : FormWindowState.Normal;
        Activate();
        Native.SetForegroundWindow(Handle);
    }

    public void HideDashboard()
    {
        if (FullScreen) SetFullScreen(false);
        Hide();
    }

    /// The hotkey: hidden or behind → in front; already in front → hidden.
    public void ToggleFromHotkey()
    {
        if (Visible && WindowState != FormWindowState.Minimized && Native.GetForegroundWindow() == Handle) HideDashboard();
        else ShowDashboard();
    }

    public void ReloadPage()
    {
        if (ready && showingPage) web.CoreWebView2.Reload();
        else Sync();
    }

    /// Native chrome in the theme's mode: the title bar goes dark or light with
    /// the dashboard's palette.
    public void ApplyAppearance(bool light)
    {
        if (!IsHandleCreated) return;
        var dark = light ? 0 : 1;
        Native.DwmSetWindowAttribute(Handle, Native.DwmUseImmersiveDarkMode, ref dark, sizeof(int));
    }

    bool hotkeyWanted, hotkeyOn;
    const int HotkeyId = 1;

    /// Win+Ctrl+A, system-wide, while the switch is on: hidden or behind → in
    /// front, in front → hidden. False when another app holds the chord.
    public bool SetHotkey(bool on)
    {
        hotkeyWanted = on;
        if (!IsHandleCreated) CreateHandle();
        if (hotkeyOn) { Native.UnregisterHotKey(Handle, HotkeyId); hotkeyOn = false; }
        if (!on) return true;
        hotkeyOn = Native.RegisterHotKey(Handle, HotkeyId, Native.ModWin | Native.ModControl | Native.ModNoRepeat, 0x41);
        App.Log($"hotkey Win+Ctrl+A registered: {hotkeyOn}");
        return hotkeyOn;
    }

    protected override void WndProc(ref Message m)
    {
        if (m.Msg == Native.WmHotkey && (int)m.WParam == HotkeyId)
        {
            ToggleFromHotkey();
            return;
        }
        base.WndProc(ref m);
    }

    void SetFullScreen(bool on)
    {
        if (on == FullScreen) return;
        FullScreen = on;
        if (on)
        {
            beforeFullScreen = WindowState;
            FormBorderStyle = FormBorderStyle.None;
            WindowState = FormWindowState.Normal;
            WindowState = FormWindowState.Maximized;
        }
        else
        {
            FormBorderStyle = FormBorderStyle.Sizable;
            WindowState = beforeFullScreen == FormWindowState.Maximized ? FormWindowState.Maximized : FormWindowState.Normal;
        }
    }

    /// The window's image for the probe: WebView2's own capture when the page
    /// shows and the window is visible, the placeholder drawn otherwise.
    public async Task<byte[]?> Snapshot()
    {
        try
        {
            if (ready && showingPage && Visible)
            {
                using var ms = new MemoryStream();
                await web.CoreWebView2.CapturePreviewAsync(CoreWebView2CapturePreviewImageFormat.Png, ms);
                return ms.ToArray();
            }
            using var bmp = new Bitmap(Math.Max(1, ClientSize.Width), Math.Max(1, ClientSize.Height));
            DrawToBitmap(bmp, ClientRectangle);
            using var png = new MemoryStream();
            bmp.Save(png, ImageFormat.Png);
            return png.ToArray();
        }
        catch (Exception)
        {
            return null;
        }
    }

    void OnClosing(object? sender, FormClosingEventArgs e)
    {
        SaveBounds();
        if (e.CloseReason != CloseReason.UserClosing) return;
        // Closing only hides the window — out of full screen first.
        e.Cancel = true;
        HideDashboard();
    }

    void RestoreBoundsFromPrefs()
    {
        if (prefs.Window is { Length: 4 } w)
        {
            var r = new Rectangle(w[0], w[1], w[2], w[3]);
            if (r.Width >= 720 && r.Height >= 480 && Screen.AllScreens.Any(s => s.WorkingArea.IntersectsWith(r)))
            {
                StartPosition = FormStartPosition.Manual;
                Bounds = r;
                if (prefs.Maximized) WindowState = FormWindowState.Maximized;
                return;
            }
        }
        StartPosition = FormStartPosition.CenterScreen;
        Size = new Size(1440, 900);
    }

    void SaveBounds()
    {
        if (FullScreen || WindowState == FormWindowState.Minimized) return;
        var r = WindowState == FormWindowState.Normal ? Bounds : RestoreBounds;
        prefs.Window = new[] { r.X, r.Y, r.Width, r.Height };
        prefs.Maximized = WindowState == FormWindowState.Maximized;
        prefs.Save(prefsPath);
    }

    static class Native
    {
        public const int DwmUseImmersiveDarkMode = 20;
        public const int WmHotkey = 0x0312;
        public const uint ModControl = 0x0002, ModWin = 0x0008, ModNoRepeat = 0x4000;
        [DllImport("user32.dll")] public static extern bool RegisterHotKey(IntPtr hwnd, int id, uint modifiers, uint vk);
        [DllImport("user32.dll")] public static extern bool UnregisterHotKey(IntPtr hwnd, int id);
        [DllImport("dwmapi.dll")] public static extern int DwmSetWindowAttribute(IntPtr hwnd, int attr, ref int value, int size);
        [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hwnd);
        [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    }
}

/// What the window shows instead of WebView2's error page: the brand's ground
/// and phosphor teal, one line of state, and the one action that helps.
public sealed class Placeholder : Panel
{
    public enum State { Waiting, Stopped, Missing }

    public static readonly Color Ground = ColorTranslator.FromHtml("#060a0a");
    public static readonly Color Teal = ColorTranslator.FromHtml("#7fe9d8");

    readonly Label title = new() { AutoSize = true, ForeColor = Teal, Font = new Font("Consolas", 14f, FontStyle.Bold), BackColor = Color.Transparent };
    public readonly Label Detail = new() { AutoSize = true, MaximumSize = new Size(520, 0), ForeColor = Color.FromArgb(153, Teal), Font = new Font("Consolas", 10.5f), BackColor = Color.Transparent, TextAlign = ContentAlignment.MiddleCenter };
    public readonly Button Start = new() { Text = "Start the bridge", AutoSize = true, FlatStyle = FlatStyle.Flat, ForeColor = Teal, BackColor = Ground, Font = new Font("Consolas", 10.5f), Padding = new Padding(10, 4, 10, 4) };
    readonly FlowLayoutPanel column = new() { FlowDirection = FlowDirection.TopDown, AutoSize = true, AutoSizeMode = AutoSizeMode.GrowAndShrink, WrapContents = false, BackColor = Color.Transparent };

    public string Title => title.Text;

    public Placeholder()
    {
        BackColor = Ground;
        Start.FlatAppearance.BorderColor = Color.FromArgb(77, Teal);
        Start.FlatAppearance.MouseOverBackColor = Color.FromArgb(26, Teal);
        foreach (Control c in new Control[] { title, Detail, Start })
        {
            c.Margin = new Padding(0, 6, 0, 6);
            c.Anchor = AnchorStyles.None;
            column.Controls.Add(c);
        }
        Controls.Add(column);
        Resize += (_, _) => Center();
        column.SizeChanged += (_, _) => Center();
    }

    void Center() => column.Location = new Point((Width - column.Width) / 2, (Height - column.Height) / 2);

    public void Show(State state, Stamp stamp)
    {
        switch (state)
        {
            case State.Waiting:
                title.Text = "✦ waiting for the bridge…";
                Detail.Text = "The dashboard loads the moment it answers.";
                Start.Visible = false;
                break;
            case State.Stopped:
                title.Text = "✦ the bridge is stopped";
                Detail.Text = "Sessions keep their history; nothing runs until it's back.";
                Start.Visible = true;
                break;
            case State.Missing:
                title.Text = "✦ can't find the checkout";
                var repo = stamp.Repo.Length == 0 ? "an unknown path" : stamp.Repo;
                var distro = stamp.Distro.Length == 0 ? "an unknown distro" : stamp.Distro;
                Detail.Text = $"This app was built from {repo} in the WSL distro {distro}, which has no bin/mystical now. "
                    + "Rebuild it from your checkout: mystical app";
                Start.Visible = false;
                break;
        }
        Center();
    }
}
