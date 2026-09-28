#!/bin/sh
set -eu

cd "$(dirname "$0")/.."
project="flux-live-turn-$(date +%s)-$$"
cert_dir=$(mktemp -d)
chmod 755 "$cert_dir"
export POSTGRES_USER=flux
export POSTGRES_DB=flux
export POSTGRES_PASSWORD="flux-live-turn-$$-$(date +%s)"
export FLUX_FIXTURE_TOKEN="flux-live-turn-fixture-$$-$(date +%s)"
export FLUX_PORT="${FLUX_LIVE_TURN_TEST_PORT:-18861}"
export FLUX_PUBLIC_ORIGIN="http://127.0.0.1:${FLUX_PORT}"
export FLUX_AUTH_SECRET="auth-live-turn-$$-$(date +%s)-$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')"
export FLUX_AUTH_RATE_LIMIT=false
export FLUX_IMAGE_TAG="$project"
export FLUX_LIVEKIT_API_KEY=fluxturntestingkey
export FLUX_LIVEKIT_API_SECRET=fluxturntestingsecretwithatleast32characters
export FLUX_LIVEKIT_API_URL=http://livekit:7880
export FLUX_LIVEKIT_WS_URL=ws://livekit:7880
export FLUX_LIVEKIT_PUBLIC_IP=127.0.0.1
export FLUX_LIVEKIT_DOMAIN=livekit
export FLUX_LIVEKIT_TURN_DOMAIN=turn.flux.test
export FLUX_LIVEKIT_TURN_CERT_DIR="$cert_dir"
export FLUX_LIVEKIT_SIGNAL_PORT="${FLUX_LIVE_TURN_TEST_SIGNAL_PORT:-18862}"
export FLUX_LIVEKIT_ICE_TCP_PORT="${FLUX_LIVE_TURN_TEST_ICE_TCP_PORT:-18863}"
export FLUX_LIVEKIT_ICE_UDP_PORT="${FLUX_LIVE_TURN_TEST_ICE_UDP_PORT:-18864}"
export FLUX_LIVEKIT_TURN_UDP_PORT="${FLUX_LIVE_TURN_TEST_TURN_UDP_PORT:-18865}"
export FLUX_LIVEKIT_TURN_TLS_BIND=127.0.0.1
export FLUX_LIVEKIT_TURN_TLS_HOST_PORT="${FLUX_LIVE_TURN_TEST_TLS_PORT:-18867}"
export FLUX_LIVEKIT_METRICS_PORT="${FLUX_LIVE_TURN_TEST_METRICS_PORT:-18866}"

compose="docker compose -p $project -f infra/compose.yaml -f infra/compose.live.yaml -f infra/compose.live.test.yaml -f infra/compose.live.turn.yaml -f infra/compose.live.turn.test.yaml --profile live-test"
cleanup() {
  status=$?
  if [ "$status" -ne 0 ]; then
    $compose logs --no-color --tail=80 db migrate api livekit live-sfu-test || true
  fi
  $compose down -v || true
  rm -rf "$cert_dir"
  if [ "${FLUX_KEEP_TEST_IMAGES:-0}" != 1 ]; then
    docker image rm "flux-foundation:$project" "flux-e2e:$project" "flux-live-sfu-test:$project" 2>/dev/null || true
  fi
}
trap cleanup EXIT HUP INT TERM

# Disposable local CA signs a non-CA TURN leaf. Only this test container trusts
# it; operators must supply a publicly trusted cert for their own TURN DNS name.
docker build -f infra/Dockerfile --target e2e -t "flux-e2e:$project" .
printf 'subjectAltName=DNS:turn.flux.test\nbasicConstraints=critical,CA:FALSE\nextendedKeyUsage=serverAuth\nkeyUsage=digitalSignature,keyEncipherment\n' > "$cert_dir/turn.ext"
docker run --rm --entrypoint sh -v "$cert_dir:/certs:z" "flux-e2e:$project" -ec '
  openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj /CN=Flux-local-TURN-CA \
    -keyout /certs/ca.key -out /certs/ca.pem >/dev/null 2>&1
  openssl req -newkey rsa:2048 -nodes -subj /CN=turn.flux.test \
    -keyout /certs/privkey.pem -out /certs/turn.csr >/dev/null 2>&1
  openssl x509 -req -in /certs/turn.csr -CA /certs/ca.pem -CAkey /certs/ca.key \
    -CAcreateserial -days 1 -extfile /certs/turn.ext \
    -out /certs/fullchain.pem >/dev/null 2>&1
'
$compose build migrate live-sfu-test
$compose up -d --wait api livekit
$compose run --rm live-sfu-test
