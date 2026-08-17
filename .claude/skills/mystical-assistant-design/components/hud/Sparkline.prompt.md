**Sparkline** — a real-derived mini line chart (AGENT ACTIVITY / TOOL THROUGHPUT): a thin phosphor polyline over a faint center axis. Pass a rolling `number[]` buffer; it self-normalizes and stretches to fill its container. Pair with an `AVG nn%` label above it.

```jsx
<div style={{ display: "flex", justifyContent: "space-between", fontSize: 10 }}>
  <span style={{ color: "var(--muted-foreground)", letterSpacing: 1.5 }}>AGENT ACTIVITY</span>
  <span style={{ color: "var(--muted-2)" }}>AVG <span style={{ color: "var(--primary)" }}>62%</span></span>
</div>
<Sparkline data={buf} />
<Sparkline data={buf2} color="var(--violet)" />
```

Props: `data`, `color`, `width`, `height`, `pad`, `axis`, `strokeWidth`. Drive it from real signals (running state, tool deltas) — never ship `Math.random` as a metric.
