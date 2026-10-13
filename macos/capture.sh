#!/usr/bin/env bash
# capture.sh [-w <window title or app>] [dir] — ask the running Mystical.app for a
# real screen capture: the main display, or the first window whose title or app
# name contains the -w text. Writes <dir>/capture.png + capture.json and prints
# the PNG path; on failure prints the error and exits 1.
#
# Why through the app: captures need Screen Recording permission, which macOS
# grants per app. A bridge session's shell never has it (so `screencapture`
# returns the wallpaper); Mystical.app can hold it — macOS asks the first time,
# and the app has to be relaunched after it's allowed. See Sources/Mystical/Capture.swift.
set -euo pipefail
window=""
while [ $# -gt 0 ]; do
  case "$1" in
    -w|--window) window="${2:-}"; shift 2 ;;
    -h|--help) sed -n '2,5p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) break ;;
  esac
done
dir="${1:-$(mktemp -d -t mystical-capture)}"
case "$dir" in /*) ;; *) dir="$PWD/$dir" ;; esac
mkdir -p "$dir"; rm -f "$dir/capture.png" "$dir/capture.json"
pgrep -xq Mystical || { echo "Mystical.app is not running — open it first: mystical app open" >&2; exit 1; }
export MYSTICAL_REQ
MYSTICAL_REQ="$(python3 -c 'import json,sys; print(json.dumps({"dir": sys.argv[1], "window": sys.argv[2]}))' "$dir" "$window")"
swift -e 'import Foundation
DistributedNotificationCenter.default().postNotificationName(.init("cloud.ainurhq.mystical.capture"), object: ProcessInfo.processInfo.environment["MYSTICAL_REQ"], userInfo: nil, deliverImmediately: true)' 2>/dev/null \
  || osascript -l JavaScript -e "ObjC.import('Foundation'); \$.NSDistributedNotificationCenter.defaultCenter.postNotificationNameObjectUserInfoDeliverImmediately('cloud.ainurhq.mystical.capture', \$.NSProcessInfo.processInfo.environment.objectForKey('MYSTICAL_REQ'), \$(), true)" >/dev/null
# The permission prompt, if any, is the app's; the app answers here either way.
for _ in $(seq 1 60); do [ -f "$dir/capture.json" ] && break; sleep 0.25; done
[ -f "$dir/capture.json" ] || { echo "no answer from Mystical.app in 15s — is it the current build? (mystical app)" >&2; exit 1; }
python3 - "$dir" <<'PY'
import json, sys
d = sys.argv[1]
r = json.load(open(f"{d}/capture.json"))
if r.get("ok"):
    print(f"{d}/capture.png")
else:
    print(r.get("error", "capture failed"), file=sys.stderr)
    if r.get("windows"):
        print("windows seen: " + ", ".join(w.get("title") or w.get("app", "?") for w in r["windows"][:12]), file=sys.stderr)
    sys.exit(1)
PY
