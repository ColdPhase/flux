# HTTPS and reverse proxies

One proxy serves the entire Flux origin: the web app, authentication, OAuth discovery,
`/mcp`, `/api/v1/stream` and, when enabled, `/media/*`. Keep Flux's API port on loopback.
Set `FLUX_PUBLIC_ORIGIN` to the exact HTTPS URL people open, including a nonstandard port.
Do not strip paths, authorization or cookies, or replace Host with the upstream address.

The proxy is built in: [an `https` origin is all](#built-in-https). A proxy of
your own is the same single setting with its address added ([your own proxy](#your-own-proxy-instead)).
For your own proxy, the Caddy example below is the most complete; [nginx](#nginx) and [Traefik](#traefik) follow, and any proxy that passes WebSocket upgrades
and request bodies of at least 5 MiB works the same way.

## Built-in HTTPS

Founder decision 3 of [#1471](https://github.com/ColdPhase/flux/issues/1471) (2026-11-13). Point the
DNS name at the server, then set the origin in `docker/.env` and apply it:

```dotenv
FLUX_PUBLIC_ORIGIN=https://flux.example.org
FLUX_TRUSTED_PROXIES=
```

```sh
./flux up
```

With an `https` origin and `FLUX_TRUSTED_PROXIES` empty, `./flux` adds
[`docker/compose.https.yaml`](../../docker/compose.https.yaml) to every command: Caddy 2.11.9, pinned by
digest, as the `proxy` service. It listens on port 80 and on the origin's port (443 unless the origin
names another; TCP, and UDP for HTTP/3), obtains and renews the certificate for the origin's host
itself (ACME, Let's Encrypt or ZeroSSL), redirects plain `http` to `https`, and passes everything to
the API over a network that only the two of them join. The API's own port stays on `127.0.0.1`.
The owner's only steps are the DNS A record and opening 80/tcp and 443/tcp to the server; ACME needs
both to reach it. **No AAAA record** unless Docker's IPv6 networking is enabled on the server: on Docker's
default IPv4-only networks an IPv6 visitor reaches Caddy through Docker's userland proxy, from the
network's gateway address, so Flux would see every IPv6 visitor as one client (one shared sign-in limit,
the gateway in session lists).

The API trusts exactly Caddy's address. Each time it starts, it looks up the `proxy` service and runs
with `FLUX_TRUSTED_PROXIES=<Caddy's address>/32`; `./flux up` prints the value. `docker/.env` keeps
`FLUX_TRUSTED_PROXIES` empty: that empty line is what says "the bundled proxy". Caddy replaces any
`X-Forwarded-For` a client sends with the address it sees, so sign-in limits and session lists see real
client addresses, and no other process can speak from Caddy's address.

- **Certificates persist** in the `proxy-data` volume (certificates, the ACME account key and Caddy's own
  CA); `proxy-config` holds Caddy's saved configuration. `./flux down`, `up` and `upgrade` keep them;
  `./flux clean` and `reset` remove them. `./flux backup` does not include them: on a new server Caddy
  gets new certificates by itself once the DNS points there.
- **Upgrades** keep the same volumes; a new Caddy digest arrives with the Flux version that pins it, and
  Compose restarts the API with Caddy so the trusted address follows it.
- **Private network or home lab:** a name Caddy treats as internal (`localhost`, `*.localhost`, `*.local`,
  `*.internal`, `*.home.arpa`, or an IP address) gets a certificate from Caddy's own CA instead of ACME,
  with no other change. Every device then has to trust that CA's root once:
  `docker cp <project>-proxy-1:/data/caddy/pki/authorities/local/root.crt flux-root.crt`, and install it
  as a trusted root on each computer, phone and tablet (phones need it for the installed app and push).
- **Switching back:** an `http` (loopback) origin, or a `FLUX_TRUSTED_PROXIES` value, makes the next
  `./flux up` remove the `proxy` container; its volumes stay until `./flux clean`.

**Tested** on 2026-11-13 with an isolated `./flux up` of this checkout on a Linux Docker Engine 29.4.2 host,
origin `https://127.0.0.1:23443` (an IP address, so Caddy's own CA; no public ACME was attempted from
this host): see [the evidence](#built-in-https-evidence) below.

## Your own proxy instead

Already running nginx, Traefik or another Caddy on 80/443? Give its address in the same file, before or
together with the `https` origin, and `./flux` bundles nothing:

```dotenv
FLUX_PUBLIC_ORIGIN=https://flux.example.org
FLUX_TRUSTED_PROXIES=172.27.0.1/32
```

The address is where your proxy's connections to Flux come from. For a proxy on the same host that
connects to `127.0.0.1:<FLUX_PORT>`, it is the gateway of Flux's Compose network:

```sh
docker network inspect "$(sed -n 's/^FLUX_PROJECT=//p' docker/.env)_default" --format '{{range .IPAM.Config}}{{.Gateway}}{{end}}'
```

Write it with `/32` (`/128` for IPv6), run `./flux up`, then [check it](#trust-only-the-measured-proxy-peer)
with one sign-in. The rest of this page is your proxy's configuration: whole origin, WebSocket upgrades,
`Host` kept, `X-Forwarded-For` replaced.

## Caddy

### Local HTTPS example

This is a proxy of your own; without one, HTTPS is [built in](#built-in-https). Edit only these settings in
`docker/.env` (the gateway address is the one of [your own proxy](#your-own-proxy-instead); measure it below):

```dotenv
FLUX_PORT=19373
FLUX_PUBLIC_ORIGIN=https://localhost:19443
FLUX_TRUSTED_PROXIES=172.27.0.1/32
```

Apply the settings with `./flux up`. Keep the other settings and secrets from that installation.

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
  caddy@sha256:4e2425f6009577e7c651010f16679c28f7d12df3e7b1914f941a7a3370746b3c \
  caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
docker run -d --name flux-proxy --restart unless-stopped --network host \
  -v "$PWD/Caddyfile:/etc/caddy/Caddyfile:ro,z" \
  -v flux-proxy-data:/data -v flux-proxy-config:/config \
  caddy@sha256:4e2425f6009577e7c651010f16679c28f7d12df3e7b1914f941a7a3370746b3c
docker cp flux-proxy:/data/caddy/pki/authorities/local/root.crt ./flux-local-root.crt
curl --cacert ./flux-local-root.crt -fsS https://localhost:19443/api/v1/health
```

Only the public CA certificate is exported. Trust it in the browser used for this local
installation, then open `https://localhost:19443` and create an account. This local CA does
not obtain a public ACME certificate.

### Trust only the measured proxy peer

An empty `FLUX_TRUSTED_PROXIES` with an `https` origin starts the [built-in proxy](#built-in-https), so set the
[gateway address](#your-own-proxy-instead) first and use the query below to confirm it. Create an identifiable account through Caddy,
for example `proxy-probe@example.org`, and inspect **only** its session address. For the
default database name and user, the command is (in the Flux folder):

```sh
docker compose --env-file docker/release.env --env-file docker/.env -p YOUR_PROJECT -f docker/compose.yaml exec -T db \
  psql -U flux -d flux -c "SELECT s.ip_address FROM auth_sessions s
    JOIN auth_users u ON u.id = s.user_id
    WHERE u.email = 'proxy-probe@example.org'
    ORDER BY s.created_at DESC LIMIT 1;"
```

Replace `YOUR_PROJECT` with the `FLUX_PROJECT` from `docker/.env` (a developer's source checkout uses
`--env-file docker/.env -f docker/compose.source.yaml`).
Use your configured database user/name if changed. Do not select tokens or password hashes.
With trust empty, this address is the API's socket peer, including Docker's NAT if present.

Set `FLUX_TRUSTED_PROXIES` to **that address** with `/32` for IPv4 or `/128` for IPv6, and
apply the settings again. In our isolated project the observed peer was `172.27.0.1`, so
the tested setting was `172.27.0.1/32`. This is an observation, not a reusable default.
A quick cross-check is the gateway of the project's network:
`docker network inspect <FLUX_PROJECT>_default --format '{{range .IPAM.Config}}{{.Gateway}}{{end}}'`.
The address can change when a Compose network is recreated; measure it again. A bridge
gateway identifies a network hop, not uniquely the Caddy process. Do not trust every
private network or `0.0.0.0/0`; keep the API loopback publication in place.

Sign out and sign in through Caddy, then repeat the query. In this loopback example the
new session must contain the browser's client address `127.0.0.1`. Caddy's direct-edge default discards client-supplied forwarding values. Flux
resolves the client address through its configured peers and strips arbitrary forwarding
headers before authentication. No Caddy `trusted_proxies` option is needed for this direct
edge; putting another proxy ahead of Caddy requires a separate, narrow trust configuration.

### HSTS

For an `https` `FLUX_PUBLIC_ORIGIN` the API itself sends `Strict-Transport-Security: max-age=31536000`, and the proxy passes it on, so
the proxy needs no `header` or `add_header` line for it. Add `includeSubDomains` or `preload` at the proxy only when every subdomain
of your name serves `https` for good: a browser keeps the rule for the whole period. Do not set a second, different value at the
proxy (nginx's `add_header` adds a second header rather than replacing the first; use `proxy_hide_header Strict-Transport-Security;`
first if you do).

### Public hostname and streaming

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
public certificate.

The same `reverse_proxy` supports the WebSocket upgrade at `/api/v1/stream`; no separate
WebSocket location or path rewrite is required.

When the optional [live-media overlay](../development/live-media.md) is enabled, the
whole-origin proxy also covers `/media/rtc`, `/media/rtc/v1` and the other `/media/*`
signaling paths. Actual media RTP/ICE/TURN reachability follows that guide separately;
an HTTPS proxy does not establish working audio/video transport. `FLUX_CALLS=on` layers the overlay ([calls](calls.md)).

Check discovery and the unauthenticated MCP challenge at your exact public origin:

```sh
curl -i https://flux.example.org/.well-known/oauth-protected-resource/mcp
curl -i -X POST https://flux.example.org/mcp
```

Expect metadata 200 with `resource=https://flux.example.org/mcp`, then 401 whose
`WWW-Authenticate` points to `https://flux.example.org/.well-known/oauth-protected-resource/mcp`.
For the local example use `https://localhost:19443` and `--cacert ./flux-local-root.crt`.

**Tested** on 2026-10-07 with Caddy 2.11.7 on the host network of a Linux Docker Engine host, using
the local example above: health, sign-up, a WebSocket 101 on `/api/v1/stream`, the MCP discovery and
challenge, and a forged `X-Forwarded-For` replaced by the real client address. Public DNS and ACME
were not exercised ([record](https://github.com/ColdPhase/flux/blob/b17ae9e357441e9a383eb275d1034e69ec50c98a/docs/agents/evidence/327-https-proxy/README.md);
references: [reverse proxy](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy),
[automatic HTTPS](https://caddyserver.com/docs/automatic-https)).

## nginx

The same whole-origin rule with nginx. Put this in a file under `/etc/nginx/conf.d/` (the `map`
block must be at `http` level, which `conf.d` files are): pass every path, keep `Host`, forward WebSocket upgrades,
replace the client's `X-Forwarded-For` with the address nginx sees, and let request bodies through
(nginx accepts 1 MiB by default; Flux takes files up to 5 MiB and a video up to [`FLUX_VIDEO_MAX_MIB`](configuration.md#flux_video_max_mib), 200 MiB by default).

```nginx
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}

server {
    listen 443 ssl;
    http2 on;
    server_name flux.example.org;

    ssl_certificate     /etc/letsencrypt/live/flux.example.org/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/flux.example.org/privkey.pem;

    # Files up to 5 MiB, and videos up to FLUX_VIDEO_MAX_MIB (200 MiB by default), are accepted by Flux; nginx's default is 1 MiB.
    # Keep this at least as large as FLUX_VIDEO_MAX_MIB, or a video fails with 413 from nginx.
    client_max_body_size 210m;

    location / {
        proxy_pass http://127.0.0.1:8081;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        # Live streams stay open; Flux pings every 25 s (FLUX_STREAM_HEARTBEAT_MS).
        proxy_read_timeout 1h;
        proxy_send_timeout 1h;
        proxy_buffering off;
    }
}

server {
    listen 80;
    server_name flux.example.org;
    return 301 https://$host$request_uri;
}
```

nginx does not obtain certificates itself; use your ACME client (for example certbot) for the files
named above. Use your `FLUX_PORT` in `proxy_pass`. Then [trust only the measured proxy
peer](#trust-only-the-measured-proxy-peer) as for Caddy, with the database query from that section.

**Tested** on 2026-10-31 with `nginx:1.29-alpine` (nginx 1.29.8, digest
`sha256:5616878291a2eed594aee8db4dade5878cf7edcb475e59193904b198d9b830de`) on the host network of a
Linux Docker Engine 29.4.2 host, in front of a source `./flux up` on a loopback port, with a
self-signed certificate for `localhost` and `FLUX_PUBLIC_ORIGIN=https://localhost:<port>`: the
`server` block above with that port, address and certificate (the port-80 redirect was not part of
the run). Through the proxy: health answered `ok`; sign-up and `GET /api/v1/me` answered 200; a
WebSocket upgrade of `/api/v1/stream` with the session cookie answered 101; the MCP metadata named
`https://localhost:<port>/mcp` and `POST /mcp` answered 401 with the matching `WWW-Authenticate`;
a 6 MB upload reached Flux (its own 400 answer, not nginx's 413). With `FLUX_TRUSTED_PROXIES` empty
the session recorded the Docker bridge gateway `192.168.160.1`; with that address as
`192.168.160.1/32`, a sign-in carrying a forged `X-Forwarded-For: 203.0.113.199` recorded the real
client `127.0.0.1`. Public DNS, ACME and the redirect block were not exercised.

## Traefik

Traefik's file provider, with a static configuration (`traefik.yml`) and a dynamic one
(`flux.yml`). Traefik forwards WebSocket upgrades and sets `X-Forwarded-For` itself, and by default
it does not believe a client's own forwarding headers.

```yaml
# traefik.yml
entryPoints:
  web:
    address: ":80"
    http:
      redirections:
        entryPoint: { to: websecure, scheme: https }
  websecure:
    address: ":443"
    transport:
      respondingTimeouts:
        readTimeout: 0s   # no limit on reading a slow upload
certificatesResolvers:
  letsencrypt:
    acme:
      email: ops@example.org
      storage: /letsencrypt/acme.json
      httpChallenge: { entryPoint: web }
providers:
  file:
    filename: /etc/traefik/flux.yml
```

```yaml
# flux.yml
http:
  routers:
    flux:
      rule: Host(`flux.example.org`)
      entryPoints: [websecure]
      service: flux
      tls:
        certResolver: letsencrypt
  services:
    flux:
      loadBalancer:
        servers:
          - url: http://127.0.0.1:8081
```

Run Traefik on the host network (or otherwise able to reach `127.0.0.1:<FLUX_PORT>`), keep
`/letsencrypt` on a volume, and [trust only the measured proxy peer](#trust-only-the-measured-proxy-peer).
If Flux and Traefik share a Compose network you could point the service at the API container
instead, but Flux's Compose files publish the API on loopback only, and this guide keeps it so.

**Tested** on 2026-10-31 with `traefik:v3.5` (Traefik 3.5.6, digest
`sha256:16acb89c6db341182970d6fdafece31303b0a380a8ed7aa51682e225229bf1d2`), same host and Flux as the
nginx run, with a `websecure` entry point on the test port, the same `readTimeout`, the file
provider and a static certificate under `tls.certificates` instead of the ACME resolver. The same
probes passed: health, sign-up, `/api/v1/me`, WebSocket 101 on `/api/v1/stream`, MCP metadata and
401 challenge, and a 6 MB upload reaching Flux. A sign-in with a forged
`X-Forwarded-For: 203.0.113.199` recorded `127.0.0.1`. The ACME resolver, the port-80 redirect and
public DNS were not exercised.

## Other proxies

Any proxy works when it serves the whole origin from one host name, passes WebSocket upgrades on any
path (`/api/v1/stream`, `/api/v1/typing`, `/api/v1/agent-runtime/console`, and `/media/*` with
live media), does not buffer or time
out long-lived connections sooner than a few minutes, accepts request bodies of at least the largest video you allow (5 MiB for everything else), passes `Range` requests and `206 Partial Content` answers through (a video seeks with them), and
does not rewrite paths, `Host`, cookies or `Authorization`. A CDN or second proxy in front changes
which address Flux sees: trust only the hop that connects to Flux, and make sure that hop replaces
any client-supplied `X-Forwarded-For`.

Flux limits how fast the API is called (1,200 requests a minute per session once the server has accepted it, 600 a minute per address
without one and 1,200 a minute per address for a session cookie or bearer it has not accepted yet; an IPv6 address counts as its /64). The address is the client's only when `FLUX_TRUSTED_PROXIES` names your proxy; without it every request comes from the
proxy, so everyone shares the per-address budgets and a busy company can meet the limit. Set it as described above.

## Headers

Flux sends its own `Content-Security-Policy` on the app's pages and its service worker. The policy lists the SHA-256 of the
page's inline scripts and the page's own origin for sockets (`FLUX_PUBLIC_ORIGIN`), so a proxy must pass it through unchanged: do not
add, replace or strip `Content-Security-Policy`, `X-Frame-Options` or `Content-Security-Policy-Report-Only` for Flux's
host. A second policy added at the proxy is combined with Flux's by the browser (every policy must allow a request) and
can only break the app. Serve Flux on the origin `FLUX_PUBLIC_ORIGIN` names: the policy is written for it.

## Built-in HTTPS evidence

Observed on 2026-11-13 (#1471) with an isolated copy of the checkout on a Linux Docker Engine 29.4.2 host: a first `./flux up`
(loopback origin), then `FLUX_PUBLIC_ORIGIN=https://127.0.0.1:23443` and `FLUX_CALLS=on` in its `docker/.env` and `./flux up` again.
An IP address gets a certificate from Caddy's own CA, so no public ACME was attempted; public DNS and ACME stay unexercised here.

- `./flux up` printed `The API trusts only Caddy's address: FLUX_TRUSTED_PROXIES=172.19.64.2/32`, and `docker inspect` gave the `proxy`
  container exactly `172.19.64.2` on the `edge` network; the API's own process environment had the same value.
- With Caddy's root certificate: `/api/v1/health` answered `ok` on `https://127.0.0.1:23443`; `http://127.0.0.1/x` answered
  `308` to `https://127.0.0.1:23443/x`; the MCP metadata named `https://127.0.0.1:23443/mcp` and `POST /mcp` answered `401` (HTTP/2) with
  the matching `WWW-Authenticate`; a WebSocket upgrade of `/api/v1/stream` with the session cookie answered `101`.
- A sign-up and a sign-in through Caddy with a forged `X-Forwarded-For: 203.0.113.199` recorded `172.19.64.1`, the address Caddy saw
  (Docker's port forwarding on the same host), neither the forged one nor Caddy's own; a sign-in straight to the loopback API port with the
  same forged header recorded the API's socket peer `172.19.32.1`.
- With the origin back on `http://127.0.0.1:23081` and `FLUX_CALLS=off`, the next `./flux up` removed the `proxy` and `livekit`
  containers and their `edge` and `livekit-*` networks, and kept the `proxy-data` and `proxy-config` volumes.
- The first run found a defect this page's design fixes: the image's `caddy` binary has a file capability, so `cap_drop: [ALL]` alone
  makes it fail to start (`operation not permitted`); the overlay keeps `NET_BIND_SERVICE`, and Caddy's health check now makes `up` fail
  instead of reporting Flux running behind a proxy that is not.
