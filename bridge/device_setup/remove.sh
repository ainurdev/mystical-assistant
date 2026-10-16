#!/bin/bash
# Remove Share this device, undoing setup.sh:  remove.sh <owner>
# bridge/device_setup.py runs this as root, behind one macOS admin-password prompt.
# Every step can run again. The last line on stdout is the JSON result:
#   {"ok": true}   or   {"ok": false, "error": "..."}
set -euo pipefail     # no -E: a failure inside "$(...)" must fail its own line, not print a result
export LC_ALL=C
exec 3>&1 1>&2        # the tools' chatter goes to stderr; fd 3 carries only the result
cd /

fail() { printf '{"ok": false, "error": "%s"}\n' "$1" >&3; exit 0; }
step="Remove"
trap 'fail "$step failed."' ERR

RUN_USER=mysticalruns
RUN_HOME=/Users/mysticalruns
DENY="user:mysticalruns deny list,search,readattr,readextattr,readsecurity,file_inherit,directory_inherit"

step="Checking your account"
owner=${1:-}
[ "$(id -u)" = 0 ] || fail "Remove has to run as root."
case "$owner" in ""|[!A-Za-z_]*|*[!A-Za-z0-9._-]*) fail "That isn't a macOS account name." ;; esac
home=/Users/$owner

# 1. Stop whatever the hidden user is running.
step="Stopping the hidden user's runs"
pkill -u "$RUN_USER" || true
sleep 1
pkill -KILL -u "$RUN_USER" || true

# 2. The deny rule on the owner's home goes before the user does: chmod finds the
#    rule by the user's name, which stops resolving once the user is deleted.
step="Taking the deny rule off your home folder"
acl=$(ls -led "$home" 2>/dev/null || true)
case "$acl" in *"user:$RUN_USER deny"*) chmod -a "$DENY" "$home" ;; esac

# 3. The user, and its home with everything runs left there.
step="Deleting the hidden user"
if dscl . -read "/Users/$RUN_USER" >/dev/null 2>&1; then
  sysadminctl -deleteUser "$RUN_USER"
fi
# sysadminctl can exit 0 without having deleted the user.
if dscl . -read "/Users/$RUN_USER" >/dev/null 2>&1; then fail "macOS didn't delete the hidden user."; fi
rm -rf "$RUN_HOME"

# 4. The helper, its config, the sudoers rule, the Claude copy, and the runs folder.
step="Removing the helper"
rm -f /usr/local/libexec/mystical-run-helper /usr/local/etc/mystical-runs.json /etc/sudoers.d/mystical-runs
rm -rf /usr/local/libexec/mystical-runs "/Users/Shared/Mystical Runs"

trap - ERR
printf '{"ok": true}\n' >&3
