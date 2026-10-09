<#
  mystical//assistant - the Windows tray companion: Mystical.app's menu bar,
  for a bridge running in WSL.

  A tray icon beside the installed dashboard window (bridge/startup.py opens
  that one from the Startup folder): how many sessions are waiting on you,
  start/stop/restart without a terminal, and alerts while no dashboard window
  is open. Its Linux twin is linux/tray.py; the design is
  docs/superpowers/specs/tray-companion-design.md.

  Why it is shaped like this:
  - Windows PowerShell 5.1 and WinForms, which every Windows 10/11 ships:
    nothing to build, sign or download. It runs from the checkout through
    \\wsl$, so a git pull updates it. 5.1, not 7: none of 7's newer operators.
  - ASCII only. 5.1 reads a BOM-less script as ANSI, so every glyph below is
    built from its code point rather than typed.
  - It polls GET /local/running every 4 s, like the dashboard, and alerts on
    the transitions the dashboard rings for (App.tsx), minus "started" - but
    not while `watched`: a dashboard page with its own alerts on polled within
    90 s and already alerted.
  - No token in its arguments: opening a window reads start_url from
    /manifest.webmanifest, so a rotated DASH_TOKEN is picked up on the next open.
  - Everything above "if ($Check)" is pure, so windows/tray.check.ps1 can
    dot-source it under pwsh on any OS; WinForms starts below that line.
#>
param(
  [int]$Port = 8790,
  [string]$Distro = 'Ubuntu',
  [string]$User = '',
  [string]$Repo = '',
  [string]$Browser = '',
  [string]$BrowserProfile = '',
  [switch]$Check
)

$GlyphWait   = [string][char]0x23F8   # pause: waiting on you
$GlyphDone   = [string][char]0x2713   # check mark: finished
$GlyphParked = [string][char]0x23F3   # hourglass: parked on a limit
$GlyphUp     = [string][char]0x25CF   # filled circle: running
$GlyphDown   = [string][char]0x25CB   # empty circle: stopped
$GlyphBusy   = [string][char]0x2026   # ellipsis: starting, stopping
$Dot         = [string][char]0x00B7
$Dash        = [string][char]0x2014

# --- what counts as news (pure; mirrors linux/tray.py) -----------------------
function First {
  # The first argument that isn't empty.
  foreach ($a in $args) { if ($a) { return $a } }
  return $null
}

function ConvertTo-Map($Obj) {
  # ConvertFrom-Json hands back a PSCustomObject; the diff wants a hashtable.
  if ($Obj -is [hashtable]) { return $Obj }
  $map = @{}
  if ($null -ne $Obj) { foreach ($p in $Obj.PSObject.Properties) { $map[$p.Name] = $p.Value } }
  return $map
}

function Update-Titles([hashtable]$Titles, $Running) {
  # jobs[].title, kept across polls: a turn that ends on a question leaves
  # jobs, but its title was there while it worked.
  foreach ($job in @($Running.jobs)) {
    if ($job -and $job.session_id -and $job.title) { $Titles[$job.session_id] = $job.title }
  }
}

function Get-Alerts($Prev, [hashtable]$Cur, [hashtable]$Titles) {
  # The alerts one poll brings. $Prev $null is a baseline (the first poll, or
  # the first after the bridge came back): nothing that predates it is news.
  $out = New-Object System.Collections.ArrayList
  if ($null -eq $Prev) { return ,$out }
  foreach ($sid in @($Cur.Keys)) {
    $st = $Cur[$sid]
    $was = $null
    if ($Prev.ContainsKey($sid)) { $was = $Prev[$sid].state }
    $name = First $Titles[$sid] $st.label 'session'
    if ($st.state -eq 'awaiting' -and $was -ne 'awaiting') {
      [void]$out.Add(@{ id = $sid; title = "$GlyphWait $name"; body = (First $st.label 'waiting on you') })
    } elseif ($st.state -eq 'parked' -and $was -ne 'parked') {
      [void]$out.Add(@{ id = $sid; title = "$GlyphParked $name"; body = (First $st.label 'parked') })
    }
  }
  foreach ($sid in @($Prev.Keys)) {
    # Native (VS Code, terminal) sessions read working only within 3 s of a
    # transcript write, so their every long tool call would look done.
    if ($Prev[$sid].state -ne 'working' -or $Prev[$sid].source -eq 'native') { continue }
    $now = $null
    if ($Cur.ContainsKey($sid)) { $now = $Cur[$sid].state }
    if (@('working', 'awaiting', 'parked') -notcontains $now) {
      # Not the label: a working session's label is its activity.
      [void]$out.Add(@{ id = $sid; title = "$GlyphDone $(First $Titles[$sid] 'session')"; body = 'finished' })
    }
  }
  return ,$out
}

function Get-Waiting([hashtable]$Status, [hashtable]$Titles) {
  # One row per session blocked on you, by title: the menu's rows.
  $rows = @(foreach ($sid in @($Status.Keys)) {
    if ($Status[$sid].state -eq 'awaiting') {
      [pscustomobject]@{ id = $sid; title = (First $Titles[$sid] $Status[$sid].label 'waiting on you') }
    }
  })
  return ,@($rows | Sort-Object -Property title, id)
}

function Step-Poll($Prev, $Running, [hashtable]$Titles) {
  # One poll folded in. $Running $null = the bridge didn't answer, so the next
  # answer is a fresh baseline. While watched the state still moves on, so
  # nothing replays once the dashboard window closes, but nothing alerts.
  if ($null -eq $Running) { return @{ news = @(); prev = $null; waiting = @() } }
  $status = ConvertTo-Map $Running.status
  Update-Titles $Titles $Running
  $news = @()
  if (-not $Running.watched) { $news = Get-Alerts $Prev $status $Titles }
  return @{ news = $news; prev = $status; waiting = (Get-Waiting $status $Titles) }
}

function Get-BridgeUrl([int]$Port, [string]$Path) {
  # The address the bridge binds. localhost can try ::1 first, and Windows
  # takes about two seconds to refuse that; windows still open on localhost.
  return "http://127.0.0.1:$Port$Path"
}

function Get-SessionUrl([int]$Port, [string]$StartUrl, [string]$Sid) {
  # localhost (the installed app's origin, so it shares its storage), the
  # manifest's query (the token, when DASH_TOKEN is set), then the session,
  # skipping the intro a click doesn't want.
  $parts = @()
  if ($StartUrl.Contains('?')) {
    $query = $StartUrl.Substring($StartUrl.IndexOf('?') + 1)
    if ($query) { $parts += $query }
  }
  if ($Sid) { $parts += 's=' + [uri]::EscapeDataString($Sid); $parts += 'skipboot' }
  $url = "http://localhost:$Port/"
  if ($parts.Count) { $url += '?' + ($parts -join '&') }
  return $url
}

function Get-Clipped([string]$Text, [int]$Max) {
  if ($Text.Length -le $Max) { return $Text }
  return $Text.Substring(0, $Max - 1) + $GlyphBusy
}

function Get-Balloon($News) {
  # Windows shows one tray balloon at a time, so a poll's alerts become one: a
  # single alert names its session (a click opens it), several become a
  # summary (a click opens the dashboard). WinForms throws past the shell's
  # 63/255 characters, and a throw in a handler would end the tray.
  if ($News.Count -eq 1) {
    $b = @{ id = $News[0].id; title = $News[0].title; body = $News[0].body }
  } else {
    $b = @{ id = $null; title = "$($News.Count) sessions need you"
            body = (@($News | ForEach-Object { $_.title }) -join "`n") }
  }
  $b.title = Get-Clipped $b.title 63
  $b.body = Get-Clipped $b.body 255
  return $b
}

function Get-Tooltip([bool]$Up, [int]$Waiting) {
  if (-not $Up) { return "mystical $Dash stopped" }
  if ($Waiting) { return Get-Clipped "mystical $Dash $Waiting waiting on you" 63 }
  return 'mystical'
}

function Get-MenuHead([string]$Busy, [bool]$Up, [int]$Waiting) {
  if ($Busy) { $head = $Busy } elseif ($Up) { $head = "$GlyphUp running" } else { $head = "$GlyphDown stopped" }
  if ($Waiting) { $head += " $Dot $Waiting waiting on you" }
  return $head
}

function Get-BridgeArgs([string]$Distro, [string]$User, [string]$Repo, [string]$Cmd) {
  # -e runs bash itself rather than through the default shell, so this is the
  # only quoting; -lic gives it the PATH your terminal has (nvm's npm, for a
  # stale bundle).
  return "-d `"$Distro`" -u `"$User`" -e bash -lic `"'$Repo/bin/mystical' $Cmd`""
}

function Get-BrowserArgs([string]$BrowserProfile, [string]$Url) {
  # Start-Process joins an argument array with bare spaces, so a profile with
  # a space in it ("Profile 2") is quoted here.
  $a = @()
  if ($BrowserProfile) { $a += "--profile-directory=`"$BrowserProfile`"" }
  $a += "--app=$Url"
  return ,$a
}

if ($Check) { return }   # tray.check.ps1 dot-sources the pure half above

# --- the tray -----------------------------------------------------------------
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
Add-Type -Namespace Mystical -Name Native -MemberDefinition @'
[System.Runtime.InteropServices.DllImport("user32.dll")]
public static extern bool DestroyIcon(System.IntPtr handle);
'@

# One tray per login: the Startup entry and `mystical app` can both fire.
$fresh = $false
$mutex = [System.Threading.Mutex]::new($true, 'Local\mystical-tray', [ref]$fresh)
if (-not $fresh) { exit 0 }

$IconPath = Join-Path (Split-Path $PSScriptRoot -Parent) 'bridge\dashboard\web\public\icon-192.png'
$Base = $null
try {
  # Into memory: GDI+ keeps reading a bitmap's file, and this one sits on
  # \\wsl$, which goes away whenever the distro stops.
  $stream = New-Object System.IO.MemoryStream(, [System.IO.File]::ReadAllBytes($IconPath))
  $Base = New-Object System.Drawing.Bitmap($stream)
} catch { $Base = $null }

function New-TrayIcon([int]$Count) {
  # The emblem, with the waiting count on an amber badge (the dashboard's --warn).
  $size = 32
  $bmp = New-Object System.Drawing.Bitmap($size, $size)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
  if ($Base) { $g.DrawImage($Base, 0, 0, $size, $size) }
  else { $g.DrawIcon([System.Drawing.SystemIcons]::Application, (New-Object System.Drawing.Rectangle(0, 0, $size, $size))) }
  if ($Count -gt 0) {
    $d = 20
    $x = $size - $d
    $amber = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(0xE3, 0xC2, 0x79))
    $ink = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(0x06, 0x0A, 0x0A))
    $font = New-Object System.Drawing.Font('Segoe UI', 13, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
    $fmt = New-Object System.Drawing.StringFormat
    $fmt.Alignment = [System.Drawing.StringAlignment]::Center
    $fmt.LineAlignment = [System.Drawing.StringAlignment]::Center
    $label = "$Count"
    if ($Count -gt 9) { $label = '9+' }
    $g.FillEllipse($amber, $x, $x, $d, $d)
    $g.DrawString($label, $font, $ink, (New-Object System.Drawing.RectangleF($x, $x, $d, $d)), $fmt)
    $amber.Dispose(); $ink.Dispose(); $font.Dispose(); $fmt.Dispose()
  }
  $g.Dispose()
  $handle = $bmp.GetHicon()
  $bmp.Dispose()
  return @{ icon = [System.Drawing.Icon]::FromHandle($handle); handle = $handle }
}

$tray = New-Object System.Windows.Forms.NotifyIcon
$menu = New-Object System.Windows.Forms.ContextMenuStrip
$tray.ContextMenuStrip = $menu
$state = @{ prev = $null; titles = @{}; rows = @(); up = $false; busy = $null
            shown = -1; key = $null; handle = [IntPtr]::Zero; balloon = $null
            job = $null; jobCmd = $null; jobLog = $null; inflight = $false
            sentAt = [datetime]::MinValue; ticks = 0 }

function Update-Icon {
  $n = $state.rows.Count
  if ($n -eq $state.shown) { return }
  $state.shown = $n
  $made = New-TrayIcon $n
  $tray.Icon = $made.icon
  # The shell keeps its own copy; the handle GetHicon made is ours to free.
  if ($state.handle -ne [IntPtr]::Zero) { [void][Mystical.Native]::DestroyIcon($state.handle) }
  $state.handle = $made.handle
}

function Update-Menu {
  $head = Get-MenuHead $state.busy $state.up $state.rows.Count
  $key = $head + '|' + ((@($state.rows) | ForEach-Object { $_.id + '=' + $_.title }) -join '|')
  # Rebuilding an open menu closes it under the cursor; the next poll catches up.
  if ($key -eq $state.key -or $menu.Visible) { return }
  $state.key = $key
  $menu.Items.Clear()
  $item = $menu.Items.Add($head); $item.Enabled = $false
  foreach ($row in $state.rows) {
    $item = $menu.Items.Add('    ' + $row.title)
    $item.Tag = $row.id
    $item.add_Click({ param($s, $e) Open-Dashboard $s.Tag })
  }
  [void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))
  $item = $menu.Items.Add('Open dashboard'); $item.add_Click({ Open-Dashboard '' })
  $idle = -not $state.busy
  $item = $menu.Items.Add('Start bridge'); $item.Enabled = ($idle -and -not $state.up); $item.add_Click({ Invoke-Bridge 'start' })
  $item = $menu.Items.Add('Stop bridge'); $item.Enabled = ($idle -and $state.up); $item.add_Click({ Invoke-Bridge 'stop' })
  $item = $menu.Items.Add('Restart bridge'); $item.Enabled = ($idle -and $state.up); $item.add_Click({ Invoke-Bridge 'restart' })
  [void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))
  $item = $menu.Items.Add('Quit tray'); $item.add_Click({ [System.Windows.Forms.Application]::Exit() })
}

function Receive-Poll($Running) {
  $r = Step-Poll $state.prev $Running $state.titles
  $state.prev = $r.prev
  $state.rows = @($r.waiting)
  $state.up = ($null -ne $Running)
  if ($r.news.Count -gt 0) {
    $b = Get-Balloon $r.news
    $state.balloon = $b.id
    $tray.ShowBalloonTip(10000, $b.title, $b.body, [System.Windows.Forms.ToolTipIcon]::None)
  }
  Update-Icon
  Update-Menu
  $tray.Text = Get-Tooltip $state.up $state.rows.Count
}

$web = New-Object System.Net.WebClient
$web.Proxy = $null                    # a system proxy must never see localhost
$web.Encoding = [System.Text.Encoding]::UTF8
$web.add_DownloadStringCompleted({
  param($s, $e)
  $state.inflight = $false
  $running = $null
  if (-not $e.Cancelled -and -not $e.Error) {
    try { $running = $e.Result | ConvertFrom-Json } catch { $running = $null }
  }
  Receive-Poll $running
})

function Start-Poll {
  if ($state.inflight) {
    # WebClient has no timeout of its own: a bridge that accepts and never
    # answers would otherwise hold this one request forever.
    if (((Get-Date) - $state.sentAt).TotalSeconds -gt 3) { $web.CancelAsync() }
    return
  }
  $state.inflight = $true
  $state.sentAt = Get-Date
  $web.DownloadStringAsync([uri](Get-BridgeUrl $Port '/local/running'))
}

function Open-Dashboard([string]$Sid) {
  $start = $null
  try {
    $req = [System.Net.HttpWebRequest]::Create((Get-BridgeUrl $Port '/manifest.webmanifest'))
    $req.Proxy = $null
    $req.Timeout = 2000
    $resp = $req.GetResponse()
    try { $start = ((New-Object System.IO.StreamReader($resp.GetResponseStream())).ReadToEnd() | ConvertFrom-Json).start_url }
    finally { $resp.Close() }
  } catch { $start = $null }          # no manifest: the window opens without the token
  $url = Get-SessionUrl $Port $start $Sid
  if ($Browser -and (Test-Path -LiteralPath $Browser)) {
    Start-Process -FilePath $Browser -ArgumentList (Get-BrowserArgs $BrowserProfile $url)
  } else {
    Start-Process $url
  }
}

function Invoke-Bridge([string]$Cmd) {
  $words = @{ start = 'starting'; stop = 'stopping'; restart = 'restarting' }
  $state.busy = "$GlyphBusy " + $words[$Cmd]
  $state.jobCmd = $Cmd
  $state.jobLog = Join-Path $env:TEMP "mystical-tray-$Cmd.log"
  try {
    $how = @{ FilePath = 'wsl.exe'; ArgumentList = (Get-BridgeArgs $Distro $User $Repo $Cmd)
              WindowStyle = 'Hidden'; PassThru = $true
              RedirectStandardOutput = $state.jobLog; RedirectStandardError = ($state.jobLog + '.err') }
    $p = Start-Process @how
    $null = $p.Handle                 # without this, ExitCode reads back empty after exit
    $state.job = $p
  } catch {
    $state.busy = $null
    [void][System.Windows.Forms.MessageBox]::Show("Couldn't run wsl.exe: $_", 'mystical')
  }
  Update-Menu
}

function Watch-Bridge {
  $p = $state.job
  if ($null -eq $p -or -not $p.HasExited) { return }
  $state.job = $null
  $state.busy = $null
  Update-Menu
  if ($p.ExitCode -ne 0) {
    $tail = @(Get-Content -Tail 12 -Path $state.jobLog, ($state.jobLog + '.err') -ErrorAction SilentlyContinue) -join "`n"
    [void][System.Windows.Forms.MessageBox]::Show("mystical $($state.jobCmd) failed (exit $($p.ExitCode))`n`n$tail", 'mystical')
  }
}

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 1000
$timer.add_Tick({
  $state.ticks += 1
  Watch-Bridge
  if ($state.ticks % 4 -eq 0) { Start-Poll }
})
$tray.add_MouseClick({ param($s, $e) if ($e.Button -eq [System.Windows.Forms.MouseButtons]::Left) { Open-Dashboard '' } })
$tray.add_BalloonTipClicked({ Open-Dashboard $state.balloon })

Update-Icon
Update-Menu
$tray.Text = Get-Tooltip $false 0
$tray.Visible = $true
Start-Poll
$timer.Start()
[System.Windows.Forms.Application]::Run()

# Quit tray: take the icon down now, not when the mouse next passes over it.
$timer.Stop()
$tray.Visible = $false
$tray.Dispose()
$mutex.ReleaseMutex()
