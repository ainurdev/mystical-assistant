# Rivendell

## Device runs

A teammate can test an iOS app on a shared device: a Mac whose owner turned on
**Share this device**. Everything is in **Settings › Plugins**, under each
Rivendell connection.

### Share this device

On a Mac, Share this device lets teammates who are allowed device runs in
Rivendell (the `devices` section in Users › Access) test their apps here. A run
executes as `mysticalruns`, a hidden macOS user, with the asker's own code and
Claude account. It never runs as you.

Rivendell is offered the device only while it is READY: Share this device is on,
Xcode and an iOS Simulator runtime are installed, and Set up is done. **STATE**
says where it stands, with a mark for each thing a run needs. Share this device
starts on for each connection, and turning it off takes the device off
Rivendell's list at once. If the device becomes ready by itself, say once Xcode
is installed, it is offered within a few minutes with nothing to press.

### Set up: one password prompt

**SET UP** asks for your Mac password once, in the standard macOS prompt.
Mystical never sees the password. Then, as root, it:

- creates the hidden user `mysticalruns`, with a random password nobody keeps;
- keeps that user out of your home folder, and out of cron and at;
- installs the helper that starts each run as that user, and a sudoers rule that
  lets your account, and only yours, start it;
- installs Claude Code for runs, as a copy only root can change;
- checks Xcode, the Simulator, Node and CocoaPods as the hidden user.

Every step can run again, so pressing SET UP again repairs a setup.

### What a run can't see

The hidden user is another account on this Mac, and it can't read your home
folder, so it can't see your files, keychain or logins. Each run starts in a
fresh home of its own. The code comes from the asker's own checkout, sent by
their Mystical, and the report and screenshots go back to them and onto the task.

### Remove

**REMOVE** is there whenever the device is set up, with Share this device on or
off. It asks for your Mac password again, stops anything the hidden user is
running, then deletes the user, its home and everything runs left behind, the
helper, its config, the sudoers rule and the Claude copy. STATE then says NEEDS
SETUP, or OFF if Share this device is off.

### Your Claude token for device runs

The runs you send use your own Claude account, so the usage is yours. Make a
token with `claude setup-token` and save it under **CLAUDE TOKEN FOR DEVICE
RUNS**. You can't send a run without it.

It is kept beside the session store (mode 0600) and never shown again in full:
the panel shows its last four characters, and REPLACE swaps it. It goes with each
run you send. Rivendell keeps it encrypted until the run ends and then erases it,
and the device that runs it deletes it from disk before the run starts.

Off macOS the panel shows only this side: how many shared devices are on and free
right now, and the token.
