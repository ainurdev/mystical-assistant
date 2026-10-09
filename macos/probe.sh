#!/usr/bin/env bash
# probe.sh [dir] — ask the running Mystical.app to write window.png + state.json
# into dir (default: a fresh temp dir), then print the dir. See Sources/Mystical/Probe.swift.
set -euo pipefail
dir="${1:-$(mktemp -d -t mystical-probe)}"
case "$dir" in /*) ;; *) dir="$PWD/$dir" ;; esac
mkdir -p "$dir"; rm -f "$dir/window.png" "$dir/state.json"
swift -e 'import Foundation
DistributedNotificationCenter.default().postNotificationName(.init("cloud.ainurhq.mystical.probe"), object: CommandLine.arguments[1], userInfo: nil, deliverImmediately: true)' "$dir" 2>/dev/null \
  || osascript -l JavaScript -e "ObjC.import('Foundation'); \$.NSDistributedNotificationCenter.defaultCenter.postNotificationNameObjectUserInfoDeliverImmediately('cloud.ainurhq.mystical.probe', '$dir', \$(), true)" >/dev/null
for _ in $(seq 1 40); do [ -f "$dir/state.json" ] && [ -f "$dir/window.png" ] && break; sleep 0.25; done
echo "$dir"
