# Preview via a stable named tunnel — Design

**Date:** 2026-06-22
**Status:** Implemented
**Component:** `bridge/tunnel.py`, `bridge/config.py`
**Supersedes:** the "quick tunnels only / no named-tunnel" non-goal in
`2026-06-22-telegram-miniapp-design.md` — **for the `/preview` feature only.**

## 1. Goal

Replace the `/preview` ephemeral throwaway-hostname quick tunnel with a **stable
named tunnel** so the preview URL is always `https://preview.mhzrerfani.dev`.
The Mini App **control-panel** tunnel is unchanged — it still uses an ephemeral quick
tunnel (`tunnel.open_quick_tunnel`).

## 2. Decisions

| Decision | Choice |
|---|---|
| Hostname | `preview.mhzrerfani.dev` (zone `mhzrerfani.dev`) |
| Access (login) | **None** — the URL is open while the tunnel is running |
| Port | **Dynamic** — `/preview [port]` still picks the port per run |
| Tunnel mgmt | **Locally-managed** (credentials file + generated `config.yml`) |
| Provisioning | One-time, via the provider API (MCP): tunnel + DNS |

Rationale: dynamic port + no runtime API dependency ⇒ locally-managed. The bridge
owns a `config.yml` it rewrites per port and runs `tunnel run`; no
provider API call happens at runtime (the MCP is a build-time tool only).

## 3. Provisioned resources

- **Tunnel** `mystical-preview`, id `612b1ee2-693c-4640-a3ed-133adce0da6b`
  (`config_src: local`).
- **DNS** proxied `CNAME preview → 612b1ee2….cfargotunnel.com` in zone
  `mhzrerfani.dev` (`7ab6fa20…cb31`).
- **Credentials file** `~/.the tunnel client/mystical-preview.json` (mode 600, in `$HOME`,
  outside the repo) — `{AccountTag, TunnelID, TunnelSecret}`. Scoped to this one
  tunnel; not an account-wide token.

## 4. Runtime (`bridge/tunnel.py`)

Public interface is unchanged (`start_tunnel(port) → (url, msg)`, `stop_tunnel()`,
`tunnel_state()`, `handle_preview()`), so `dispatch.py`, the Mini App `/api/preview`
endpoint, and the React Preview tab need no changes.

- `_write_config(port)` writes `TUNNEL_CONFIG_FILE` with ingress
  `preview.mhzrerfani.dev → http://localhost:<port>` + a `404` fallback.
- `_spawn_named(port)` runs `tunnel --config <cfg> run`; a watch thread
  sets a ready event on the first `Registered tunnel connection` line and then keeps
  draining stdout. After ready it waits `_EDGE_SETTLE` (5 s) so the edge route
  propagates — a cold route otherwise returns `1033` on the first request.
- `start_tunnel` checks the credentials file exists (else a clear "not provisioned"
  message), and on a port change stops + rewrites + respawns.

## 5. Config (`bridge/config.py`)

`PREVIEW_HOSTNAME`, `TUNNEL_NAME`, `TUNNEL_ID`, `TUNNEL_CREDENTIALS_FILE`,
`TUNNEL_CONFIG_FILE` — all env-overridable, defaulting to the provisioned values.

## 6. Security

While running, `preview.mhzrerfani.dev` is publicly reachable (no Access, by choice);
it only runs on demand. When stopped, the hostname returns the provider's tunnel-offline
error. The stored credential controls only this tunnel and is git-ignored in `$HOME`.

## 7. Verification

Integration test (`/tmp/mp_integration.py`, throwaway): start on :3000 → stable URL +
correct config + 200 from the origin through the tunnel; "already live" idempotency;
dynamic change to :3001 served correctly; clean stop clears state. Local DNS is bypassed
with `curl --resolve` because this WSL box still has the pre-provision `NXDOMAIN`
negatively cached (clears within the zone SOA min TTL, 30 min).
