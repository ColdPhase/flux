# Calls and screen sharing

Calls, cameras and screen sharing need a media server next to Flux. One switch turns it on (founder decision 4 of
[#1471](https://github.com/ColdPhase/flux/issues/1471), 2026-11-13).

## Turn calls on

Calls need the [`https` origin](reverse-proxy.md#built-in-https) of a real server (a loopback origin
works for trying it on one computer). In `docker/.env`:

```dotenv
FLUX_CALLS=on
```

```sh
./flux up
```

`./flux` then adds [`docker/compose.live.yaml`](../../docker/compose.live.yaml) (one LiveKit server, pinned
by digest) to every command it runs, `backup`, `upgrade` and `restore` included; there is no `-f` to
remember. On that `up` it also:

- writes `FLUX_LIVEKIT_API_KEY` and `FLUX_LIVEKIT_API_SECRET` into `docker/.env`, once, and never
  changes them afterwards;
- uses the origin's host (`flux.example.org` for `https://flux.example.org`) as the media name for STUN
  and TURN (a `FLUX_LIVEKIT_DOMAIN` of your own in `docker/.env` replaces it);
- looks up the IPv4 address that name resolves to on the server and writes it as
  `FLUX_LIVEKIT_PUBLIC_IP`, the address browsers send media to. Every `./flux up` looks again and
  updates the line when the address changed. An origin that is an IP address is used as it is. A
  `FLUX_CALLS_PUBLIC_IP` of your own in `docker/.env` replaces the lookup
  ([split-horizon DNS or a proxy on another machine](#split-horizon-dns-or-a-proxy-on-another-machine));
- prints what it found and the ports to open, for example:

```text
Calls: on. Media server flux.example.org at 203.0.113.20 (what flux.example.org resolves to); open 7881/tcp, 7882/udp and 3478/udp to this server.
```

Open those ports in the host firewall and any cloud security group (with NAT, forward them to the server):

| Inbound | Purpose |
| --- | --- |
| UDP/7882 | Media (ICE over UDP). The main path. |
| TCP/7881 | Media over TCP, when UDP is blocked. |
| UDP/3478 | STUN and TURN over UDP. |

Signaling goes through Flux itself at `<origin>/media`, over the same HTTPS as the app; LiveKit's own
port (TCP/7880) is never published. Media is encrypted in transit and decrypted in the media server; it
is not end-to-end encrypted. A call holds at most 16 people. `FLUX_LIVEKIT_ICE_TCP_PORT`,
`FLUX_LIVEKIT_ICE_UDP_PORT` and `FLUX_LIVEKIT_TURN_UDP_PORT` change the host ports if another service has them.

Then start a call in a space and join it from a second device on another network (a phone on mobile
data): a running media server proves only that it started, not that media reaches it from outside.

## What the origin's DNS must say

The media address comes from the origin's name, so that name's A record must be the server's own public
IPv4 address:

- **No A record** (only AAAA, or none yet): `./flux up` stops and says so. Add the record and run it again.
- **The name resolves to a loopback address on the server** (often a line in `/etc/hosts` that maps the
  server's own name to `127.0.1.1`): `./flux up` stops and says so, because browsers cannot send media
  there. Make the name resolve to the public address on the server too, or set `FLUX_CALLS_PUBLIC_IP`.
- **A private address** (10.x, 172.16–31.x, 192.168.x, 100.64–127.x): `up` goes on and says that calls
  reach only devices on the same network. That is right for a home lab or office network. If browsers
  reach this server at another address, set `FLUX_CALLS_PUBLIC_IP` (next section).
- **A CDN or another proxy in front of the name** (its address, not the server's): media cannot flow.
  Point the name at the server itself.

## Split-horizon DNS, or a proxy on another machine

The lookup asks the server's own resolver. That is the wrong question when the server and the browsers
get different answers for the origin's name. A common case is Flux behind your own proxy (Traefik,
nginx) on another machine: internal DNS answers the origin's name with the proxy's LAN address, public
DNS answers it with the public address, and the router forwards 7881/tcp, 7882/udp and 3478/udp to the
Flux host. Left alone, `./flux up` would advertise the proxy's LAN address, which forwards no media
ports, and say that calls reach only devices on the same network.

Set the address yourself in `docker/.env`:

```dotenv
FLUX_CALLS=on
FLUX_CALLS_PUBLIC_IP=203.0.113.20
```

`./flux up` then keeps it: it checks only that the value is an IPv4 address, looks nothing up (the
origin needs no A record on the server, and no `/etc/hosts` line), writes it as `FLUX_LIVEKIT_PUBLIC_IP`
for Compose, and prints it:

```text
Calls: on. Media server flux.example.org at 203.0.113.20 (FLUX_CALLS_PUBLIC_IP in docker/.env); open 7881/tcp, 7882/udp and 3478/udp to this server.
```

Forward the media ports to the Flux host itself. The proxy carries only the HTTPS of the origin, which
includes `/media`, never the media. `FLUX_LIVEKIT_DOMAIN` sets the media name the same way when it should
not be the origin's host; without `FLUX_CALLS_PUBLIC_IP`, the lookup then asks for that name. Leave both
out (or empty) and everything above applies as it is. The launcher writes `FLUX_LIVEKIT_PUBLIC_IP`
itself on every `up`, so an address of your own goes in `FLUX_CALLS_PUBLIC_IP`, not there.

## Resources

The media server has limits of its own, like every other Flux service ([#1558](https://github.com/ColdPhase/flux/issues/1558)): `FLUX_LIVEKIT_MEMORY`
(default `512m`, memory and swap alike, so it cannot swap) and `FLUX_LIVEKIT_CPUS` (default `1`; Docker refuses a CPU limit above the
server's cores, so one also starts on a 1-core server). Without them a call with many people or a misbehaving client could take the
whole server's memory and CPU from the database and the keyring. It also runs with no capabilities, no new privileges, a read-only
root, at most 512 processes and an init process.

**Measured 2026-11-20** (LiveKit 1.13.11, Docker 29.4.2, Linux x86_64; the container's cgroup, sampled every 1 to 2 seconds): a room with the
most people a call holds, 16: four publishing high-resolution simulcast video (the LiveKit CLI's load test, `lk load-test`, 60 seconds) and
twelve receiving all four. LiveKit used **75 MB at its peak and 3 to 4 % of one core on average (7 % peak)** with the speaker layout, and
**86 MB and 3 % (9 % peak)** with the 4×4 layout and speaker changes; 10 processes, 31 and 12 Mbit/s out, no packet lost. The defaults leave
about six times that memory and ten times that CPU. It is a synthetic load, not a real call: the load test sends prepared video without audio or
text, from the same host. Watch `docker stats` on your server during a real call and raise the limits if it reaches them.

## The limit: no TURN over TLS

With one public address, port 443 belongs to the HTTPS proxy, so the media server cannot also offer
TURN over TLS on 443. Most networks reach a call over UDP/7882, TCP/7881 or TURN over UDP/3478; a
network that lets **only HTTPS on 443** out (some corporate, hotel and school networks) cannot join a
call. Serving those people takes a second public IP address for TURN/TLS, with its own name and
certificate: the TURN/TLS overlay `compose.live.turn.yaml` of a source checkout
([live media](../development/live-media.md)). The launcher does not set that up, and a release does not ship it; layer it through
`docker/compose.override.yaml` only if you have that second address.

## Turn calls off

Set `FLUX_CALLS=off` and run `./flux up`: the media server is removed, the API no longer offers calls,
and the app hides Call (the "Sounds" switch in Settings › Notifications stays, as it also covers the message tone). The
key, secret and address stay in `docker/.env` for the next time. The media server keeps no data, so
backups need nothing for it.
