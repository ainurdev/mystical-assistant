# Watches run unattended with full tools, in a throwaway copy

A watch (the Watcher's nightly pass) runs at 03:00 with nobody around and reads every project's transcripts, which hold text from anywhere: captures of other people's messages, tracker tickets, fetched web pages. It still gets every tool and no permission stops, working in a throwaway copy of any repo it wants to try things in; the copy is deleted afterwards and a watch never pushes. Why: a watch that can run scripts, drive a preview and try a fix files findings it has proved rather than guessed, and a watch that stops for a permission at 03:00 waits until morning.

## Considered Options

- **Read-only** (recommended, not picked): the bridge runs the counting scripts, reads PostHog and takes the screenshots before the agent starts; the agent gets read tools plus one tool to file findings, so planted text could at most produce a bad finding. Refining a work-list task and the next-up scouts treat untrusted text this way.
- **The normal checkout with permission prompts**: your branches are safe, but a night's watch sits waiting for you.

## Consequences

- Accepted risk: text planted in an old transcript can steer a watch into running commands on this machine, as in any session without permission stops. The throwaway copy protects your branches, not the machine.
- The user picked this over the read-only recommendation on 2026-11-11. Don't move watches back to read-only without asking.
