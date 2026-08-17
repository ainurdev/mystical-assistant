**Spinner** — a `currentColor` loading ring for inline "loading…" / action-pending states. Inherits the surrounding text color so it works on any phosphor mood. Set its color by setting the parent's `color`.

```jsx
<span style={{ color: "var(--primary)" }}><Spinner /></span>
<Spinner size={12} />
```

Props: `size`. For a full-panel load, the terminal uses a "TUNING SIGNAL…" scanline instead of a spinner.
