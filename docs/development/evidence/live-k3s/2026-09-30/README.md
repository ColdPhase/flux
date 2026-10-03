# k3s private signaling: render and pinned-container observations

2026-09-30, #63. Persona: a self-hosting operator deploying Flux live media while preserving #128's current cookie/session/admission gate. Question: can the pinned official host-network chart preserve private signaling and metrics, protected API keys, and the existing public ICE/TURN port contract?

This is a non-deployed contract fixture. `candidate-values.yaml` uses documentation addresses/DNS and references placeholder existing Secrets. `candidate-render.yaml` is the exact output of offline Helm **4.3.0** rendering official LiveKit chart **1.9.0**, archive SHA256 `4fafb11011747552803061ce41480c7d2b4fa58d3471f6d3579d988c53399109`. The official index currently lists this chart with appVersion v1.9.0; the render explicitly overrides the image to Flux's existing v1.13.7 digest. No chart/server compatibility claim follows from successful rendering alone.

Observed commands in a Docker container based on the repository's pinned Node image:

```sh
helm template livekit ./livekit-server --namespace flux -f candidate-values.yaml
helm lint ./livekit-server -f candidate-values.yaml
```

Both passed. The rendered objects are a ConfigMap, ClusterIP Service and one host-network Deployment. The image is digest-pinned; the API key is referenced through an existing Secret at mode 0600, not written into the ConfigMap. TLS is referenced through its own Secret. No public signaling Ingress or TURN LoadBalancer object is rendered. These facts do not establish node firewall isolation or a working Kubernetes install.

The render sets `bind_addresses` to a hypothetical stable private node address plus loopback. The unpatched chart probes and selector-based Service use the host-network PodIP. Therefore the values-only route requires the operator to verify **Node InternalIP = host-network PodIP = Service EndpointSlice address = bound private address**, and the Flux API's route to that address. Public clients must be refused on signaling/metrics addresses and ports. A ClusterIP Service or an assumed NetworkPolicy does not itself prove that a host listener is private. A different private bind address needs matching probes AND endpoints; changing only probes is insufficient.

The stock chart retains UDP range defaults when values merge. This fixture explicitly sets both range endpoints to zero alongside UDP mux 7882. Public media remains TCP7881, UDP7882, TURN UDP3478 and dedicated TURN TLS443. The media node must be outside any conflicting Traefik/ServiceLB443 listener; no existing cluster settings were changed.

## Pinned image observation that weakens a suspected blocker

The chart uses `key_file` for both the mount path and subPath. A relative `keys.yaml` initially looked suspicious. Kubernetes source shows relative mount paths are normalized by kubelet; the actual pinned image has working directory `/`.

A disposable, network-isolated SFU container using the exact Flux image loaded **relative `key_file: keys.yaml`** from `/keys.yaml` with mode0600 and started version1.13.7. Loopback signaling17880 and Prometheus16789 both returned HTTP200, recorded in `relative-key-health-check.txt`; the running state is retained in `relative-key-container-state.json`. Only a mock credential was used. The container was removed and no host media devices or public ports were exposed. `runtime-relative-key-config.yaml` records the test configuration; the disposable credential is excluded from the archive.

The first mock file mode0644 was correctly refused with `key file others permissions must be set to 0`; this diagnostic is retained. The relative case is therefore **not** a demonstrated admission/runtime blocker for the pinned image. An absolute `key_file` still cannot be copied blindly into the chart's subPath; an explicitly chosen absolute mount would need a relative Secret key/subPath patch.

Both downloaded renderer archives originally exited139 through an unlabeled bind mount. A subsequent file read returned permission denied. Adding the repository's SELinux `:ro,z` convention let the identical verified Helm4.3.0 binary run; no downgrade was required. These tooling failures do not establish a chart or server defect.

## Recommendation and remaining evidence

Proposed baseline: one dedicated media node, verified private NodeIP/PodIP/Service endpoints for signaling and metrics, private Service DNS `livekit` reachable by the API, protected existing key/TLS Secrets, digest pin and explicit mux/range settings. This preserves the current accepted plain-HTTP private service exception for hostname `livekit`; another API hostname requires private HTTPS under the existing server configuration contract. Keep public Flux `/media` as the browser signaling entry.

Alternative: an explicit private endpoint/probe render adjustment or private HTTPS service if the operator topology cannot provide matching private PodIP. This is additional operational configuration to agree and test, not a reason to expose7880. Rotation of subPath-mounted Secrets needs an explicit drain/restart and current API/SFU verification; a Secret update alone is not acceptance.

Independent research review is requested. The operator route/inputs require peer agreement before checked-in deployment implementation. No public k3s node, real certificates, external NAT/restrictive client, Kubernetes admission, live-media path, restart/rollback or physical device was verified here. #63 AC-1 remains open. Reconsider the baseline if the target node has only a public PodIP, incompatible port ownership, or the API cannot reach the private Service safely.

Primary sources checked 2026-09-30:

- [LiveKit Kubernetes deployment](https://docs.livekit.io/transport/self-hosting/kubernetes/): host networking and one pod per node; this is vendor documentation, not Flux deployment evidence.
- [Official chart index](https://helm.livekit.io/index.yaml) and verified `livekit-server-1.9.0.tgz`: render inputs/defaults and existing-Secret support.
- [Server v1.13.7 config](https://github.com/livekit/livekit/blob/v1.13.7/pkg/config/config.go) and [server listeners](https://github.com/livekit/livekit/blob/v1.13.7/pkg/service/server.go): bind-address treatment for HTTP and metrics. The runtime digest test is separately observed.
- [Kubernetes probes](https://kubernetes.io/docs/concepts/workloads/pods/probes/): the target host when PodIP differs from loopback/private bind.
- [Kubernetes NetworkPolicy](https://kubernetes.io/docs/concepts/services-networking/network-policies/#networkpolicy-and-hostnetwork-pods): host-network behavior depends on the network plugin.
- [Kubernetes v1.35.0 kubelet mount handling](https://github.com/kubernetes/kubernetes/blob/v1.35.0/pkg/kubelet/kubelet_pods.go): relative mount normalization and absolute-subPath refusal.
- [k3s networking services](https://docs.k3s.io/networking/networking-services): default Traefik/ServiceLB port ownership and scoped node selection.

The recommendation is a Flux inference combining the observed render/runtime result with those sources, not a provider guarantee or final acceptance.
