**Field** — a bordered terminal input on `--card`, JetBrains Mono, with a focus-brightened teal edge. Add a `prompt` glyph for the command-line composer look, a `label` for a titled field, or `multiline` for the message textarea. Forwards all native input props.

```jsx
<Field prompt="~ ❯" placeholder="message claude — describe a change…" multiline />
<Field label="CITY" placeholder="city…" defaultValue="London" />
<Field placeholder="new branch name…" />
```

Props: `label`, `prompt`, `multiline`, `rows`, `inputStyle`, plus native `value`/`onChange`/`placeholder`/… For the full composer, pair with `Dropdown` chips (model/effort/mode) and a `Button variant="hud"`.
