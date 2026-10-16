using System.Diagnostics;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json.Nodes;
using Mystical.Core;

namespace Mystical;

/// Real screen captures for bridge sessions (windows/capture.sh). A session
/// lives in WSL and has no screen at all; the app runs on the Windows side and
/// can read it — no permission to grant there. Writes `<dir>\capture.png` (the
/// first window whose title or process name contains `window`, else the primary
/// display) and `<dir>\capture.json` — `ok`, an `error`, and the windows it
/// could see. Request-only: nothing is captured unless a local process asks.
/// The manifest's PerMonitorV2 awareness keeps everything in physical pixels.
///
/// ponytail: CopyFromScreen — an occluded window shows what covers it; switch
/// that path to PrintWindow(PW_RENDERFULLCONTENT) when it bites.
public static class Capture
{
    public static JsonObject Run(CaptureRequest req)
    {
        var result = new JsonObject { ["ok"] = false };
        try
        {
            Directory.CreateDirectory(req.Dir);
            var windows = ListWindows();
            result["windows"] = new JsonArray(windows.Take(60)
                .Select(w => (JsonNode)new JsonObject { ["app"] = w.App, ["title"] = w.Title }).ToArray());
            Rectangle bounds;
            if (req.Window is { } asked)
            {
                var hit = windows.FirstOrDefault(w => CaptureRequest.Matches(asked, w.Title, w.App));
                if (hit.Handle == IntPtr.Zero)
                {
                    result["error"] = $"no window whose title or app contains \"{asked}\"";
                    return Finish(req, result);
                }
                bounds = Bounds(hit.Handle);
            }
            else
            {
                bounds = Screen.PrimaryScreen?.Bounds ?? SystemInformation.VirtualScreen;
            }
            if (bounds.Width <= 0 || bounds.Height <= 0)
            {
                result["error"] = "the window has no size — minimized?";
                return Finish(req, result);
            }
            using var bmp = new Bitmap(bounds.Width, bounds.Height);
            using (var g = Graphics.FromImage(bmp)) g.CopyFromScreen(bounds.Location, Point.Empty, bounds.Size);
            bmp.Save(Path.Combine(req.Dir, "capture.png"), ImageFormat.Png);
            result["ok"] = true;
            result["width"] = bounds.Width;
            result["height"] = bounds.Height;
        }
        catch (Exception e)
        {
            result["error"] = e.Message;
        }
        return Finish(req, result);
    }

    static JsonObject Finish(CaptureRequest req, JsonObject result)
    {
        try { File.WriteAllText(Path.Combine(req.Dir, "capture.json"), result.ToJsonString(Pipe.Plain)); }
        catch (Exception) { }
        return result;
    }

    readonly record struct Win(IntPtr Handle, string Title, string App);

    /// Every visible, titled top-level window, with its process name.
    static List<Win> ListWindows()
    {
        var list = new List<Win>();
        EnumWindows((h, _) =>
        {
            if (!IsWindowVisible(h)) return true;
            var len = GetWindowTextLength(h);
            if (len == 0) return true;
            var sb = new StringBuilder(len + 1);
            GetWindowText(h, sb, sb.Capacity);
            var title = sb.ToString();
            if (title.Length == 0) return true;
            GetWindowThreadProcessId(h, out var pid);
            var app = "";
            try { app = Process.GetProcessById((int)pid).ProcessName; } catch (Exception) { }
            list.Add(new Win(h, title, app));
            return true;
        }, IntPtr.Zero);
        return list;
    }

    /// The window as drawn, without the invisible resize borders.
    static Rectangle Bounds(IntPtr h)
    {
        if (DwmGetWindowAttribute(h, DwmaExtendedFrameBounds, out var r, Marshal.SizeOf<Rect>()) != 0) GetWindowRect(h, out r);
        return Rectangle.FromLTRB(r.Left, r.Top, r.Right, r.Bottom);
    }

    const int DwmaExtendedFrameBounds = 9;
    delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int max);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowTextLength(IntPtr hWnd);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr hWnd, out Rect rect);
    [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr hWnd, int attribute, out Rect rect, int size);
    [StructLayout(LayoutKind.Sequential)] struct Rect { public int Left, Top, Right, Bottom; }
}
