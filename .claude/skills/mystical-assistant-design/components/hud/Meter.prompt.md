**Meter** — the thin (4–5px) HUD utilization bar: a faint accent track with a colored fill. The recurring readout for CPU, MEM, CONTEXT, USED, FOCUS. Use `fill="gradient"` (teal→violet) for context/focus, plain `accent` for host vitals. Lay a label + value either side of it.

```jsx
<div style={{ display: "flex", alignItems: "center", gap: 9 }}>
  <span style={{ fontSize: 9.5, color: "var(--muted-foreground)", width: 30 }}>CPU</span>
  <Meter value={62} style={{ flex: 1 }} />
  <span style={{ fontSize: 10, color: "var(--foreground)", width: 34, textAlign: "right" }}>62%</span>
</div>

<Meter value={48} fill="gradient" height={4} animate />
```

Props: `value`, `fill` (accent · gradient · success · warning · danger · any CSS), `height`, `animate`, `track`.
