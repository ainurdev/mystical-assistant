**Stat** — a micro readout cell: a tiny UPPERCASE tracked label over a value. The atom of every HUD stat grid. Lay several in a CSS grid for the TURNS/TOOLS/COST/ERRORS row; color the value with a semantic var for signals.

```jsx
<div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 8 }}>
  <Stat label="TURNS" value="14" />
  <Stat label="TOOLS" value="07" />
  <Stat label="COST" value="$0.42" />
  <Stat label="ERRORS" value="00" color="var(--success)" />
</div>
```

Props: `label`, `value`, `color`, `align`, `size`. For a big single readout (clock, temperature) just style the value directly.
