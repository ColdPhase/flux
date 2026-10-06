#!/bin/sh
# Render check for the k3s live-media values (#63, docs/development/live-media-k3s.md).
# Renders docker/k3s/livekit-values.yaml plus a site file with the pinned official LiveKit
# chart and checks the result, all in digest-pinned containers and without a cluster:
#   1. downloads chart livekit-server 1.9.0 and verifies its SHA-256; `helm lint`, `helm template`;
#   2. validates every object against the Kubernetes 1.37.1 schemas (kubeconform -strict);
#   3. asserts the agreed route and compares it with the Compose operator layers, then
#      checks that mutated renders (public signaling, port range, load balancer...) are refused.
# Network: helm.livekit.io and raw.githubusercontent.com (schemas pinned to one commit).
# Operators check their own site file before installing; documentation values are then refused:
#   FLUX_K3S_SITE_VALUES=/path/to/site.yaml ./scripts/check_live_k3s.sh
# FLUX_K3S_RENDER_OUT=<file> keeps the rendered manifests (they contain no secret).
set -eu

cd "$(dirname "$0")/.."
helm_image='alpine/helm:4.3.0@sha256:a6cf54599ccb99d90cf0712b30f03fdb3cab062e6b94e0418cc4db7e8a1464b2'
kubeconform_image='ghcr.io/yannh/kubeconform:v0.8.0@sha256:faffaf43f95aa6425306e1ab8d6fcad72acb9049158f38e574c085ea1ec0f64e'
yq_image='mikefarah/yq:4.54.1@sha256:4b3d9475d65571d28cbb19544d3820ec2945e4c8b2f18279394282b8dc3a592e'
# The application's own Node base image (docker/Dockerfile).
node_image='node@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1'
chart_version=1.9.0
chart_sha256=4fafb11011747552803061ce41480c7d2b4fa58d3471f6d3579d988c53399109
# k3s v1.37.1+k3s1 (2026-09-30); schemas from yannh/kubernetes-json-schema at one commit.
kubernetes_version=1.37.1
schema_commit=8df8a883b68a24a104b4a9e43c1288090ae60b3b

values=docker/k3s/livekit-values.yaml
if [ -n "${FLUX_K3S_SITE_VALUES:-}" ]; then site=$FLUX_K3S_SITE_VALUES; mode=operator
else site=docker/k3s/livekit-site.example.yaml; mode=example; fi
[ -f "$site" ] || { echo "check_live_k3s: no site values at $site" >&2; exit 2; }

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
cp "$values" "$work/values.yaml"
cp "$site" "$work/site.yaml"
cp scripts/live_k3s_render.mjs "$work/live_k3s_render.mjs"
chmod 755 "$work"
chmod 644 "$work"/*

echo "== chart livekit-server $chart_version: checksum, lint, render ($mode site values)"
docker run --rm -v "$work:/in:ro,z" --entrypoint sh "$helm_image" -ec '
  cd /tmp
  helm pull livekit-server --repo https://helm.livekit.io --version "$1" >&2
  echo "$2  livekit-server-$1.tgz" | sha256sum -c - >&2
  helm lint "livekit-server-$1.tgz" -f /in/values.yaml -f /in/site.yaml >&2
  helm template livekit "livekit-server-$1.tgz" --skip-tests -f /in/values.yaml -f /in/site.yaml
' sh "$chart_version" "$chart_sha256" > "$work/render.yaml"

echo "== Kubernetes $kubernetes_version schemas (strict)"
docker run --rm -i "$kubeconform_image" -strict -summary -kubernetes-version "$kubernetes_version" \
  -schema-location "https://raw.githubusercontent.com/yannh/kubernetes-json-schema/$schema_commit/{{.NormalizedKubernetesVersion}}-standalone{{.StrictSuffix}}/{{.ResourceKind}}{{.KindSuffix}}.json" \
  < "$work/render.yaml"

echo "== route assertions and Compose consistency"
# The Compose operator layers (no containers are started). Placeholder values only satisfy
# their required-variable interpolation; the comparison uses no key, secret or address.
env FLUX_LIVEKIT_API_KEY=k3scomposecheck FLUX_LIVEKIT_API_SECRET=k3s-compose-check-placeholder-secret-0000 \
  FLUX_LIVEKIT_PUBLIC_IP=198.51.100.10 FLUX_LIVEKIT_DOMAIN=media.flux.example \
  FLUX_LIVEKIT_TURN_DOMAIN=turn.flux.example FLUX_LIVEKIT_TURN_CERT_DIR=/nonexistent \
  docker compose -p "flux-k3s-check-$$" -f docker/compose.live.yaml -f docker/compose.live.turn.yaml \
  config --no-consistency --format json > "$work/compose.json"
docker run --rm -i "$yq_image" eval-all -o=json -I=0 \
  '[.] | (.[] | select(.kind == "ConfigMap") | .data."config.yaml") |= from_yaml' - \
  < "$work/render.yaml" > "$work/render.json"
docker run --rm -i "$yq_image" -p=json -o=json -I=0 \
  '.services.livekit | .environment.LIVEKIT_CONFIG |= from_yaml' - \
  < "$work/compose.json" > "$work/compose-livekit.json"
chmod 644 "$work"/*.json "$work/render.yaml"
docker run --rm -v "$work:/in:ro,z" "$node_image" \
  node /in/live_k3s_render.mjs /in/render.json /in/compose-livekit.json "$mode" /in/render.yaml

if [ -n "${FLUX_K3S_RENDER_OUT:-}" ]; then cp "$work/render.yaml" "$FLUX_K3S_RENDER_OUT"; fi
echo "k3s live-media render check passed: chart $chart_version ($chart_sha256), Kubernetes $kubernetes_version, $mode site values."
