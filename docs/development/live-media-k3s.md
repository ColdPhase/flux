# k3s media/TURN deployment contract (#63)

**Status 2026-09-28:** operator contract and review checklist. Flux has not
installed or tested this on a public k3s node. The Compose and local Docker
proof in [live-media.md](live-media.md) remains the only measured deployment.
Do not count this page as the k3s or external-network acceptance evidence.

## Inputs and topology

An operator supplies a public node or routable layer-4 address, a signaling
DNS name, a **separate TURN DNS name**, trusted certificates for both, the
LiveKit API key/secret shared with Flux API, and a protected Kubernetes TLS
Secret in the LiveKit namespace. Record the exact LiveKit image digest, chart
version, k3s version, node addresses, ingress/controller configuration and
firewall rules in the deployment handoff; do not commit real keys or certs.

LiveKit's [Kubernetes guide](https://docs.livekit.io/transport/self-hosting/kubernetes/)
requires host networking for the media pod and permits one pod per node. Its
[published chart values](https://github.com/livekit/livekit-helm/blob/master/livekit-server/values.yaml)
default `podHostNetwork` to true; chart installation alone does not configure
Flux-specific webhook, key, public address or firewall. Keep one replica on a
dedicated node for the first operator deployment; add nodes only after
separate multi-node/Redis/failover work is accepted.

| Traffic | Operator route | Validation |
| --- | --- | --- |
| Signal WSS/HTTPS | Public ingress TCP/443 on signaling DNS to LiveKit TCP/7880 | Join from an external browser; successful HTTP health alone is insufficient. |
| ICE UDP/TCP | Public node UDP/7882 and TCP/7881 direct to host-network pod | Check selected candidates and media both ways. |
| TURN/UDP + STUN | Public node UDP/3478 direct to pod | Verify external allocation and counters. |
| TURN/TLS | Dedicated public TCP/443 and TURN DNS direct to LiveKit, or a documented layer-4 TCP pass-through | Verify CA, hostname/SNI, TLS handshake and selected `relayProtocol=tls` with blocked UDP/direct ICE. |
| Flux API callback | LiveKit pod to protected Flux `/api/v1/internal/livekit/webhook` | Create/join/end/revoke session; verify generation and authorization behavior. |

Use a stable public `rtc.node_ip` with `rtc.use_external_ip: false` when the
node address is known; verify the advertised candidate equals the reachable
address. If operator NAT changes the address, update configuration and prove
external reachability before production use. Do not copy the Docker test's
`turn.allow_restricted_peer_cidrs: [172.16.0.0/12]`: LiveKit's default private
peer denial is the production boundary. If a private SFU peer is unavoidable,
write down the exact allowed CIDR and its risk before enabling it.

k3s [ServiceLB and bundled Traefik](https://docs.k3s.io/networking/networking-services)
normally occupy host ports 80 and 443 on their participating nodes. Reserve
TURN TCP/443 on a dedicated node/address with no such listener, or choose an
explicit layer-4 design that preserves the TURN TLS route. Do not attach TURN
to an HTTP Ingress rule: TURN/TLS is not HTTP. A pre-existing cluster must
be inspected before changing Traefik or ServiceLB scope; disabling them can
break unrelated applications. Signal ingress can remain elsewhere.

## Gate before accepting k3s

1. Render the pinned LiveKit chart with the exact values and inspect
   `hostNetwork`, image digest, mounted TLS Secret, API key handling, TURN
   listener, webhook URL and service ports. Archive the redacted render.
2. Install on an operator-controlled, publicly reachable k3s node. Inspect
   pod readiness, DNS, `ss -lntup`, firewall/NAT forwards and metrics.
3. From outside the node's LAN, verify `openssl s_client` on TURN TCP/443
   with SNI/hostname verification; then join with direct UDP and ICE/TCP
   blocked and assert a selected TLS relay pair **and received media**.
4. Run the #63 four-person/two-screen, real microphone and
   `getDisplayMedia` checks on supported desktop/tablet devices, including
   degradation and recovery. Record receiver frame dimensions, actual text
   legibility, audio continuity and warning behavior. This local synthetic
   Docker test cannot substitute for those observations.
5. Record chart/image/config versions, test time, external client network,
   observed candidate pairs, screenshots/logs, rollback and restart impact
   in #63. A failed or unavailable external test keeps this gate open.

Sources checked 2026-09-28: LiveKit's
[Kubernetes deployment guide](https://docs.livekit.io/transport/self-hosting/kubernetes/),
[deployment/TURN guide](https://docs.livekit.io/transport/self-hosting/deployment/),
[ports/firewall guide](https://docs.livekit.io/transport/self-hosting/ports-firewall/),
the [official Helm values](https://github.com/livekit/livekit-helm/blob/master/livekit-server/values.yaml),
and [k3s networking services](https://docs.k3s.io/networking/networking-services).
The dedicated node/address choice and gate sequence are Flux operator
inferences from those primary sources, not observed cluster results.
