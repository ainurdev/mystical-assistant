using System.Runtime.InteropServices;
using System.Security;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.Web.WebView2.Core;
using Microsoft.Win32;
using Mystical.Core;
using Windows.Data.Xml.Dom;
using Windows.UI.Notifications;

namespace Mystical;

/// The page's line to the app — every `{id, op, …}` the shim's handler carries
/// over chrome.webview, answered by id with `{id, result}` or `{id, error}`.
///
/// Notifications first: the page's `new Notification(...)` becomes a Windows
/// toast, a click runs the page's onclick, and a toast button runs the page's
/// onaction (shim.js). Then the WINDOWS APP tab's ops: `settings` / `set` for
/// the app-owned switches (Prefs), `appearance` so the title bar follows the
/// theme, `rebuild` for `mystical app`. One handler, because the page has one
/// `postMessage` target and every op is a few lines. The Mac's `drag` and
/// `window` ops are unknown here — Windows draws its own title bar.
///
/// Toasts come from an unpackaged exe: the AUMID is registered under HKCU at
/// every start (EnsureAumid) and set on the process, which is what Windows
/// needs to show the sender's name and icon. Windows never prompts for
/// permission; `ToastNotifier.Setting` says whether toasts are allowed.
public sealed class Notifier
{
    public const string Aumid = "cloud.ainurhq.mystical";
    const string Group = "mystical";

    public Prefs Prefs { get; }
    /// Web-style permission, kept current so a page load is seeded correctly.
    public string Permission { get; private set; } = "default";
    /// Called with the shim id of a clicked toast.
    public event Action<string>? Clicked;
    /// Called with (shim id, action id) when a toast button is tapped.
    public event Action<string, string>? ActionTapped;
    /// The page changed a switch (already saved).
    public event Action<Prefs>? PrefsChanged;
    /// The page's theme is light (true) or dark.
    public event Action<bool>? AppearanceChanged;
    public event Action? RebuildRequested;

    readonly string prefsPath;
    readonly string version;
    readonly SynchronizationContext ui;
    ToastNotifier? toasts;
    /// Toasts on screen, by tag: the managed object must stay referenced or its
    /// Activated subscription is collected with it and a tap reaches nothing.
    readonly Dictionary<string, ToastNotification> live = new();
    /// A tap can arrive twice — the toast's own event and the COM activator;
    /// the second within a few seconds is the same tap.
    readonly Dictionary<string, DateTime> handled = new();

    public Notifier(Prefs prefs, string prefsPath, string version)
    {
        Prefs = prefs;
        this.prefsPath = prefsPath;
        this.version = version;
        ui = SynchronizationContext.Current ?? new WindowsFormsSynchronizationContext();
        RefreshPermission();
        ToastActivator.OnActivate = args => ui.Post(_ => Activated(args), null);
        if (!ToastActivatorFactory.Register()) App.Log("COM activator not registered: taps from the notification center won't arrive");
    }

    /// Every tap lands here, from either path: the toast's `launch` or the
    /// button's `arguments`, both the JSON `{id, action?}` Show wrote.
    void Activated(string invokedArgs)
    {
        App.Log($"toast activated: '{invokedArgs}'");
        string id, action;
        try
        {
            using var doc = JsonDocument.Parse(invokedArgs);
            id = Str(doc.RootElement, "id") ?? "";
            action = Str(doc.RootElement, "action") ?? "";
        }
        catch (JsonException) { return; }
        if (id.Length == 0) return;
        var key = id + "\u001f" + action;
        var now = DateTime.UtcNow;
        if (handled.TryGetValue(key, out var at) && (now - at).TotalSeconds < 3) return;
        handled[key] = now;
        foreach (var k in handled.Where(kv => (now - kv.Value).TotalSeconds > 30).Select(kv => kv.Key).ToList()) handled.Remove(k);
        live.Remove(Shim.ToastTag(id));
        if (action.Length > 0) ActionTapped?.Invoke(id, action);
        else Clicked?.Invoke(id);
    }

    ToastNotifier Toasts => toasts ??= ToastNotificationManager.CreateToastNotifier(Aumid);

    /// Windows never prompts; its Settings page writes two toggles to the
    /// registry, and those are what we read — `ToastNotifier.Setting` comes back
    /// null for an unpackaged app id. Granted unless toasts are off for the user
    /// or off for this app.
    public string RefreshPermission()
    {
        var enabled = true;
        try
        {
            using var global = Registry.CurrentUser.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\PushNotifications");
            if (global?.GetValue("ToastEnabled") is int t && t == 0) enabled = false;
            using var app = Registry.CurrentUser.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Notifications\Settings\" + Aumid);
            if (app?.GetValue("Enabled") is int e && e == 0) enabled = false;
        }
        catch (Exception) { }
        Permission = Shim.Permission(enabled ? 0 : 2);
        return Permission;
    }

    // MARK: page -> app

    public void Attach(CoreWebView2 core)
    {
        core.WebMessageReceived += async (_, e) =>
        {
            JsonElement root;
            try
            {
                using var doc = JsonDocument.Parse(e.WebMessageAsJson);
                root = doc.RootElement.Clone();
            }
            catch (JsonException) { return; }
            // No id: not the shim's (the form's own F11 message, say).
            if (root.ValueKind != JsonValueKind.Object || !root.TryGetProperty("id", out var idEl)) return;
            var id = JsonNode.Parse(idEl.GetRawText());
            JsonObject reply;
            try
            {
                var (result, error) = Handle(root);
                reply = error is null
                    ? new JsonObject { ["id"] = id, ["result"] = result }
                    : new JsonObject { ["id"] = id, ["error"] = error };
            }
            catch (Exception ex)
            {
                reply = new JsonObject { ["id"] = id, ["error"] = ex.Message };
            }
            core.PostWebMessageAsJson(reply.ToJsonString());
        };
    }

    (JsonNode? Result, string? Error) Handle(JsonElement body)
    {
        switch (Str(body, "op"))
        {
            case "request":
                return (JsonValue.Create(RefreshPermission()), null);
            case "show":
                var id = Str(body, "id") ?? Guid.NewGuid().ToString("n");
                var actions = body.TryGetProperty("actions", out var raw) ? Shim.Actions(raw) : Shim.Actions(null);
                Show(id, Str(body, "title") ?? "", Str(body, "body") ?? "", actions);
                return (null, null);
            case "close":
                if (Str(body, "id") is { } closing) Close(closing);
                return (null, null);
            case "settings":
                return (Settings(), null);
            case "set":
                if (Str(body, "key") is not { } key || !body.TryGetProperty("value", out var v)
                    || v.ValueKind is not (JsonValueKind.True or JsonValueKind.False) || !Prefs.Set(key, v.ValueKind == JsonValueKind.True))
                    return (null, "unknown setting");
                Prefs.Save(prefsPath);
                PrefsChanged?.Invoke(Prefs);
                return (Settings(), null);
            case "appearance":
                var light = body.TryGetProperty("light", out var l) && l.ValueKind == JsonValueKind.True;
                Prefs.Light = light;
                Prefs.Save(prefsPath);
                AppearanceChanged?.Invoke(light);
                return (null, null);
            case "rebuild":
                RebuildRequested?.Invoke();
                return (null, null);
            default:
                return (null, "unknown op");
        }
    }

    JsonNode Settings() => JsonSerializer.SerializeToNode(Prefs.Dict(version))!;

    // MARK: toasts

    public void Show(string id, string title, string body, IReadOnlyList<Shim.Action> actions)
    {
        // A toast with buttons is a card waiting on you: the reminder scenario
        // keeps it on screen, buttons showing, until it's answered or dismissed —
        // after the banner's few seconds a tap in the notification center lands
        // on the collapsed toast, not its buttons.
        var sb = new StringBuilder("<toast launch=\"").Append(Args(id, null)).Append("\"")
            .Append(actions.Count > 0 ? " scenario=\"reminder\"" : "")
            .Append("><visual><binding template=\"ToastGeneric\">");
        sb.Append("<text>").Append(SecurityElement.Escape(title)).Append("</text>");
        if (body.Length > 0) sb.Append("<text>").Append(SecurityElement.Escape(body)).Append("</text>");
        // No sound: the dashboard plays the one you picked for this event.
        sb.Append("</binding></visual><audio silent=\"true\"/>");
        if (actions.Count > 0)
        {
            sb.Append("<actions>");
            foreach (var a in actions)
                sb.Append("<action content=\"").Append(SecurityElement.Escape(a.Title))
                  .Append("\" arguments=\"").Append(Args(id, a.Id))
                  .Append("\" activationType=\"foreground\"/>");
            sb.Append("</actions>");
        }
        sb.Append("</toast>");
        var xml = new XmlDocument();
        xml.LoadXml(sb.ToString());
        // The tag is the shim id, so a session that pings again replaces its own toast.
        var tag = Shim.ToastTag(id);
        var toast = new ToastNotification(xml) { Tag = tag, Group = Group };
        toast.Activated += (_, args) =>
        {
            var arguments = (args as ToastActivatedEventArgs)?.Arguments ?? "";
            ui.Post(_ => Activated(arguments), null);
        };
        toast.Dismissed += (_, args) =>
        {
            App.Log($"toast dismissed: {id} reason={args.Reason}");
            ui.Post(_ => live.Remove(tag), null);
        };
        toast.Failed += (_, args) => App.Log($"toast failed: {id} {args.ErrorCode}");
        live[tag] = toast;
        try { Toasts.Show(toast); App.Log($"toast shown: {id} actions={actions.Count}"); }
        catch (Exception e) { live.Remove(tag); App.Log($"toast show threw: {e.Message}"); }   // toasts off for the app
    }

    /// The `launch` / `arguments` text: JSON, XML-escaped, so a fresh instance
    /// launched by a tap knows the toast too.
    static string Args(string id, string? action)
    {
        var o = new JsonObject { ["id"] = id };
        if (action is not null) o["action"] = action;
        return SecurityElement.Escape(o.ToJsonString()) ?? "";
    }

    public void Close(string id)
    {
        var tag = Shim.ToastTag(id);
        live.Remove(tag);
        try { ToastNotificationManager.History.Remove(tag, Group, Aumid); }
        catch (Exception) { }
    }

    /// What Windows shows as the sender of an unpackaged app's toasts, and the
    /// COM activator a tap from the notification center goes through. HKCU,
    /// idempotent, every start — so a dev copy is attributed and reachable too.
    public static void EnsureAumid(string iconPath)
    {
        try
        {
            using var key = Registry.CurrentUser.CreateSubKey(@"Software\Classes\AppUserModelId\" + Aumid);
            key?.SetValue("DisplayName", "Mystical");
            if (File.Exists(iconPath)) key?.SetValue("IconUri", iconPath);
            var clsid = "{" + ToastActivator.Clsid.ToUpperInvariant() + "}";
            key?.SetValue("CustomActivator", clsid);
            using var server = Registry.CurrentUser.CreateSubKey(@"Software\Classes\CLSID\" + clsid + @"\LocalServer32");
            server?.SetValue("", $"\"{Environment.ProcessPath}\" -ToastActivated");
        }
        catch (Exception) { }
    }

    [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
    static extern int SetCurrentProcessExplicitAppUserModelID(string appId);

    /// Before any window: the taskbar and the toasts then agree on who we are.
    public static void SetProcessAumid()
    {
        try { SetCurrentProcessExplicitAppUserModelID(Aumid); }
        catch (Exception) { }
    }

    static string? Str(JsonElement o, string name) =>
        o.ValueKind == JsonValueKind.Object && o.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String
            ? v.GetString() : null;
}
