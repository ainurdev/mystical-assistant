#!/usr/bin/env bash
#
# build.sh — compile Mystical.app and install it into ~/Applications.
# Run by `mystical app` and offered by setup.sh on macOS.
#
# Needs only the Command Line Tools (swift, codesign, sips, iconutil) — no Xcode,
# no Apple Developer account. Ad-hoc signed: a bundle built on this machine is
# never quarantined, so Gatekeeper has nothing to ask.
#
# The bundle carries two facts about where it was built, so the app can find the
# bridge without guessing:  MysticalRepo (this checkout) and MysticalPath (this
# shell's PATH — Finder hands apps a PATH with no npm, claude or Homebrew).
# Rebuild from the checkout you run, after moving it or changing your PATH.

set -euo pipefail
HERE="$(cd "$(dirname "$(realpath "$0")")" && pwd)"
REPO="$(dirname "$HERE")"
DEST="${MYSTICAL_APP_DEST:-$HOME/Applications/Mystical.app}"
ID="cloud.ainurhq.mystical"
ICON_SRC="$REPO/bridge/dashboard/web/public/icon-512.png"

if [ -t 1 ]; then c_g=$'\033[32m'; c_r=$'\033[31m'; c_c=$'\033[36m'; c_d=$'\033[2m'; c_0=$'\033[0m'
else c_g=; c_r=; c_c=; c_d=; c_0=; fi
ok()  { printf '  %s✔%s %s\n' "$c_g" "$c_0" "$*"; }
die() { printf '  %s✘%s %s\n' "$c_r" "$c_0" "$*" >&2; exit 1; }

[ "$(uname -s)" = Darwin ] || die "Mystical.app is macOS-only."
command -v swift >/dev/null 2>&1 || die "swift not found — install the Command Line Tools: xcode-select --install"

printf '  %s🍎%s building Mystical.app… %s(a minute the first time)%s\n' "$c_c" "$c_0" "$c_d" "$c_0"
LOG="$(mktemp -t mystical-app-build)"
if ! swift build -c release --package-path "$HERE" >"$LOG" 2>&1; then
  grep -E 'error:' "$LOG" | sed 's/\x1b\[[0-9;]*m//g' | head -20 >&2 || true
  die "swift build failed — full log: $LOG"
fi
BIN="$(swift build -c release --package-path "$HERE" --show-bin-path)/Mystical"
[ -x "$BIN" ] || die "built, but no binary at $BIN"

# Stage beside nothing that matters: a failed step below leaves the installed app alone.
WORK="$(mktemp -d -t mystical-app)"
trap 'rm -rf "$WORK"' EXIT
APP="$WORK/Mystical.app"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$BIN" "$APP/Contents/MacOS/Mystical"

# App icon from the dashboard's own PWA icon. 512 is the largest source, so the
# 512@2x slot is an upscale — fine for a Dock icon, and nothing to keep in sync.
ICONSET="$WORK/AppIcon.iconset"
mkdir -p "$ICONSET"
for s in 16 32 128 256 512; do
  sips -z "$s" "$s" "$ICON_SRC" --out "$ICONSET/icon_${s}x${s}.png" >/dev/null
  sips -z "$((s * 2))" "$((s * 2))" "$ICON_SRC" --out "$ICONSET/icon_${s}x${s}@2x.png" >/dev/null
done
iconutil -c icns "$ICONSET" -o "$APP/Contents/Resources/AppIcon.icns"

# PATH minus pyenv shims (they'd move python3 off the interpreter the bridge runs on).
APP_PATH="$(printf '%s' "$PATH" | tr ':' '\n' | grep -v '/\.pyenv/shims' | awk 'NF && !seen[$0]++' | paste -sd: -)"
VERSION="$(git -C "$REPO" describe --tags --always --dirty 2>/dev/null || echo dev)"
BUILD="$(git -C "$REPO" rev-list --count HEAD 2>/dev/null || echo 1)"
python3 - "$APP/Contents/Info.plist" "$REPO" "$APP_PATH" "$VERSION" "$BUILD" "$ID" <<'PY'
import plistlib, sys
out, repo, path, version, build, ident = sys.argv[1:]
plistlib.dump({
    "CFBundleIdentifier": ident,
    "CFBundleName": "Mystical",
    "CFBundleDisplayName": "Mystical",
    "CFBundleExecutable": "Mystical",
    "CFBundleIconFile": "AppIcon",
    "CFBundlePackageType": "APPL",
    "CFBundleShortVersionString": "1.0",
    "CFBundleVersion": build,
    "LSMinimumSystemVersion": "14.0",
    "LSApplicationCategoryType": "public.app-category.developer-tools",
    "NSHighResolutionCapable": True,
    "NSHumanReadableCopyright": "MIT · mystical//assistant " + version,
    # The dashboard is plain http on loopback.
    "NSAppTransportSecurity": {"NSAllowsLocalNetworking": True},
    "MysticalRepo": repo,
    "MysticalPath": path,
    "MysticalVersion": version,
}, open(out, "wb"))
PY

codesign --force --sign - "$APP" >/dev/null 2>&1 || die "codesign failed"

# Swap it in. Quitting the app is harmless — launchd owns the bridge, not the app.
was_running=0
if pgrep -xq Mystical; then
  was_running=1
  osascript -e "tell application id \"$ID\" to quit" >/dev/null 2>&1 || true
  for _ in 1 2 3 4 5 6 7 8 9 10; do pgrep -xq Mystical || break; sleep 0.5; done
  pkill -x Mystical 2>/dev/null || true
fi
mkdir -p "$(dirname "$DEST")"
rm -rf "$DEST.old"
[ -d "$DEST" ] && mv "$DEST" "$DEST.old"
mv "$APP" "$DEST"
rm -rf "$DEST.old"
ok "Mystical.app $VERSION → ${DEST/#$HOME/~}"
[ "$was_running" = 1 ] && open "$DEST"
exit 0
