using Mystical.Core;

namespace Mystical;

/// The WAITING ON YOU panel: a small always-on-top list of the sessions blocked
/// on you, shown while the dashboard isn't the active window — the tray's count,
/// but readable from the app you're actually in. Click a row to open that
/// session. Non-activating, so it never takes focus; borderless and movable by
/// its body; its position is remembered.
public sealed class FloatingPanel : Form
{
    const int W = 300;
    const int WsExNoActivate = 0x08000000;
    const int WsExToolWindow = 0x00000080;
    const int WmNcHitTest = 0x84;
    const int HtClient = 1;
    const int HtCaption = 2;

    readonly FlowLayoutPanel column = new()
    {
        FlowDirection = FlowDirection.TopDown, WrapContents = false, AutoSize = true,
        AutoSizeMode = AutoSizeMode.GrowAndShrink, Location = new Point(12, 10), BackColor = Color.Transparent,
    };
    readonly ToolTip tips = new();
    readonly Action<string> onOpen;
    readonly Prefs prefs;
    readonly string prefsPath;
    IReadOnlyList<WaitingSession> shown = Array.Empty<WaitingSession>();
    bool placing;

    protected override bool ShowWithoutActivation => true;

    protected override CreateParams CreateParams
    {
        get
        {
            var cp = base.CreateParams;
            cp.ExStyle |= WsExNoActivate | WsExToolWindow;
            return cp;
        }
    }

    public FloatingPanel(Action<string> onOpen, Prefs prefs, string prefsPath)
    {
        this.onOpen = onOpen;
        this.prefs = prefs;
        this.prefsPath = prefsPath;
        FormBorderStyle = FormBorderStyle.None;
        TopMost = true;
        ShowInTaskbar = false;
        StartPosition = FormStartPosition.Manual;
        BackColor = Placeholder.Ground;
        ClientSize = new Size(W, 60);
        Controls.Add(column);
        Paint += (_, e) =>
        {
            using var pen = new Pen(Color.FromArgb(77, Placeholder.Teal));
            e.Graphics.DrawRectangle(pen, 0, 0, Width - 1, Height - 1);
        };
        // First run: top-right of the primary screen; afterwards, where you left it.
        placing = true;
        var area = Screen.PrimaryScreen?.WorkingArea ?? new Rectangle(0, 0, 1280, 800);
        Location = prefs.Panel is { Length: 2 } p && area.Contains(new Point(p[0], p[1]))
            ? new Point(p[0], p[1]) : new Point(area.Right - W - 12, area.Top + 12);
        placing = false;
        Move += (_, _) =>
        {
            if (placing || !Visible) return;
            prefs.Panel = new[] { Location.X, Location.Y };
            prefs.Save(prefsPath);
        };
    }

    /// `show` is the switch; the panel also hides when nothing waits or the
    /// dashboard itself is in front (you can see the list there).
    public void Sync(IReadOnlyList<WaitingSession> waiting, bool show, bool dashboardInFront)
    {
        if (!waiting.SequenceEqual(shown)) Rebuild(waiting);
        if (show && waiting.Count > 0 && !dashboardInFront)
        {
            if (!Visible) Show();
        }
        else if (Visible)
        {
            Hide();
        }
    }

    void Rebuild(IReadOnlyList<WaitingSession> waiting)
    {
        shown = waiting;
        column.SuspendLayout();
        foreach (Control c in column.Controls.Cast<Control>().ToList()) { column.Controls.Remove(c); c.Dispose(); }
        column.Controls.Add(new Label
        {
            Text = $"✦ WAITING ON YOU · {waiting.Count}", AutoSize = true, Margin = new Padding(0, 0, 0, 4),
            Font = new Font("Consolas", 8f, FontStyle.Bold), ForeColor = Color.FromArgb(153, Placeholder.Teal), BackColor = Color.Transparent,
        });
        foreach (var w in waiting.Take(6))
        {
            var row = new Button
            {
                Text = "▸ " + w.Title, Tag = w.Id, FlatStyle = FlatStyle.Flat, AutoEllipsis = true,
                TextAlign = ContentAlignment.MiddleLeft, Width = W - 24, Height = 24, Margin = new Padding(0),
                Font = new Font("Consolas", 9.5f), ForeColor = Placeholder.Teal, BackColor = Placeholder.Ground, Cursor = Cursors.Hand,
            };
            row.FlatAppearance.BorderSize = 0;
            row.FlatAppearance.MouseOverBackColor = Color.FromArgb(26, Placeholder.Teal);
            row.Click += (s, _) => onOpen((string)((Button)s!).Tag!);
            tips.SetToolTip(row, w.Label);
            column.Controls.Add(row);
        }
        if (waiting.Count > 6)
            column.Controls.Add(new Label
            {
                Text = $"… and {waiting.Count - 6} more", AutoSize = true, Margin = new Padding(0, 4, 0, 0),
                Font = new Font("Consolas", 8f), ForeColor = Color.FromArgb(128, Placeholder.Teal), BackColor = Color.Transparent,
            });
        column.ResumeLayout(true);
        // Grow downwards from a fixed top-left, so the panel stays where you put it.
        placing = true;
        ClientSize = new Size(W, column.Height + 20);
        placing = false;
        Invalidate();
    }

    /// A press on the bare surface drags the panel; the rows are buttons and
    /// hit-test themselves.
    protected override void WndProc(ref Message m)
    {
        base.WndProc(ref m);
        if (m.Msg == WmNcHitTest && (int)m.Result == HtClient) m.Result = HtCaption;
    }
}
