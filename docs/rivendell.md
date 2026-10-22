# Rivendell

## Device runs

A teammate can test an iOS app on a shared device: a device whose owner turned
on **Share this device**. Everything is in
**Settings › Integrations › Rivendell**, under each Rivendell connection.

### Share this device

Share this device lets teammates who are allowed device runs in Rivendell (the
`devices` section in Users › Access) test their apps here. A run
executes as `mysticalruns`, a hidden macOS user, with the asker's code and this
device's own Claude account. It never runs as you, and the asker's Claude login
never leaves their machine.

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
You see more than the report, though: every step of the run, the commands it
runs and what they print, as it goes and for 7 days after (see Watching a run).

Runs can't reach this bridge either: its dashboard, Mini App and landing ports
are walled off from the hidden user, and before every run the helper checks that
they still are. If the wall is down, say because a VPN or another tool turned the
packet filter off, runs fail with "This device's wall is down" until you press
SET UP again. If one of the bridge's ports changes, STATE says NEEDS SETUP with
✗ WALL, and SET UP walls the new one.

Other services this device runs on localhost stay reachable from runs: databases,
dev servers, Docker. Keep sensitive data off localhost while you share this
device.

### Watching a run

A teammate's run on this device is listed in the sessions panel's **Plugins**
tab, under **DEVICE RUNS**, newest first. Open one to watch it live, with the
steps, commands and screenshots a session of yours shows. It is read only, with
nothing to type in. **STOP RUN** stops it, after asking, and the asker gets it
back as failed.

A run stays out of your way. It runs at low priority, so your apps, builds and
sessions stay quick and the run takes longer while you are busy. Your own
sessions and Rivendell jobs never wait for it. It keeps going through Mystical
restarts and updates, and its view picks up where it was; a reboot or a crash
of this device still ends it.

Mystical keeps a run's steps on this device for 7 days, then deletes them with
their screenshots. They can hold the asker's code and `.env` values: only text
shaped like a Claude token is redacted.

When an update to Mystical brings a newer run helper, **SET UP** shows again on
a device that is READY. It installs the new helper, for the live view and low
priority, and asks for your Mac password once. Until then the device keeps
taking runs, and their view shows only the ask and, at the end, the report. SET
UP never overlaps a run: while one is going it asks you to wait until it ends,
and while SET UP works the device takes no new run.

### Remove

**REMOVE** is there whenever anything of Set up's is on the device, a setup cut
short included, with Share this device on or off. It asks for your Mac password
again, stops anything the hidden user is running, then deletes the user, its home
and everything runs left behind, the helper, its config, the sudoers rule and the
Claude copy. Last, it takes the wall down: the packet-filter rule, its reference
and the boot job. STATE then says NEEDS SETUP, or XCODE MISSING if Xcode or its
iOS Simulator runtime is gone, or OFF if Share this device is off.

### The Claude account for device runs

Teammates' runs on this device go under one of the Claude accounts in this
Mystical, so the usage is that account's. Pick it under **CLAUDE ACCOUNT FOR
DEVICE RUNS**; until you do, it is Mystical's default login. The runs you send
carry no Claude token: the device that takes one runs it on its own account. An
older Mystical still sends its asker's token; this device drops it as the claim
arrives.

Each run gets only the account's current login (its access token), never its
refresh token, so a run can use it for a few hours at most. Claude Code renews
a login for about 8 hours at a time, and a run starts only while the login has
20 minutes or more left:

- A login that has ended, or is in its last 5 minutes, is renewed first:
  Mystical runs Claude Code once on that account (one word from Haiku, no
  tools), and Claude Code renews it as it always does, under its own lock.
  Mystical never renews a login itself, since racing Claude Code can sign the
  account out. If the renewal fails, the run fails saying so, and the account
  needs signing in again in **Settings › AI management › Accounts**.
- With 5 to 20 minutes left, Claude Code won't renew it yet: the run fails,
  telling the asker when to ask again.

The run's code can read the login it runs under, as any program Claude starts
there can, for as long as the run lasts. Share this device with teammates whose
code you would run yourself. The device deletes the token from disk before the
run starts. A token you pasted here before accounts replaced it is deleted from
this machine when Mystical next starts.

Off macOS the panel shows only how many shared devices are on and free right
now.
