**Chip** — the HUD's universal bordered metadata pill: UPPERCASE, letter-spaced micro-text inside a toned hairline. Use for model names, git branch, session status, surface codes, counts. Add `dot` for a leading status dot, `solid` for a faint tone wash.

```jsx
<Chip>OPUS</Chip>
<Chip tone="violet" icon="⎇">main</Chip>
<Chip tone="success" dot>ONLINE</Chip>
<Chip tone="warning" solid>3 CHANGES</Chip>
```

Props: `tone` (accent · violet · blue · success · warning · danger · muted), `dot`, `solid`, `icon`. For surface origin codes (VS/TG/MA/WEB) prefer the dedicated `SurfaceBadge`.
