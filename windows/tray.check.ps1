# Assertions over windows/tray.ps1's pure half: the cases tests/test_tray.py
# runs against linux/tray.py, so the twins can't drift. No WinForms needed:
#   pwsh -NoProfile -File windows/tray.check.ps1    (powershell.exe on Windows)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'tray.ps1') -Check
$script:failed = 0
function Assert-That([bool]$Ok, [string]$What) {
  if ($Ok) { Write-Host "ok    $What" } else { Write-Host "FAIL  $What"; $script:failed += 1 }
}
function Poll([string]$Json) { return ($Json | ConvertFrom-Json) }

$titles = @{}
$r = Step-Poll $null (Poll '{"status":{"a":{"state":"awaiting","label":"Which DB?"}},"jobs":[]}') $titles
Assert-That ($r.news.Count -eq 0) 'the first poll is a baseline'

$titles = @{}
$r = Step-Poll $null (Poll '{"status":{"a":{"state":"working","label":"running Bash"}},"jobs":[{"session_id":"a","title":"fix login"}]}') $titles
$r = Step-Poll $r.prev (Poll '{"status":{"a":{"state":"awaiting","label":"Which DB?"}},"jobs":[]}') $titles
Assert-That ($r.news.Count -eq 1 -and $r.news[0].title -eq "$GlyphWait fix login" -and $r.news[0].body -eq 'Which DB?') 'waiting alerts once, titled from the job'
Assert-That ($r.waiting.Count -eq 1 -and $r.waiting[0].title -eq 'fix login') 'the waiting row keeps the title'
$again = Step-Poll $r.prev (Poll '{"status":{"a":{"state":"awaiting","label":"Which DB?"}},"jobs":[]}') $titles
Assert-That ($again.news.Count -eq 0) 'still waiting is not news'

$r = Step-Poll @{} (Poll '{"status":{"a":{"state":"parked","label":"usage limit"}},"jobs":[]}') @{ a = 'x' }
Assert-That ($r.news.Count -eq 1 -and $r.news[0].title -eq "$GlyphParked x" -and $r.news[0].body -eq 'usage limit') 'parked alerts'

$prev = ConvertTo-Map (Poll '{"a":{"state":"working","label":"running Bash"}}')
$news = Get-Alerts $prev @{} @{}
Assert-That ($news.Count -eq 1 -and $news[0].title -eq "$GlyphDone session" -and $news[0].body -eq 'finished') 'done falls back to session, never the label'

$prev = ConvertTo-Map (Poll '{"a":{"state":"working"},"b":{"state":"working"}}')
$cur = ConvertTo-Map (Poll '{"a":{"state":"awaiting"},"b":{"state":"parked"}}')
$news = Get-Alerts $prev $cur @{}
Assert-That ($news.Count -eq 2 -and -not ($news | Where-Object { $_.title.StartsWith($GlyphDone) })) 'into awaiting or parked is not done'

$titles = @{}
$r = Step-Poll $null (Poll '{"status":{"a":{"state":"working"}},"jobs":[]}') $titles
$r = Step-Poll $r.prev (Poll '{"status":{"a":{"state":"awaiting"}},"jobs":[],"watched":true}') $titles
Assert-That ($r.news.Count -eq 0) 'watched: no alert'
$r = Step-Poll $r.prev (Poll '{"status":{"a":{"state":"awaiting"}},"jobs":[]}') $titles
Assert-That ($r.news.Count -eq 0) 'the window closes: nothing replays'

$r = Step-Poll $r.prev $null $titles
Assert-That ($null -eq $r.prev -and $r.waiting.Count -eq 0) 'down: no rows, no baseline'
$r = Step-Poll $r.prev (Poll '{"status":{"a":{"state":"awaiting"}},"jobs":[]}') $titles
Assert-That ($r.news.Count -eq 0) 'back up: a fresh baseline'

$status = ConvertTo-Map (Poll '{"b":{"state":"awaiting","label":"Zed?"},"a":{"state":"awaiting"},"c":{"state":"working"}}')
$rows = Get-Waiting $status @{ b = 'alpha' }
Assert-That ($rows.Count -eq 2 -and $rows[0].title -eq 'alpha' -and $rows[1].title -eq 'waiting on you') 'rows sort by title, falling back to waiting on you'

Assert-That ((Get-SessionUrl 8790 '/?token=abc' 's 1') -eq 'http://localhost:8790/?token=abc&s=s%201&skipboot') 'token and session'
Assert-That ((Get-SessionUrl 8790 '/' 's1') -eq 'http://localhost:8790/?s=s1&skipboot') 'no token'
Assert-That ((Get-SessionUrl 8790 $null $null) -eq 'http://localhost:8790/') 'manifest unreachable'
Assert-That ((Get-SessionUrl 8790 '/?token=abc' $null) -eq 'http://localhost:8790/?token=abc') 'open dashboard keeps the token'

$one = Get-Balloon @(@{ id = 'a'; title = "$GlyphWait fix login"; body = 'Which DB?' })
Assert-That ($one.id -eq 'a' -and $one.title -eq "$GlyphWait fix login" -and $one.body -eq 'Which DB?') 'one alert names its session'
$many = Get-Balloon @(@{ id = 'a'; title = 'one'; body = 'x' }, @{ id = 'b'; title = 'two'; body = 'y' })
Assert-That ($null -eq $many.id -and $many.title -eq '2 sessions need you' -and $many.body -eq "one`ntwo") 'several summarise'
$long = Get-Balloon @(@{ id = 'a'; title = ('t' * 80); body = ('b' * 300) })
Assert-That ($long.title.Length -eq 63 -and $long.body.Length -eq 255) 'balloons clip to 63/255'
Assert-That ((Get-Tooltip $true 3) -eq "mystical $Dash 3 waiting on you" -and (Get-Tooltip $false 0) -eq "mystical $Dash stopped") 'tooltip'
Assert-That ((Get-MenuHead '' $true 2) -eq "$GlyphUp running $Dot 2 waiting on you" -and (Get-MenuHead "$GlyphBusy starting" $false 0) -eq "$GlyphBusy starting") 'menu head'

Assert-That ((Get-BridgeArgs 'Ubuntu' 'u' '/home/u/m' 'start') -eq "-d `"Ubuntu`" -u `"u`" -e bash -lic `"'/home/u/m/bin/mystical' start`"") 'wsl.exe argument line'
$ba = Get-BrowserArgs 'Profile 2' 'http://localhost:8790/'
Assert-That (($ba -join ' ') -eq '--profile-directory="Profile 2" --app=http://localhost:8790/') 'browser arguments quote the profile'
$ba = Get-BrowserArgs '' 'http://localhost:8790/'
Assert-That ($ba.Count -eq 1 -and $ba[0] -eq '--app=http://localhost:8790/') 'no profile, no flag'

if ($script:failed) { Write-Host "$($script:failed) failed"; exit 1 }
Write-Host 'all passed'
