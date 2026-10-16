#!/bin/bash
# Set up Share this device:  setup.sh <owner>
# bridge/device_setup.py runs this as root, behind one macOS admin-password prompt.
#
# It creates the hidden user mysticalruns, whom teammates' device runs execute as,
# and denies that user the owner's home folder. It installs the root helper
# (mystical_run_helper.py) with a sudoers rule that lets the owner, and only the
# owner, start it without a password. Then it installs Claude Code and copies it
# where only root can change it: runs use that copy, so no run can leave a changed
# Claude behind for the next requester. Last, it checks the tools a run needs.
# Every step can run again. The last line on stdout is the JSON result:
#   {"ok": true, "checks": [...], "error": null}   or   {"ok": false, "error": "..."}
#
# The owner's name is checked before anything uses it, and no variable is ever
# handed to a shell to parse. Before anything is written, every folder from / down
# to the helper, its config and the Claude copy must be root's alone. As root this
# never follows a link someone else could plant: a folder in a place others can
# write is made by its own user (sudo -u), and Claude is read as the hidden user.
set -euo pipefail     # no -E: a failure inside "$(...)" must fail its own line, not print a result
export LC_ALL=C
exec 3>&1 1>&2        # the tools' chatter goes to stderr; fd 3 carries only the result
cd /

fail() { printf '{"ok": false, "error": "%s"}\n' "$1" >&3; exit 0; }
step="Set up"
trap 'fail "$step failed."' ERR

RUN_USER=mysticalruns
RUN_HOME=/Users/mysticalruns
RUN_PATH=/usr/local/libexec/mystical-runs:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin
INSTALLED=$RUN_HOME/.local/bin/claude
CLAUDE_DIR=/usr/local/libexec/mystical-runs
CLAUDE=$CLAUDE_DIR/claude
CLAUDE_SIGNER='=anchor apple generic and identifier "com.anthropic.claude-code" and certificate leaf[subject.OU] = "Q6L2SF6YDW"'
HELPER=/usr/local/libexec/mystical-run-helper
CONFIG=/usr/local/etc/mystical-runs.json
SUDOERS=/etc/sudoers.d/mystical-runs
STAGE_ROOT="/Users/Shared/Mystical Runs"
DENY="user:mysticalruns deny list,search,readattr,readextattr,readsecurity,file_inherit,directory_inherit"
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)

# Fail unless PATH and every folder above it are root's, writable by no one else,
# and not links. This mirrors check_root_path in mystical_run_helper.py.
root_only() { # root_only PATH
  local p="" part IFS=/
  for part in $1; do
    p="${p%/}/$part"
    if [ -L "$p" ]; then fail "$p is a link, so Set up won't put a root helper behind it."; fi
    [ -n "$(find "$p" -maxdepth 0 -user root ! -perm +022 2>/dev/null)" ] ||
      fail "$p can be changed by someone other than root, so Set up won't put a root helper behind it."
  done
}

# 1. Root, and an owner that exists.
step="Checking your account"
owner=${1:-}
[ "$(id -u)" = 0 ] || fail "Set up has to run as root."
case "$owner" in ""|[!A-Za-z_]*|*[!A-Za-z0-9._-]*) fail "That isn't a macOS account name." ;; esac
uid=$(id -u "$owner" 2>/dev/null) || fail "There is no account called $owner."
home=/Users/$owner
if [ ! -d "$home" ] || [ -L "$home" ]; then fail "$home isn't a home folder."; fi

# 2. Before anything is written: the helper, its config and the Claude copy go only
#    where root alone can change every folder above them. Otherwise the owner's
#    passwordless sudo would run whatever replaced them.
step="Checking where the helper goes"
root_only /usr/local
for d in /usr/local/libexec /usr/local/etc "$CLAUDE_DIR"; do
  [ -e "$d" ] || [ -L "$d" ] || install -d -o root -g wheel -m 0755 "$d"
  root_only "$d"
done

# 3. The hidden user, with a random password nobody keeps.
step="Creating the hidden user"
if ! dscl . -read "/Users/$RUN_USER" >/dev/null 2>&1; then
  password=$(openssl rand -base64 24)
  [ -n "$password" ] || fail "No random password could be made."
  sysadminctl -addUser "$RUN_USER" -fullName "Mystical Runs" -password "$password" -home "$RUN_HOME" -shell /bin/zsh
  unset password
  createhomedir -c -u "$RUN_USER"
  dscl . -create "/Users/$RUN_USER" IsHidden 1
fi
# sysadminctl can exit 0 without having made the user.
dscl . -read "/Users/$RUN_USER" >/dev/null 2>&1 || fail "macOS didn't create the hidden user."

# 4. Keep it out of the owner's home: a new standard user joins staff, which can
#    read a home folder, and project folders are world-readable.
step="Keeping the hidden user out of your home folder"
acl=$(ls -led "$home")
case "$acl" in *"user:$RUN_USER deny"*) ;; *) chmod +a "$DENY" "$home" ;; esac

# 5. The runs folders and the helper.
step="Installing the helper"
if [ -L "$STAGE_ROOT" ]; then fail "$STAGE_ROOT is a link."; fi
install -d -o "$owner" -g staff -m 0755 "$STAGE_ROOT"
sudo -u "$RUN_USER" /usr/bin/install -d -m 0700 "$RUN_HOME/runs"
install -o root -g wheel -m 0755 "$here/mystical_run_helper.py" "$HELPER"

# 6. The sudoers rule: the owner may start the helper as root, and nothing else.
step="Letting your account start the helper"
rule=$(mktemp)
printf '%s ALL=(root) NOPASSWD: %s\n' "$owner" "$HELPER" >"$rule"
visudo -cf "$rule"
install -o root -g wheel -m 0440 "$rule" "$SUDOERS"
rm -f "$rule"

# 7. Claude Code, installed for the hidden user, then copied where only root can
#    change it. Runs can write the hidden user's home, so the binary is read from
#    there as that user (a link reaches nothing root-only), and the copy must be
#    the one Anthropic signs.
step="Installing Claude Code for device runs"
[ -e "$INSTALLED" ] || sudo -u "$RUN_USER" -H /bin/bash -c 'curl -fsSL https://claude.ai/install.sh | bash'
copy=$(mktemp "$CLAUDE_DIR/claude.XXXXXX")
if ! sudo -u "$RUN_USER" /bin/cat "$INSTALLED" >"$copy"; then
  rm -f "$copy"
  fail "Claude Code didn't install for the hidden user."
fi
if ! codesign --verify --strict -R "$CLAUDE_SIGNER" "$copy"; then
  rm -f "$copy"
  fail "The Claude Code that was installed isn't the one Anthropic signs."
fi
chmod 0755 "$copy"
mv -f "$copy" "$CLAUDE"

# 8. The config names Claude only now that the copy is there: that key is how the
#    owner's bridge sees Claude installed without looking inside the hidden home.
step="Recording the setup"
printf '{"owner": "%s", "uid": %s, "launch": "sudo", "claude": "%s"}\n' "$owner" "$uid" "$CLAUDE" >"$CONFIG.new"
chmod 0644 "$CONFIG.new"
mv -f "$CONFIG.new" "$CONFIG"

# 9. What a run needs, checked as the hidden user, the way a run will use it.
step="Checking Xcode, the Simulator, Node and CocoaPods"
dev=$(xcode-select -p 2>/dev/null || true)
case "$dev" in "" | *CommandLineTools) dev=/Applications/Xcode.app/Contents/Developer ;; esac
as_runs() { sudo -u "$RUN_USER" -H /usr/bin/env PATH="$RUN_PATH" DEVELOPER_DIR="$dev" "$@" >/dev/null 2>&1; }
checks=
check() { # check KEY COMMAND...
  key=$1
  shift
  if as_runs "$@"; then ok=true; else ok=false; fi
  checks="$checks${checks:+, }{\"key\": \"$key\", \"ok\": $ok}"
}
if [ -d "$dev" ]; then # without Xcode, xcodebuild and xcrun are shims that pop up an installer
  check xcode /bin/sh -c 'xcodebuild -version && xcodebuild -checkFirstLaunchStatus'
  check ios /bin/sh -c 'xcrun simctl list runtimes | grep -v unavailable | grep -q "^iOS "'
else
  checks='{"key": "xcode", "ok": false}, {"key": "ios", "ok": false}'
fi
check node node -v
check pods pod --version

trap - ERR
printf '{"ok": true, "checks": [%s], "error": null}\n' "$checks" >&3
