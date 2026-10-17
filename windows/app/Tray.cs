using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Drawing.Text;
using System.Runtime.InteropServices;
using Mystical.Core;

namespace Mystical;

/// The tray icon — the Mac menu bar's twin. The emblem with the waiting count
/// on an amber badge (the dashboard's --warn), grey while the bridge is down;
/// the menu is rebuilt on every open from the latest poll (App.FillMenu); a left
/// click opens the dashboard. The drawing is windows/tray.ps1's New-TrayIcon,
/// ported, and like it frees the previous HICON — the shell keeps its own copy.
public sealed class Tray : IDisposable
{
    readonly NotifyIcon icon = new();
    readonly ContextMenuStrip menu = new();
    readonly Bitmap? emblem;
    IntPtr handle;
    (int Waiting, bool Up) drawn = (-1, true);

    /// The count on the badge ("9+" past nine), null when nothing waits.
    public string? Badge { get; private set; }

    public Tray(Action<ContextMenuStrip> fill, Action leftClick)
    {
        var png = Path.Combine(AppContext.BaseDirectory, "icon.png");
        if (File.Exists(png))
        {
            // Into memory: GDI+ keeps reading a bitmap's file otherwise.
            using var ms = new MemoryStream(File.ReadAllBytes(png));
            emblem = new Bitmap(ms);
        }
        menu.Opening += (_, e) =>
        {
            menu.Items.Clear();
            fill(menu);
            e.Cancel = menu.Items.Count == 0;
        };
        icon.ContextMenuStrip = menu;
        icon.MouseClick += (_, e) => { if (e.Button == MouseButtons.Left) leftClick(); };
        Update(0, 0, false);
        icon.Visible = true;
    }

    public void Update(int waiting, int working, bool up)
    {
        Badge = waiting > 0 ? (waiting > 9 ? "9+" : waiting.ToString()) : null;
        var parts = new List<string>();
        if (working > 0) parts.Add($"{working} working");
        if (waiting > 0) parts.Add($"{waiting} waiting on you");
        var tip = !up ? "mystical — stopped" : parts.Count > 0 ? string.Join(" · ", parts) : UrlPolicy.AppName;
        icon.Text = tip.Length > 63 ? tip[..62] + "…" : tip;
        if (drawn == (waiting, up)) return;
        drawn = (waiting, up);
        var h = Draw(waiting, up);
        icon.Icon = Icon.FromHandle(h);
        if (handle != IntPtr.Zero) DestroyIcon(handle);
        handle = h;
    }

    public void Balloon(string title, string body) => icon.ShowBalloonTip(10000, title, body, ToolTipIcon.None);

    IntPtr Draw(int count, bool up)
    {
        const int size = 32;
        using var bmp = new Bitmap(size, size);
        using (var g = Graphics.FromImage(bmp))
        {
            g.SmoothingMode = SmoothingMode.AntiAlias;
            g.InterpolationMode = InterpolationMode.HighQualityBicubic;
            g.TextRenderingHint = TextRenderingHint.AntiAliasGridFit;
            if (emblem is null)
            {
                g.DrawIcon(SystemIcons.Application, new Rectangle(0, 0, size, size));
            }
            else if (up)
            {
                g.DrawImage(emblem, 0, 0, size, size);
            }
            else
            {
                // Half-faded while the bridge is down — the Mac's appearsDisabled.
                using var attrs = new ImageAttributes();
                attrs.SetColorMatrix(new ColorMatrix { Matrix33 = 0.5f });
                g.DrawImage(emblem, new Rectangle(0, 0, size, size), 0, 0, emblem.Width, emblem.Height, GraphicsUnit.Pixel, attrs);
            }
            if (count > 0)
            {
                const int d = 20;
                const int x = size - d;
                using var amber = new SolidBrush(Color.FromArgb(0xE3, 0xC2, 0x79));
                using var ink = new SolidBrush(Color.FromArgb(0x06, 0x0A, 0x0A));
                using var font = new Font("Segoe UI", 13, FontStyle.Bold, GraphicsUnit.Pixel);
                using var fmt = new StringFormat { Alignment = StringAlignment.Center, LineAlignment = StringAlignment.Center };
                g.FillEllipse(amber, x, x, d, d);
                g.DrawString(count > 9 ? "9+" : count.ToString(), font, ink, new RectangleF(x, x, d, d), fmt);
            }
        }
        return bmp.GetHicon();
    }

    [DllImport("user32.dll")] static extern bool DestroyIcon(IntPtr handle);

    public void Dispose()
    {
        // Take the icon down now, not when the mouse next passes over it.
        icon.Visible = false;
        icon.Dispose();
        menu.Dispose();
        if (handle != IntPtr.Zero) DestroyIcon(handle);
        handle = IntPtr.Zero;
        emblem?.Dispose();
    }
}
