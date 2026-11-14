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
  and TURN;
- looks up the IPv4 address that name resolves to on the server and writes it as
  `FLUX_LIVEKIT_PUBLIC_IP`, the address browsers send media to. Every `./flux up` looks again and
  updates the line when the address changed. An origin that is an IP address is used as it is;
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
  there. Make the name resolve to the public address on the server too.
- **A private address** (10.x, 172.16–31.x, 192.168.x, 100.64–127.x): `up` goes on and says that calls
  reach only devices on the same network. That is right for a home lab or office network.
- **A CDN or another proxy in front of the name** (its address, not the server's): media cannot flow.
  Point the name at the server itself.

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
and the app hides Call and the "Sound when someone calls me" switch in Settings › Notifications. The
key, secret and address stay in `docker/.env` for the next time. The media server keeps no data, so
backups need nothing for it.
