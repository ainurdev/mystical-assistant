**Dropdown** — the HUD's labeled select chip: a tiny UPPERCASE label beside a bordered chip button that opens a `✓ label` menu. The model/effort/mode pickers in the composer. Controlled — pass `value` + `onChange`. Use `direction="up"` in a bottom composer.

```jsx
<Dropdown
  label="MODEL"
  value={model}
  onChange={setModel}
  direction="up"
  options={[
    { id: "opus", label: "Opus" },
    { id: "sonnet", label: "Sonnet" },
    { id: "haiku", label: "Haiku" },
  ]}
/>
```

Props: `label`, `value`, `options` ({ id, label }[]), `onChange`, `minWidth`, `direction`. For a tap-target select on mobile, a native styled `<select>` is the Mini-App equivalent.
