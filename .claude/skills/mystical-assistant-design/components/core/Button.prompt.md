**Button** — the Mystical Assistant action control: square (radius 0), monospace, with filled/outline/ghost web variants plus the signature bordered `hud` command action. Use `hud` for terminal/HUD actions (SEND ▸ / STOP ■), `primary` for the mobile/primary CTA, `outline`/`ghost` for secondary chrome.

```jsx
<Button variant="hud">SEND ▸</Button>
<Button variant="destructive">STOP ■</Button>
<Button variant="primary">New session</Button>
<Button variant="outline" size="sm">CHAT</Button>
<Button variant="ghost" size="icon" aria-label="Attach">📎</Button>
```

Props: `variant` (primary · secondary · outline · ghost · destructive · hud), `size` (sm · default · lg · icon), `uppercase`. Forwards all native `<button>` props (`onClick`, `disabled`, …). Press dims to 70%, disabled to 40%. For UPPERCASE actions prefer `variant="hud"` which also adds the tracked letter-spacing.
