#!/usr/bin/env bash
# probe.sh [dir] — ask the running Mystical.exe to write window.png + state.json
# into dir (default: a fresh temp dir), then print the dir. See app/Probe.cs.
# The dir is a WSL path; the app gets it as \\wsl.localhost\<distro>\… (wslpath -w)
# and writes there through the share. MYSTICAL_APP_EXE names another exe (a dev
# copy); the installed one is the default.
set -euo pipefail
dir="${1:-$(mktemp -d -t mystical-probe.XXXXXX)}"
case "$dir" in /*) ;; *) dir="$PWD/$dir" ;; esac
mkdir -p "$dir"; rm -f "$dir/window.png" "$dir/state.json"
exe="${MYSTICAL_APP_EXE:-}"
if [ -z "$exe" ]; then
  lad="$(/mnt/c/Windows/System32/cmd.exe /c "echo %LOCALAPPDATA%" 2>/dev/null | tr -d '\r')"
  exe="$(wslpath -u "$lad")/Programs/Mystical/Mystical.exe"
fi
[ -x "$exe" ] || { echo "Mystical.exe not found at $exe — build it: mystical app" >&2; exit 1; }
# The exe is its own pipe client: it prints the app's reply and exits 2 when no
# instance answers. The app writes the files before it replies.
if ! out="$("$exe" --probe "$(wslpath -w "$dir")" 2>&1)"; then
  echo "${out:-no answer from Mystical.exe}" >&2; exit 1
fi
for _ in $(seq 1 40); do [ -f "$dir/state.json" ] && break; sleep 0.25; done
[ -f "$dir/state.json" ] || { echo "no state.json from Mystical.exe in 10s — is it the current build? (mystical app)" >&2; exit 1; }
echo "$dir"
