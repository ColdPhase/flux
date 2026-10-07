# HTTPS through Caddy

One proxy serves the entire Flux origin: the web app, authentication, OAuth discovery,
`/mcp`, `/api/v1/stream` and, when enabled, `/media/*`. Keep Flux's API port on loopback.
Set `FLUX_PUBLIC_ORIGIN` to the exact HTTPS URL people open, including a nonstandard port.
Do not strip paths, authorization or cookies, or replace Host with the upstream address.

This example was exercised on Linux Docker Engine, `linux/amd64`, with Caddy **2.11.7** on
2026-10-07. Its host network reaches the host's published Flux loopback port; this topology
is not an installation test for Docker Desktop. The [verification record](../agents/evidence/327-https-proxy/README.md)
contains the exact image, configuration, browser and SQL observations.

## Local HTTPS example

Start Flux using the existing [source launcher](README.md) or [release installation](install-release.md).
Edit only these settings in **source `docker/.env`**, or **release `.env`**:

```dotenv
FLUX_PORT=19373
FLUX_PUBLIC_ORIGIN=https://localhost:19443
FLUX_TRUSTED_PROXIES=
```

Apply the settings with `./flux up` for the source checkout. In a release directory use
`docker compose --env-file .env -f compose.yaml up -d --wait`. The release does not ship
the source launcher. Keep the other settings and secrets from that installation.

Save this as `Caddyfile` in a separate proxy directory:

```caddyfile
{
	admin off
	auto_https disable_redirects
	skip_install_trust
}

localhost:19443 {
	bind 127.0.0.1
	tls internal
	reverse_proxy 127.0.0.1:19373
}
```

Validate and start the pinned image. `:z` makes the configuration readable on a Docker host
with SELinux; the two named volumes preserve Caddy's certificates and configuration.
Choose names unused by another installation.

```sh
docker run --rm --network none \
  -v "$PWD/Caddyfile:/etc/caddy/Caddyfile:ro,z" \
  caddy@sha256:d8542f48d34a9cf4e4c11a478865229840e87e4c96ea3f439101f31a5d35f75f \
  caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
docker run -d --name flux-proxy --restart unless-stopped --network host \
  -v "$PWD/Caddyfile:/etc/caddy/Caddyfile:ro,z" \
  -v flux-proxy-data:/data -v flux-proxy-config:/config \
  caddy@sha256:d8542f48d34a9cf4e4c11a478865229840e87e4c96ea3f439101f31a5d35f75f
docker cp flux-proxy:/data/caddy/pki/authorities/local/root.crt ./flux-local-root.crt
curl --cacert ./flux-local-root.crt -fsS https://localhost:19443/api/v1/health
```

Only the public CA certificate is exported. Trust it in the browser used for this local
installation, then open `https://localhost:19443` and create an account. This local CA does
not obtain a public ACME certificate. Browser automation in the verification record explicitly
ignored local certificate errors; its separate curl checks verified the CA and hostname.
Installation of browser or device trust was not tested.

## Trust only the measured proxy peer

Initially leave `FLUX_TRUSTED_PROXIES` empty. Create an identifiable account through Caddy,
for example `proxy-probe@example.org`, and inspect **only** its session address. For the
default database name and user, the release command is:

```sh
docker compose --env-file .env -f compose.yaml exec -T db \
  psql -U flux -d flux -c "SELECT s.ip_address FROM auth_sessions s
    JOIN auth_users u ON u.id = s.user_id
    WHERE u.email = 'proxy-probe@example.org'
    ORDER BY s.created_at DESC LIMIT 1;"
```

For source use `docker compose --env-file docker/.env -p YOUR_PROJECT -f docker/compose.source.yaml`
instead, replacing `YOUR_PROJECT` with the existing `FLUX_PROJECT` from `docker/.env`.
Use your configured database user/name if changed. Do not select tokens or password hashes.
With trust empty, this address is the API's socket peer, including Docker's NAT if present.

Set `FLUX_TRUSTED_PROXIES` to **that address** with `/32` for IPv4 or `/128` for IPv6, and
apply the settings again. In our isolated project the observed peer was `172.27.0.1`, so
the tested setting was `172.27.0.1/32`. This is an observation, not a reusable default.
The address can change when a Compose network is recreated; measure it again. A bridge
gateway identifies a network hop, not uniquely the Caddy process. Do not trust every
private network or `0.0.0.0/0`; keep the API loopback publication in place.

Sign out and sign in through Caddy, then repeat the query. In this loopback example the
new session must contain the browser's client address `127.0.0.1`. The actual check also
sent a forged `X-Forwarded-For: 203.0.113.199` through Caddy: the saved session remained
`127.0.0.1`. Caddy's direct-edge default discards client-supplied forwarding values. Flux
resolves the client address through its configured peers and strips arbitrary forwarding
headers before authentication. No Caddy `trusted_proxies` option is needed for this direct
edge; putting another proxy ahead of Caddy requires a separate, narrow trust configuration.

## Public hostname and streaming

For a public hostname, keep the same whole-origin proxy and matching upstream port. Change
`FLUX_PUBLIC_ORIGIN` to `https://flux.example.org`, apply Flux's settings, and replace the
local Caddyfile with:

```caddyfile
flux.example.org {
	reverse_proxy 127.0.0.1:19373
}
```

Use your hostname and actual `FLUX_PORT`. Its A/AAAA records must reach this host; inbound
80 and 443 must reach Caddy. Preserve writable `/data` and `/config` volumes, and restart
the proxy to load its new configuration. Caddy's automatic HTTPS obtains and renews the
public certificate. The actual acceptance run used the local CA configuration above;
public DNS, ACME issuance and an Internet-facing installation remain unverified here.

The same `reverse_proxy` supports the WebSocket upgrade at `/api/v1/stream`; no separate
WebSocket location or path rewrite is required. The acceptance run received a real 101
upgrade and the stored message's event in another browser. That browser displayed the
message without reloading its document. The current conversation thread refreshes through
its existing 15-second polling path; this check does not certify immediate UI updates.

When the optional [live-media overlay](../development/live-media.md) is enabled, the
whole-origin proxy also covers `/media/rtc`, `/media/rtc/v1` and the other `/media/*`
signaling paths. Actual media RTP/ICE/TURN reachability follows that guide separately;
an HTTPS proxy does not establish working audio/video transport. Media was not exercised
in this HTTPS check. The optional source overlay is not shipped in the release operator file.

Check discovery and the unauthenticated MCP challenge at your exact public origin:

```sh
curl -i https://flux.example.org/.well-known/oauth-protected-resource/mcp
curl -i -X POST https://flux.example.org/mcp
```

Expect metadata 200 with `resource=https://flux.example.org/mcp`, then 401 whose
`WWW-Authenticate` points to `https://flux.example.org/.well-known/oauth-protected-resource/mcp`.
For the local example use `https://localhost:19443` and `--cacert ./flux-local-root.crt`.

Primary references, checked 2026-10-07: [Caddy 2.11.7](https://github.com/caddyserver/caddy/releases/tag/v2.11.7),
[reverse proxy](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy),
[automatic HTTPS](https://caddyserver.com/docs/automatic-https) and
[Docker host networking](https://docs.docker.com/engine/network/drivers/host/).
