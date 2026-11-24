# Reports go to Sentry from team installs only, through the official SDKs

Crashes and slow spots on other installs had no way to reach us: usage sharing (PostHog) is opt-in and leaves exceptions out on purpose, and the unmerged CRASHES view could only file a task on the sender's own Rivendell board. Now a **team install** (one with an enabled connection to our Rivendell) sends **reports** to one Sentry project, through `@sentry/react` in the dashboard and `sentry-sdk` in the bridge. Every other install sends nothing and is never asked. The Python SDK is vendored with urllib3 and certifi and imported only on team installs, so the backend still has no install step.

## Considered Options

- **Opt-in for every install, beside USAGE SHARING** (not picked): it fits the public repo's "off until you say yes" promise, but the reports we want are our own, and a stranger's paths and prompt lines should not reach our Sentry at all.
- **The bridge sends by itself over the standard library, built on the CRASHES view** (not picked): one scrubber and no dependency, but we would write and keep up Sentry's event format ourselves, without the SDKs' grouping, breadcrumbs and tracing.
- **sentry-sdk as an optional pip install, or required for everyone** (not picked): an install step on machines that have none today.

## Consequences

- The backend is no longer standard-library only: `bridge/_vendor` holds third-party code that is refreshed by hand.
- A report carries the teammate's Rivendell name, the project, full file paths and the first line of the prompt. It never carries chat text, file contents, tokens or Python local variables. Session replay and profiling stay off.
- Slow spots are sent only past a limit (input 100 ms, a frame 150 ms, a bridge call 500 ms, a turn's start 2 s), plus every start-up time. Nothing else is traced.
- The DSN sits in the public repo: it can send, never read. `MYSTICAL_SENTRY=0` switches a team install off.
- The Mini App page and the three app shells are not covered.
- `feat/crash-reports` (tip 40f9df72) was deleted unmerged.
