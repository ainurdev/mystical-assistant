#!/usr/bin/env bash
#
# build.sh — compile Mystical.exe and install it into %LOCALAPPDATA%\Programs\Mystical.
# Run by `mystical app` on WSL and offered by setup.sh there.
#   build.sh            build + install (quits and reopens a running app)
#   build.sh --check    run windows/check, the pure core's asserts, instead
#   MYSTICAL_APP_DEST=<Windows path>   a dev copy there: no quit, no registry, no reopen
#   MYSTICAL_APP_REPO=<WSL path>       stamp another checkout (a worktree build that
#                                      should drive the live bridge)
#
# Needs the .NET SDK on the Windows side (winget install Microsoft.DotNet.SDK.10)
# and nothing else: WinForms ships with it, WebView2's SDK is the one package
# restored, and the WebView2 runtime is on every Windows 10/11 with Edge.
#
# The build runs on the Windows side. The sources are staged into
# %LOCALAPPDATA%\Mystical\build, because obj/ on a \\wsl.localhost share is slow
# and MSBuild dislikes a UNC working directory; nothing is written into the
# checkout. The TargetFramework follows the installed SDK's major, so no second
# targeting pack is fetched and the runtime always matches.
#
# The installed exe carries five facts about where it was built, in mystical.json
# beside it, so the app can find the bridge without guessing: repo (this
# checkout, or MYSTICAL_APP_REPO), distro, user, path (this shell's PATH —
# wsl.exe -e hands a command a bare one) and version. Rebuild after moving the
# checkout or changing your PATH.

set -euo pipefail
HERE="$(cd "$(dirname "$(realpath "$0")")" && pwd)"
REPO="$(dirname "$HERE")"
ICON_SRC="$REPO/bridge/dashboard/web/public/icon-192.png"
CMD=/mnt/c/Windows/System32/cmd.exe
REG=/mnt/c/Windows/System32/reg.exe
PS=/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe

if [ -t 1 ]; then c_g=$'\033[32m'; c_r=$'\033[31m'; c_y=$'\033[33m'; c_c=$'\033[36m'; c_d=$'\033[2m'; c_0=$'\033[0m'
else c_g=; c_r=; c_y=; c_c=; c_d=; c_0=; fi
ok()   { printf '  %s✔%s %s\n' "$c_g" "$c_0" "$*"; }
warn() { printf '  %s▲%s %s\n' "$c_y" "$c_0" "$*"; }
die()  { printf '  %s✘%s %s\n' "$c_r" "$c_0" "$*" >&2; exit 1; }
# One Windows environment variable, through cmd.exe: the one exe always there.
# Its UNC-cwd grumble goes to stderr; the value is on stdout.
winenv() { "$CMD" /c "echo %$1%" 2>/dev/null | tr -d '\r'; }
# Start a Windows exe detached. Not `cmd.exe /c start`: run from WSL, that waits
# for its GUI child to exit (so would anything that called it); Start-Process
# returns at once and the exe outlives powershell.exe.
launch() { "$PS" -NoProfile -Command "Start-Process -FilePath '$1'" >/dev/null 2>&1 </dev/null; }

grep -qi microsoft /proc/sys/kernel/osrelease 2>/dev/null || die "Mystical.exe builds from WSL2 only."
[ -x "$CMD" ] || die "no Windows side at /mnt/c — Mystical.exe builds from WSL2 only."
DOTNET="$(command -v dotnet.exe 2>/dev/null || true)"
[ -n "$DOTNET" ] || [ ! -x "/mnt/c/Program Files/dotnet/dotnet.exe" ] || DOTNET="/mnt/c/Program Files/dotnet/dotnet.exe"
[ -n "$DOTNET" ] || die "dotnet not found — install the .NET SDK on Windows: winget install Microsoft.DotNet.SDK.10"
MAJOR="$("$DOTNET" --version 2>/dev/null | tr -d '\r' | cut -d. -f1)"
[ "${MAJOR:-0}" -ge 8 ] 2>/dev/null || die ".NET SDK 8 or newer is needed (found ${MAJOR:-none}) — winget install Microsoft.DotNet.SDK.10"
LAD_WIN="$(winenv LOCALAPPDATA)"
case "$LAD_WIN" in ?:\\*) ;; *) die "couldn't read %LOCALAPPDATA% from cmd.exe (got '$LAD_WIN')" ;; esac
LAD="$(wslpath -u "$LAD_WIN")"
STAGE="$LAD/Mystical/build"

# Copies, not links: the Windows side can't follow the checkout's symlinks, and
# a stale obj/ from another SDK would otherwise poison the build.
stage() {
  mkdir -p "$STAGE"
  rm -rf "$STAGE/app" "$STAGE/check"
  cp -r "$HERE/app" "$STAGE/app"
  cp -r "$HERE/check" "$STAGE/check"
  # The TargetFramework follows the installed SDK, rewritten in the staged copy:
  # a -p:TargetFramework override is ignored by `dotnet run`'s implicit restore
  # (NETSDK1005), and the checkout's csproj keeps its floor either way.
  sed -i "s|<TargetFramework>net8.0|<TargetFramework>net${MAJOR}.0|" "$STAGE/app/Mystical.csproj" "$STAGE/check/Check.csproj"
}

if [ "${1:-}" = "--check" ]; then
  stage
  cd "$STAGE"
  exec "$DOTNET" run --project "$(wslpath -w "$STAGE/check/Check.csproj")" -c Release
fi
[ -z "${1:-}" ] || die "unknown option: $1 — build.sh takes --check or nothing"

printf '  %s🪟%s building Mystical.exe… %s(a minute the first time)%s\n' "$c_c" "$c_0" "$c_d" "$c_0"
stage
# App icon from the dashboard's own PWA icon: a PNG-in-ICO with one 192px entry,
# which Windows takes since Vista — no PIL, no resizing, nothing to keep in sync.
python3 - "$ICON_SRC" "$STAGE/app/app.ico" <<'PY'
import struct, sys
png = open(sys.argv[1], "rb").read()
w, h = struct.unpack(">II", png[16:24])
entry = struct.pack("<BBBBHHII", w % 256, h % 256, 0, 0, 1, 32, len(png), 22)
open(sys.argv[2], "wb").write(struct.pack("<HHH", 0, 1, 1) + entry + png)
PY
case "$(winenv PROCESSOR_ARCHITECTURE)" in ARM64) RID=win-arm64 ;; *) RID=win-x64 ;; esac
OUT="$STAGE/out"
rm -rf "$OUT"
LOG="$(mktemp -t mystical-app-build.XXXXXX)"
if ! ( cd "$STAGE" && "$DOTNET" publish "$(wslpath -w "$STAGE/app/Mystical.csproj")" -c Release -r "$RID" \
       --self-contained false -o "$(wslpath -w "$OUT")" ) >"$LOG" 2>&1; then
  tr -d '\r' <"$LOG" | grep -E 'error' | sed 's/\[C:.*\]$//' | sort -u | head -20 >&2 || true
  die "dotnet publish failed — full log: $LOG"
fi
[ -f "$OUT/Mystical.exe" ] || die "built, but no Mystical.exe in $OUT"

# PATH minus pyenv shims (they'd move python3 off the interpreter the bridge runs on).
APP_PATH="$(printf '%s' "$PATH" | tr ':' '\n' | grep -v '/\.pyenv/shims' | awk 'NF && !seen[$0]++' | paste -sd: -)"
VERSION="$(git -C "$REPO" describe --tags --always --dirty 2>/dev/null || echo dev)"
python3 - "$OUT/mystical.json" "${MYSTICAL_APP_REPO:-$REPO}" "${WSL_DISTRO_NAME:-Ubuntu}" "$(id -un)" "$APP_PATH" "$VERSION" <<'PY'
import json, sys
out, repo, distro, user, path, version = sys.argv[1:]
with open(out, "w") as f:
    json.dump({"repo": repo, "distro": distro, "user": user, "path": path, "version": version}, f, indent=2)
PY
cp "$ICON_SRC" "$OUT/icon.png"
cp "$STAGE/app/app.ico" "$OUT/app.ico"

# Swap a built tree into place: rename-old, move, delete-old, so a failed step
# leaves whatever was there alone.
swap_in() {
  mkdir -p "$(dirname "$2")"
  rm -rf "$2.old"
  [ -d "$2" ] && mv "$2" "$2.old"
  mv "$1" "$2"
  rm -rf "$2.old"
}

# A dev copy: nothing running is touched, nothing is registered.
if [ -n "${MYSTICAL_APP_DEST:-}" ]; then
  swap_in "$OUT" "$(wslpath -u "$MYSTICAL_APP_DEST")"
  ok "Mystical.exe $VERSION → $MYSTICAL_APP_DEST ${c_d}(dev copy, not installed)${c_0}"
  exit 0
fi

DEST="$LAD/Programs/Mystical"
EXE_WIN="$(wslpath -w "$DEST/Mystical.exe")"
was_running=0
# Quit the installed app over its pipe; the files can't be swapped under a
# running exe. A stuck one is killed after 5 s.
if [ -x "$DEST/Mystical.exe" ] && "$DEST/Mystical.exe" --quit >/dev/null 2>&1; then
  was_running=1
  for _ in 1 2 3 4 5 6 7 8 9 10; do tasklist.exe 2>/dev/null | grep -q '^Mystical.exe' || break; sleep 0.5; done
  if tasklist.exe 2>/dev/null | grep -q '^Mystical.exe'; then taskkill.exe /IM Mystical.exe /F >/dev/null 2>&1 || true; fi
fi
# The PowerShell tray, if one is up: the exe is its replacement.
if [ -x "$PS" ]; then
  stopped="$("$PS" -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='powershell.exe'\" | Where-Object { \$_.CommandLine -match 'tray\\.ps1' } | ForEach-Object { Stop-Process -Id \$_.ProcessId -Force; 'stopped' }" 2>/dev/null | tr -d '\r' | grep -c stopped || true)"
  [ "${stopped:-0}" -gt 0 ] && was_running=1
fi
swap_in "$OUT" "$DEST"
# mystical:// links open the exe (Core/DeepLink.cs); a Start Menu entry so it is
# searchable. HKCU only — nothing here needs an administrator.
"$REG" add "HKCU\Software\Classes\mystical" /ve /d "URL:mystical" /f >/dev/null
"$REG" add "HKCU\Software\Classes\mystical" /v "URL Protocol" /d "" /f >/dev/null
"$REG" add "HKCU\Software\Classes\mystical\DefaultIcon" /ve /d "$EXE_WIN,0" /f >/dev/null
"$REG" add "HKCU\Software\Classes\mystical\shell\open\command" /ve /d "\"$EXE_WIN\" \"%1\"" /f >/dev/null
APPDATA_WIN="$(winenv APPDATA)"
if [ -x "$PS" ] && [ -n "$APPDATA_WIN" ]; then
  "$PS" -NoProfile -Command "\$s = (New-Object -ComObject WScript.Shell).CreateShortcut('$APPDATA_WIN\\Microsoft\\Windows\\Start Menu\\Programs\\Mystical.lnk'); \$s.TargetPath = '$EXE_WIN'; \$s.WorkingDirectory = '$(wslpath -w "$DEST")'; \$s.IconLocation = '$EXE_WIN,0'; \$s.Description = 'mystical//assistant'; \$s.Save()" >/dev/null 2>&1 \
    || warn "couldn't write the Start Menu shortcut (the app still runs from $EXE_WIN)"
fi
ok "Mystical.exe $VERSION → $(wslpath -w "$DEST")"
[ "$was_running" = 1 ] && launch "$EXE_WIN"
exit 0
