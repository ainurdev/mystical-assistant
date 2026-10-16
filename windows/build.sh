#!/usr/bin/env bash
#
# build.sh — compile Mystical.exe and install it into %LOCALAPPDATA%\Programs\Mystical.
# Run by `mystical app` on WSL and offered by setup.sh there.
#   build.sh            build + install (quits and reopens a running app)
#   build.sh --check    run windows/check, the pure core's asserts, instead
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

if [ -t 1 ]; then c_g=$'\033[32m'; c_r=$'\033[31m'; c_c=$'\033[36m'; c_d=$'\033[2m'; c_0=$'\033[0m'
else c_g=; c_r=; c_c=; c_d=; c_0=; fi
ok()  { printf '  %s✔%s %s\n' "$c_g" "$c_0" "$*"; }
die() { printf '  %s✘%s %s\n' "$c_r" "$c_0" "$*" >&2; exit 1; }

grep -qi microsoft /proc/sys/kernel/osrelease 2>/dev/null || die "Mystical.exe builds from WSL2 only."
[ -x "$CMD" ] || die "no Windows side at /mnt/c — Mystical.exe builds from WSL2 only."
DOTNET="$(command -v dotnet.exe 2>/dev/null || true)"
[ -n "$DOTNET" ] || [ ! -x "/mnt/c/Program Files/dotnet/dotnet.exe" ] || DOTNET="/mnt/c/Program Files/dotnet/dotnet.exe"
[ -n "$DOTNET" ] || die "dotnet not found — install the .NET SDK on Windows: winget install Microsoft.DotNet.SDK.10"
MAJOR="$("$DOTNET" --version 2>/dev/null | tr -d '\r' | cut -d. -f1)"
[ "${MAJOR:-0}" -ge 8 ] 2>/dev/null || die ".NET SDK 8 or newer is needed (found ${MAJOR:-none}) — winget install Microsoft.DotNet.SDK.10"
# %LOCALAPPDATA% through cmd.exe: the one Windows exe that is always there. Its
# UNC-cwd grumble goes to stderr; the value is on stdout.
LAD_WIN="$("$CMD" /c "echo %LOCALAPPDATA%" 2>/dev/null | tr -d '\r')"
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
die "publish is not built yet (Task 3)"
