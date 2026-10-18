#!/bin/bash
# Remove Share this device, undoing setup.sh:  remove.sh <owner>
# bridge/device_setup.py runs this as root, behind one macOS admin-password prompt.
# The wall around the bridge's ports comes down only once the hidden user is gone.
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
PF_ANCHOR=com.apple/mysticalruns
PF_LABEL=cloud.ainurhq.mystical-runs.pf
PF_RULES=/usr/local/etc/mystical-runs.pf
PF_TOKEN=/usr/local/etc/mystical-runs.pf.token
PF_DAEMON=/Library/LaunchDaemons/cloud.ainurhq.mystical-runs.pf.plist

# Take RUN_USER's line out of each deny file Set up added it to, writing the same
# file (its owner and mode stay). A file grep can't read is left as it was:
# emptied, it would let in every user it denies. One that can't be written (the
# cron folder is closed to root since macOS 26) keeps the line, denying an
# account that is gone.
allow_cron() { # allow_cron FILE...
  local f rest
  for f in "$@"; do
    if [ -L "$f" ] || [ ! -f "$f" ] || ! grep -qxF "$RUN_USER" "$f"; then continue; fi
    rest=$(grep -vxF "$RUN_USER" "$f") || [ $? -eq 1 ] || continue
    { if [ -n "$rest" ]; then printf '%s\n' "$rest" >"$f"; else : >"$f"; fi; } ||
      echo "$f can't be written on this macOS; the hidden user's line stays there."
  done
}

# Takes the wall down: the boot job, the rule, pf's reference and the files. Any
# part may be gone already. (setup.sh and remove.sh have this same function.)
unwall() {
  local token=""
  launchctl bootout "system/$PF_LABEL" >/dev/null 2>&1 || true
  pfctl -a "$PF_ANCHOR" -F all >/dev/null 2>&1 || true
  if [ -f "$PF_TOKEN" ]; then
    read -r token <"$PF_TOKEN" || true
    [ -z "$token" ] || pfctl -X "$token" >/dev/null 2>&1 || true
  fi
  rm -f "$PF_DAEMON" "$PF_RULES" "$PF_TOKEN"
}

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

# 4. The wall Set up put between the hidden user and this bridge's ports.
step="Taking down the wall around this bridge"
unwall

# 5. Cron and at may take the name again (Set up denied it both).
step="Taking the hidden user out of the cron and at deny lists"
allow_cron /private/var/at/cron.deny /private/var/at/at.deny

# 6. The helper, its config, its lock, the sudoers rule, the Claude copy, and the
#    runs folder. The lock's folders go too when nothing else is in them.
step="Removing the helper"
rm -f /usr/local/libexec/mystical-run-helper /usr/local/etc/mystical-runs.json /etc/sudoers.d/mystical-runs \
  /usr/local/var/run/mystical-runs.lock
rmdir /usr/local/var/run /usr/local/var 2>/dev/null || true
rm -rf /usr/local/libexec/mystical-runs "/Users/Shared/Mystical Runs"

trap - ERR
printf '{"ok": true}\n' >&3
