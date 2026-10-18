#!/bin/bash
# Set up Share this device:  setup.sh <owner> <port>...
# bridge/device_setup.py runs this as root, behind one macOS admin-password prompt.
#
# It creates the hidden user mysticalruns, whom teammates' device runs execute as,
# and denies that user the owner's home folder. It walls that user off the
# bridge's own ports (the dashboard, the Mini App and the landing page, passed as
# <port>...): one pf rule in the com.apple/mysticalruns anchor, which Apple's
# stock /etc/pf.conf evaluates (that file is never edited), pf turned on with a
# reference of its own, and a boot job that does both again. It proves the wall
# as the hidden user and fails closed if a connect gets through. It installs the
# root helper (mystical_run_helper.py) with a sudoers rule that lets the owner,
# and only the owner, start it without a password. Then it installs Claude Code
# and copies it where only root can change it: runs use that copy, so no run can
# leave a changed Claude behind for the next requester. Last, it checks the tools
# a run needs.
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
PF_ANCHOR=com.apple/mysticalruns
PF_LABEL=cloud.ainurhq.mystical-runs.pf
PF_RULES=/usr/local/etc/mystical-runs.pf
PF_TOKEN=/usr/local/etc/mystical-runs.pf.token
PF_DAEMON=/Library/LaunchDaemons/cloud.ainurhq.mystical-runs.pf.plist
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

# Add RUN_USER to each deny file once, so cron and at never run anything for it.
# A deny file that isn't there stays so: with neither it nor the allow file only
# root may use at (and, by site, cron), and making one would let everyone else
# in. A last line without its newline gets one first: glued on, the name would
# un-deny that line's user. Best effort: since macOS 26 the cron folder is off
# limits to all but Apple's own cron tools (root gets EPERM here, with nothing
# logged), so a file that can't be written is noted and left, and the helper's
# clearing of the hidden user's crontab before and after every run stands in.
deny_cron() { # deny_cron FILE...
  local f
  for f in "$@"; do
    if [ -L "$f" ]; then fail "$f is a link."; fi
    [ -f "$f" ] || continue
    grep -qxF "$RUN_USER" "$f" && continue
    { [ -z "$(tail -c 1 "$f")" ] || printf '\n' >>"$f"; printf '%s\n' "$RUN_USER" >>"$f"; } ||
      echo "$f can't be written on this macOS, so the hidden user's crontab is cleared around each run instead."
  done
}

# Fail unless there is at least one port, and each is a whole number from 1 to 65535.
check_ports() { # check_ports PORT...
  local p
  [ "$#" -gt 0 ] || fail "Set up needs this bridge's ports, to wall the hidden user off them."
  for p in "$@"; do
    case "$p" in "" | *[!0-9]* | 0*) fail "$p isn't a port." ;; esac
    { [ "${#p}" -le 5 ] && [ "$p" -le 65535 ]; } || fail "$p isn't a port."
  done
}

# The wall's one pf rule: the hidden user's TCP to these ports goes nowhere,
# whichever address it aims at (127.0.0.1, ::1 or this device's own).
pf_rules() { # pf_rules PORT...
  local list
  list=$(printf '%s, ' "$@")
  printf 'block drop out quick proto tcp from any to any port { %s } user %s\n' "${list%, }" "$RUN_USER"
}

# The boot job. pf starts each boot off and empty: this loads the rule into the
# anchor again, turns pf on, and keeps the new reference for Remove to let go of.
daemon_plist() {
  printf '%s\n' \
    '<?xml version="1.0" encoding="UTF-8"?>' \
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">' \
    '<plist version="1.0"><dict>' \
    "  <key>Label</key><string>$PF_LABEL</string>" \
    '  <key>ProgramArguments</key><array><string>/bin/sh</string><string>-c</string>' \
    "    <string>umask 077; /sbin/pfctl -a $PF_ANCHOR -f $PF_RULES &amp;&amp; /sbin/pfctl -E 2&gt;&amp;1 | /usr/bin/sed -n 's/^Token : //p' &gt;$PF_TOKEN</string>" \
    '  </array>' \
    '  <key>RunAtLoad</key><true/>' \
    '</dict></plist>'
}

# Whether the wall holds: as the hidden user, no connect to any of these ports gets
# through (nc -z exits 0 only when it connected). Prints the first that does.
wall_holds() { # wall_holds PORT...
  local port
  for port in "$@"; do
    if sudo -u "$RUN_USER" /usr/bin/nc -z -G 2 127.0.0.1 "$port" >/dev/null 2>&1; then
      printf '%s\n' "$port"
      return 1
    fi
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

# Set up stops with the wall down and no record that this device is set up, so
# nothing takes it for ready: it fails closed.
wall_down() { # wall_down MESSAGE
  unwall
  rm -f "$CONFIG"
  fail "$1"
}

# The wall, put up and proved. Every step that can fail is checked here: bash runs
# no ERR trap inside a function (no -E, see the top).
wall() { # wall PORT...
  local token="" line="" leak
  { pf_rules "$@" >"$PF_RULES.new" && chmod 0644 "$PF_RULES.new" && mv -f "$PF_RULES.new" "$PF_RULES"; } ||
    wall_down "The wall's rule couldn't be written."
  pfctl -a "$PF_ANCHOR" -f "$PF_RULES" >/dev/null 2>&1 || wall_down "The packet filter wouldn't load the wall's rule."
  if [ -f "$PF_TOKEN" ]; then # an earlier Set up's reference goes first, so this device holds one
    read -r line <"$PF_TOKEN" || true
    [ -z "$line" ] || pfctl -X "$line" >/dev/null 2>&1 || true
  fi
  while IFS= read -r line; do
    case "$line" in "Token : "*) token=${line#Token : } ;; esac
  done < <(pfctl -E 2>&1)
  [ -n "$token" ] || wall_down "The packet filter didn't turn on, so the hidden user couldn't be walled off."
  { (umask 077 && printf '%s\n' "$token" >"$PF_TOKEN.new") && mv -f "$PF_TOKEN.new" "$PF_TOKEN"; } ||
    wall_down "The packet filter's reference couldn't be kept."
  { daemon_plist >"$PF_DAEMON.new" && chmod 0644 "$PF_DAEMON.new" && mv -f "$PF_DAEMON.new" "$PF_DAEMON"; } ||
    wall_down "The job that puts the wall back at boot couldn't be installed."
  leak=$(wall_holds "$@") ||
    wall_down "The hidden user could still reach this bridge on port $leak, so Set up took its wall down again. Something in this device's packet filter lets it through: a customised /etc/pf.conf, or a skip on lo0."
}

# 1. Root, an owner that exists, and this bridge's ports.
step="Checking your account"
owner=${1:-}
[ "$(id -u)" = 0 ] || fail "Set up has to run as root."
case "$owner" in ""|[!A-Za-z_]*|*[!A-Za-z0-9._-]*) fail "That isn't a macOS account name." ;; esac
uid=$(id -u "$owner" 2>/dev/null) || fail "There is no account called $owner."
home=/Users/$owner
if [ ! -d "$home" ] || [ -L "$home" ]; then fail "$home isn't a home folder."; fi
check_ports "${@:2}"
ports=("${@:2}")

# 2. Before anything is written: the helper, its config and the Claude copy go only
#    where root alone can change every folder above them. Otherwise the owner's
#    passwordless sudo would run whatever replaced them.
step="Checking where the helper goes"
root_only /usr/local
root_only /Library/LaunchDaemons # the wall's boot job
for d in /usr/local/libexec /usr/local/etc "$CLAUDE_DIR" /usr/local/var /usr/local/var/run; do # .../run: the helper's lock
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
#    And out of cron and at, so nothing a run schedules starts after it (best
#    effort, see deny_cron). The files go by their real path, not the manuals'
#    /usr/lib/cron link.
step="Keeping the hidden user out of cron and at"
deny_cron /private/var/at/cron.deny /private/var/at/at.deny

# 5. The wall, before anything runs as the hidden user, and once it exists: pf
#    resolves the user's name when it loads the rule.
step="Walling the hidden user off this bridge"
wall "${ports[@]}"

# 6. The runs folders and the helper.
step="Installing the helper"
if [ -L "$STAGE_ROOT" ]; then fail "$STAGE_ROOT is a link."; fi
install -d -o "$owner" -g staff -m 0755 "$STAGE_ROOT"
sudo -u "$RUN_USER" /usr/bin/install -d -m 0700 "$RUN_HOME/runs"
install -o root -g wheel -m 0755 "$here/mystical_run_helper.py" "$HELPER"

# 7. The sudoers rule: the owner may start the helper as root, and nothing else.
step="Letting your account start the helper"
rule=$(mktemp)
printf '%s ALL=(root) NOPASSWD: %s\n' "$owner" "$HELPER" >"$rule"
visudo -cf "$rule"
install -o root -g wheel -m 0440 "$rule" "$SUDOERS"
rm -f "$rule"

# 8. Claude Code, installed for the hidden user, then copied where only root can
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

# 9. The config names Claude only now that the copy is there: that key is how the
#    owner's bridge sees Claude installed without looking inside the hidden home.
#    `walled` is the ports the wall is on: the bridge and the helper both check it.
step="Recording the setup"
walled=$(printf '%s, ' "${ports[@]}")
printf '{"owner": "%s", "uid": %s, "launch": "sudo", "claude": "%s", "walled": [%s]}\n' \
  "$owner" "$uid" "$CLAUDE" "${walled%, }" >"$CONFIG.new"
chmod 0644 "$CONFIG.new"
mv -f "$CONFIG.new" "$CONFIG"

# 10. What a run needs, checked as the hidden user, the way a run will use it.
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
