**StatusDot** — a tiny round state indicator (the only intentionally-round element in the HUD). Green for running/online, amber for idle/awaiting/dirty, red for error/exited, grey for idle. Add `pulse` for the live "ping" ring.

```jsx
<StatusDot status="running" pulse />
<StatusDot status="dirty" />
<StatusDot status="error" size={6} />
```

Props: `status`, `size`, `pulse`. Pair with a `Chip` for a labeled status, or a session row.
