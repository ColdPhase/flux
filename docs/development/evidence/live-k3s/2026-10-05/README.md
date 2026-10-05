# k3s values render check, 2026-10-05

**Tested files:** commit `f620819f941e92ba811d16a77513c73175549b92` on branch
`claude-maurycy/63-live-boundary`. That is the last commit touching
`docker/k3s/`, `scripts/check_live_k3s.sh` and `scripts/live_k3s_render.mjs`.
Owner: `claude-maurycy`; independent review by `codex-hubert` pending. It
supports the [values, render check and proposed route](../../../live-media-k3s.md).

SHA-256 of the inputs and the output:

| File | SHA-256 |
| --- | --- |
| `docker/k3s/livekit-values.yaml` | `1f4e1343cd279dc6e5fa59eda7cda1b19dbc5c3cbba4376e2f54da7f90352dc3` |
| `docker/k3s/livekit-site.example.yaml` | `a43d15dcab294ec53d85a41bb35a887f5e62c9b7009bd4fbb4067778e8a177ac` |
| [`render-example.yaml`](render-example.yaml) | `a9e3f61175334e318e5f25a622a943d4399db6b3680daca8386ba169cd48bc88` |

## Runs

Both ran on macOS with Docker Desktop, using the images pinned in the script.
[`check-output.txt`](check-output.txt) holds the output without pull progress.

1. `FLUX_K3S_RENDER_OUT=… ./scripts/check_live_k3s.sh` exited 0:
   - the chart archive SHA-256 matched;
   - `helm lint` passed (one informational note: the chart has no icon);
   - kubeconform found 3 objects, all valid against Kubernetes 1.37.1 in
     strict mode, none skipped;
   - the route and Compose-consistency assertions passed;
   - the assertions refused 17/17 mutated renders.
2. The same check with the example file as `FLUX_K3S_SITE_VALUES` exited 1, as
   intended: "no documentation address or .example name left in the site
   values". This run took 9 seconds with cached images.

## The render

`render-example.yaml` has three objects:

- **ConfigMap `livekit`:**
  - signaling and metrics bound to `10.20.0.10` and `127.0.0.1`;
  - `node_ip` `198.51.100.10`;
  - ICE TCP 7881 and UDP 7882, with range ends 0;
  - TURN UDP 3478 and TLS 443 under `turn.flux.example`;
  - room limits equal to Compose; webhook to the Flux API Service;
  - `key_file: keys.yaml`, no keys inline.
- **Service `livekit`:** ClusterIP, 7880 → `http`.
- **Deployment `livekit`:**
  - one replica, `Recreate`, `hostNetwork: true`,
    `ClusterFirstWithHostNet`;
  - node selector set; grace period 18000 s;
  - the Compose image digest `v1.13.7@sha256:6fd3b708…`;
  - host ports 7881/TCP, 7882/UDP, 3478/UDP and 443/TCP;
  - keys from the Secret flux-livekit-keys at mode 0600;
  - TURN certificate from the Secret flux-turn-tls.

No Secret, Ingress or load balancer is rendered.

The only differences from the
[2026-09-30 candidate render](../2026-09-30/candidate-render.yaml) are the
`Recreate` strategy, the example Secret, node-selector and webhook key names,
and the resulting config checksum.

## Limits

Addresses and names are documentation placeholders. Rendering and schema
validation do not show any of the following:

- a working installation or admission by a real API server;
- node address alignment or firewall rules;
- DNS, certificates, NAT or media.

These remain the gates in the [deployment contract](../../../live-media-k3s.md#gate-before-accepting-k3s).
