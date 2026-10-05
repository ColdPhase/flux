# k3s media/TURN deployment contract (#63)

**Status 2026-10-05:** operator contract, checked-in chart values and a Docker
render check. The [route below](#route-decision--proposed-amendment-2026-10-06-peer-review-required)
is a proposed amendment pending peer review. Flux has not installed or tested
this on a public k3s node. The Compose and local Docker proof in
[live-media.md](live-media.md) remains the only measured deployment. Do not
count this page as the k3s or external-network acceptance evidence. What the
stack encrypts is recorded in [live-media-encryption.md](live-media-encryption.md).

## Checked-in values and render check

| File | Contents |
| --- | --- |
| [`docker/k3s/livekit-values.yaml`](../../docker/k3s/livekit-values.yaml) | Flux's values for the official chart `livekit-server` 1.9.0. They hold the Compose server digest, room limits and ports, a host-network pod with one replica and the `Recreate` strategy, keys from an existing Secret, no load balancer and no ingress. No secret, address or name of a site. |
| [`docker/k3s/livekit-site.example.yaml`](../../docker/k3s/livekit-site.example.yaml) | What each site supplies: media node selector, private signaling bind address, public `rtc.node_ip`, TURN name and TLS Secret, webhook key ID and URL. Placeholders only. |
| [`scripts/check_live_k3s.sh`](../../scripts/check_live_k3s.sh) and [`scripts/live_k3s_render.mjs`](../../scripts/live_k3s_render.mjs) | The render check below. |

`./scripts/check_live_k3s.sh` took 9 seconds with cached images (2026-10-05).
It starts no cluster and leaves no container, and runs in digest-pinned
containers: `alpine/helm` 4.3.0, `ghcr.io/yannh/kubeconform` v0.8.0,
`mikefarah/yq` 4.54.1, and the application's Node base image. It:

1. downloads chart `livekit-server` 1.9.0 from `helm.livekit.io` and stops
   unless its SHA-256 is
   `4fafb11011747552803061ce41480c7d2b4fa58d3471f6d3579d988c53399109`;
2. runs `helm lint` and `helm template --skip-tests` with the Flux values and
   the site file;
3. validates every rendered object in strict mode against the Kubernetes
   1.37.1 schemas (the k3s v1.37.1+k3s1 line). The schemas come from
   `yannh/kubernetes-json-schema` pinned to commit `8df8a883`;
4. asserts the route below on the render. It also compares the render with the
   Compose operator layers (`compose.live.yaml` plus `compose.live.turn.yaml`,
   via `docker compose config`): image digest, room limits, signaling and
   metrics ports, ICE and TURN ports, and webhook path;
5. applies 17 mutations to the passing render and fails unless the assertions
   refuse each. Examples: no host network, a rolling update, a LoadBalancer
   Service, an Ingress, the chart's port range, a public or wildcard signaling
   address, a private `node_ip`, inline keys, private TURN peers, TURN/TLS off
   443, another image or room limit, or a readable key Secret.

Before installing, an operator runs it with their own site file:
`FLUX_K3S_SITE_VALUES=/path/site.yaml ./scripts/check_live_k3s.sh`. In that
mode, documentation addresses and `.example` names are also refused. Set
`FLUX_K3S_RENDER_OUT` to keep the reviewed render. Then install the same
archive with the same two values files:

```sh
helm pull livekit-server --repo https://helm.livekit.io --version 1.9.0
echo "4fafb11011747552803061ce41480c7d2b4fa58d3471f6d3579d988c53399109  livekit-server-1.9.0.tgz" | sha256sum -c -
helm install livekit livekit-server-1.9.0.tgz -n <flux-namespace> \
  -f docker/k3s/livekit-values.yaml -f /path/site.yaml
```

The namespace is the Flux API's own, so that `http://livekit:7880` resolves.
Network access is needed for the chart and schema downloads. The check is not
a cluster test: it cannot see node addresses, firewall rules, admission
policies, DNS, certificates or media.

**Observed 2026-10-05:** the check passed with the example site values: checksum
OK, lint OK, 3/3 objects valid, route and Compose assertions passed, and 17/17
mutations refused. With the example file passed as an operator file, the check
failed on its documentation values, as intended. The render and output are in
the [2026-10-05 evidence](evidence/live-k3s/2026-10-05/README.md).

## Route decision — proposed amendment, 2026-10-06 (peer review required)

**Owner:** Zamojski5 (`claude-maurycy`), #63 T63-d. **Independent review:**
PelikanFix16 (`codex-hubert`). **Status:** proposed; it becomes the k3s route
only after that review. It agrees to Hubert's
[private-service route proposal of 2026-09-30](https://github.com/ColdPhase/flux/issues/63#issuecomment-5909081168)
and its [research archive](evidence/live-k3s/2026-09-30/ARCHIVE.md), and
amends it with items 3–5.

1. **Signaling only through Flux.** Browsers reach the k3s HTTP ingress over
   HTTPS/WSS, with WebSocket upgrade enabled. The ingress sends them to the
   Flux API's `/media` gate. The API calls the ClusterIP Service `livekit` as
   `http://livekit:7880`, in its own namespace: the API accepts plain HTTP
   only for that name. LiveKit binds signaling (7880) and metrics (6789) to
   the media node's private InternalIP and loopback. No Ingress, LoadBalancer,
   NodePort or public address carries 7880 or 6789.
2. **Media directly on the host.** One host-network LiveKit pod runs on one
   dedicated media node. The pod terminates ICE UDP/7882 (single mux; both
   range ends are 0), ICE TCP/7881, TURN UDP/3478 and TURN/TLS TCP/443 on the
   node's public address. That address is `rtc.node_ip`, with
   `use_external_ip: false`. Media never passes through the HTTP ingress.
3. **TURN/TLS on the media node's own 443.** It has its own DNS name and a
   `kubernetes.io/tls` Secret. Keep the media node out of the ServiceLB pool
   that serves Traefik: label only the ingress nodes
   `svccontroller.k3s.cattle.io/enablelb=true`. No other listener may hold its
   443. Leave `turn.bind_addresses` at LiveKit's default. LiveKit binds each
   relay socket to that address while advertising `rtc.node_ip`
   ([turn.go, v1.13.7](https://github.com/livekit/livekit/blob/v1.13.7/pkg/service/turn.go)).
   So a second address on a shared ingress node does not replace a dedicated
   media node.
4. **`Recreate`, not a rolling update.** The new pod needs the old pod's host
   ports, so a rolling update could never start it. The old pod drains for up
   to the chart's 5-hour grace period first. As in Compose, an update or
   restart interrupts that node's media.
5. **The render check is part of installation.** The operator runs it with the
   site file and installs the same verified archive and values.
6. **Preconditions the check cannot see.** The operator verifies these before
   install and records them in #63:
   - Node InternalIP = host-network PodIP = `livekit` EndpointSlice address =
     the first bind address, and it is private.
   - Persistent node or upstream firewall rules admit 7880 and 6789 only from
     the observed API, monitor and probe sources.
   - Pod NetworkPolicy does not protect a host-network pod: k3s's kube-router
     skips it (research archive).
   - Keys come from the existing Secret (`keys.yaml`, mode 0600). The webhook
     reaches the API Service over private HTTP and is signed.

**Alternatives considered:**

- **TURN or media through an HTTP Ingress:** rejected. TURN/TLS is not HTTP,
  and ICE is UDP.
- **NodePort or ServiceLB Services for media:** rejected. NodePorts are
  30000–32767 rather than the advertised ports. ServiceLB adds a DNAT hop and
  competes for 443. ICE needs the node's own advertised address.
- **Traefik TCP SNI passthrough to TURN/TLS on a shared node:** LiveKit
  v1.13.7 has `turn.proxy_protocol` with trusted CIDRs, so TURN would still see
  client addresses. This is a later option with its own end-to-end test. It is
  not part of this route.
- **Wildcard signaling bind plus firewall on a single-address node:**
  defensible according to the research, but outside this route. The render
  check refuses a public or wildcard bind. It needs its own review.
- **Flux-owned manifests instead of the chart:** not needed now. The pinned
  chart renders exactly the agreed objects. Reconsider if a chart release
  changes these defaults, or if probe and endpoint alignment cannot be met.
- **Several media nodes with Redis:** deferred, as before.

**Reconsider when:**

- the target node has no private InternalIP;
- external tests show NAT hairpin or advertised-address problems;
- a newer chart or server is pinned;
- more than one media node is needed.

The [dated research/render archive](evidence/live-k3s/2026-09-30/ARCHIVE.md)
contains the official chart 1.9.0 checksum, Helm 4.3.0 render/lint observations,
independent source review and a pinned-image relative-key startup probe. The
unchanged chart's probes and Service endpoints require the bound private address
to match Node InternalIP, host-network PodIP and EndpointSlice. Node firewall
rules remain necessary. These local observations do not complete the gates
below.

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
| Flux WSS/HTTPS | Public ingress TCP/443 to Flux API; `/media` proxies to private LiveKit TCP/7880 | Join through the current session/admission gate; refuse direct public SFU signaling. |
| ICE UDP/TCP | Public node UDP/7882 and TCP/7881 direct to host-network pod | Check selected candidates and media both ways. |
| TURN/UDP + STUN | Public node UDP/3478 direct to pod | Verify external allocation and counters. |
| TURN/TLS | Dedicated public TCP/443 and TURN DNS direct to LiveKit, or a documented layer-4 TCP pass-through | Verify CA, hostname/SNI, TLS handshake and selected `relayProtocol=tls` with blocked UDP/direct ICE. |
| Private room service and callback | Flux API to private LiveKit TCP/7880; LiveKit pod to protected Flux `/api/v1/internal/livekit/webhook` | Create/join/end/revoke session; verify generation and authorization behavior. |

Use a stable public `rtc.node_ip` with `rtc.use_external_ip: false` when the
node address is known; verify the advertised candidate equals the reachable
address. If operator NAT changes the address, update configuration and prove
external reachability before production use. Do not copy the Docker test's
`turn.allow_restricted_peer_cidrs: [172.16.0.0/12]`: LiveKit's default private
peer denial is the production boundary. If a private SFU peer is unavoidable,
write down the exact allowed CIDR and its risk before enabling it.

The checked-in values set both inherited RTC range endpoints to zero
alongside UDP mux 7882; otherwise the chart's nonzero range defaults take
precedence. They keep the existing key Secret's mode 0600 and the relative
`keys.yaml`, which works in the pinned image's bounded Docker probe. An
absolute key path needs a reviewed Secret-key/subPath adjustment.

k3s [ServiceLB and bundled Traefik](https://docs.k3s.io/networking/networking-services)
normally occupy host ports 80 and 443 on their participating nodes. Reserve
TURN TCP/443 on a dedicated node/address with no such listener, or choose an
explicit layer-4 design that preserves the TURN TLS route. Do not attach TURN
to an HTTP Ingress rule: TURN/TLS is not HTTP. A pre-existing cluster must
be inspected before changing Traefik or ServiceLB scope; disabling them can
break unrelated applications. Signal ingress can remain elsewhere.

## Gate before accepting k3s

1. Run `scripts/check_live_k3s.sh` with the site values. It renders the pinned
   chart with the exact values and asserts `hostNetwork`, image digest, mounted
   TLS Secret, API key handling, TURN listener, webhook URL and service ports.
   Archive the render (`FLUX_K3S_RENDER_OUT`). The check passes for the example
   values; a real site file has not been checked yet.
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
