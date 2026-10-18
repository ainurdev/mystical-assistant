# Rivendell

## Device runs

A teammate can test an iOS app on a shared device: a device whose owner turned
on **Share this device**. Everything is in
**Settings › Integrations › Rivendell**, under each Rivendell connection.

### Share this device

Share this device lets teammates who are allowed device runs in Rivendell (the
`devices` section in Users › Access) test their apps here. A run
executes as `mysticalruns`, a hidden macOS user, with the asker's own code and
Claude account. It never runs as you.

Rivendell is offered the device only while it is READY: Share this device is on,
Xcode and an iOS Simulator runtime are installed, and Set up is done, its wall on
this bridge's ports as they are now. **STATE** says where it stands, with a mark
for each thing a run needs. Share this device
starts on for each connection, and turning it off takes the device off
Rivendell's list at once. If the device becomes ready by itself, say once Xcode
is installed, it is offered within a few minutes with nothing to press.

### Set up: one password prompt

**SET UP** asks for your Mac password once, in the standard macOS prompt.
Mystical never sees the password. Then, as root, it:

- creates the hidden user `mysticalruns`, with a random password nobody keeps;
- keeps that user out of your home folder, and clears its crontab before and after every run (macOS no longer lets Set up write the cron deny list);
- walls that user off this bridge's own ports (the dashboard, the Mini App and
  the landing page) with one packet-filter rule, turns the packet filter on, and
  installs a job that does both again at each boot. Then it checks, as that user,
  that none of those ports answers. If one does, Set up takes the wall down again
  and stops, saying why;
- installs the helper that starts each run as that user, and a sudoers rule that
  lets your account, and only yours, start it;
- installs Claude Code for runs, as a copy only root can change;
- checks Xcode, the Simulator, Node and CocoaPods as the hidden user.

Every step can run again, so pressing SET UP again repairs a setup.

### What a run can't see

The hidden user is another account on this device, and it can't read your home
folder, so it can't see your files, keychain or logins. Each run starts in a
fresh home of its own. The code comes from the asker's own checkout, sent by
their Mystical, and the report and screenshots go back to them and onto the task.

Runs can't reach this bridge either: its dashboard, Mini App and landing ports
are walled off from the hidden user, and before every run the helper checks that
they still are. If the wall is down, say because a VPN or another tool turned the
packet filter off, runs fail with "This device's wall is down" until you press
SET UP again. If one of the bridge's ports changes, STATE says NEEDS SETUP with
✗ WALL, and SET UP walls the new one.

Other services this device runs on localhost stay reachable from runs: databases,
dev servers, Docker. Keep sensitive data off localhost while you share this
device.

### Remove

**REMOVE** is there whenever anything of Set up's is on the device, a setup cut
short included, with Share this device on or off. It asks for your Mac password
again, stops anything the hidden user is running, then deletes the user, its home
and everything runs left behind, the helper, its config, the sudoers rule and the
Claude copy. Last, it takes the wall down: the packet-filter rule, its reference
and the boot job. STATE then says NEEDS SETUP, or XCODE MISSING if Xcode or its
iOS Simulator runtime is gone, or OFF if Share this device is off.

### The Claude account for device runs

The runs you send go out under one of the Claude accounts in this Mystical, so
the usage is that account's. Pick it under **CLAUDE ACCOUNT FOR DEVICE RUNS**;
until you do, it is Mystical's default login. There is no token to paste.

Each run carries only the account's current login (its access token), never its
refresh token, so a device can use it for a few hours at most. Claude Code
renews a login for about 8 hours at a time, and a run goes only while the login
has 20 minutes or more left:

- A login that has ended, or is in its last 5 minutes, is renewed first:
  Mystical runs Claude Code once on that account (one word from Haiku, no
  tools), and Claude Code renews it as it always does, under its own lock.
  Mystical never renews a login itself, since racing Claude Code can sign the
  account out. If the renewal fails, sign in to the account again in
  **Settings › AI management › Accounts**.
- With 5 to 20 minutes left, Claude Code won't renew it yet: nothing is sent,
  and you are told when to ask again, or you can pick another account.

Rivendell keeps the token encrypted until a device claims the run, then erases
it, and that device deletes it from disk before the run starts. A token you
pasted here before accounts replaced it is deleted from this machine when
Mystical next starts.

Off macOS the panel shows only this side: how many shared devices are on and free
right now, and the account.
