#!/usr/bin/env bash
# capture.sh [-w <window title or app>] [dir] — ask the running Mystical.exe for a
# real screen capture: the primary display, or the first window whose title or
# app name contains the -w text. Writes <dir>/capture.png + capture.json and
# prints the PNG path; on failure prints the error (and the windows the app
# could see) and exits 1. See app/Capture.cs.
#
# Why through the app: a bridge session lives in WSL and has no screen at all;
# the app runs on the Windows side and can read it — no permission to grant
# there. The dir is a WSL path; the app gets it as \\wsl.localhost\<distro>\…
# MYSTICAL_APP_EXE names another exe (a dev copy); the installed one is the default.
set -euo pipefail
window=""
while [ $# -gt 0 ]; do
  case "$1" in
    -w|--window) window="${2:-}"; shift 2 ;;
    -h|--help) sed -n '2,6p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) break ;;
  esac
done
dir="${1:-$(mktemp -d -t mystical-capture.XXXXXX)}"
case "$dir" in /*) ;; *) dir="$PWD/$dir" ;; esac
mkdir -p "$dir"; rm -f "$dir/capture.png" "$dir/capture.json"
exe="${MYSTICAL_APP_EXE:-}"
if [ -z "$exe" ]; then
  lad="$(/mnt/c/Windows/System32/cmd.exe /c "echo %LOCALAPPDATA%" 2>/dev/null | tr -d '\r')"
  exe="$(wslpath -u "$lad")/Programs/Mystical/Mystical.exe"
fi
[ -x "$exe" ] || { echo "Mystical.exe not found at $exe — build it: mystical app" >&2; exit 1; }
args=(--capture "$(wslpath -w "$dir")")
[ -n "$window" ] && args+=(-w "$window")
# The exe is its own pipe client: it prints the app's reply and exits 2 when no
# instance answers. The app writes the files before it replies.
out="$("$exe" "${args[@]}" 2>&1)" || { rc=$?; [ $rc -eq 2 ] && { echo "$out" >&2; exit 1; }; }
python3 - "$dir" "$out" <<'PY'
import json, os, sys
d, out = sys.argv[1], sys.argv[2]
try:
    r = json.load(open(f"{d}/capture.json")) if os.path.isfile(f"{d}/capture.json") else json.loads(out)
except ValueError:
    print(out or "no answer from Mystical.exe", file=sys.stderr); sys.exit(1)
if r.get("ok"):
    print(f"{d}/capture.png")
else:
    print(r.get("error", "capture failed"), file=sys.stderr)
    if r.get("windows"):
        print("windows seen: " + ", ".join(w.get("title") or w.get("app", "?") for w in r["windows"][:12]), file=sys.stderr)
    sys.exit(1)
PY
