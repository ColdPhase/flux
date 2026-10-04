#!/bin/sh
# Human single sign-on (#113) in Docker: a pinned, disposable Keycloak (docker/compose.oidc.test.yaml)
# is the operator's OpenID Connect provider; a real browser runs the authorization-code flow against
# the Compose API. Covers sign-in, the same subject across an email change, refused unverified and
# colliding identities, a replayed or forged callback, a session across an API restart, session
# revocation, mail to each chosen mailbox, links that open only while authorized, and one
# message per actual mailbox. A deterministic mock provider with a second API replica checks that
# ID tokens with a bad nonce, signature, issuer or audience are refused on the real callback.
# Own Compose project, loopback ports (FLUX_OIDC_TEST_PORT, default
# 18095, and the next one for Mailpit), per-run secrets; it removes its containers, volumes and images.
set -eu

cd "$(dirname "$0")/.."
project="flux-oidc-$(date +%s)-$$"
export POSTGRES_USER=flux
export POSTGRES_DB=flux
export POSTGRES_PASSWORD="flux-oidc-$$-$(date +%s)"
export FLUX_FIXTURE_TOKEN="fixture-oidc-$$-$(date +%s)"
export FLUX_TEST_FAILURE_INJECTION=true
export FLUX_PORT="${FLUX_OIDC_TEST_PORT:-18095}"
export FLUX_MAILPIT_PORT="$((FLUX_PORT + 1))"
export FLUX_PUBLIC_ORIGIN="http://127.0.0.1:${FLUX_PORT}"
export FLUX_AUTH_SECRET="auth-oidc-$$-$(date +%s)-$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')"
export FLUX_SMTP_URL="smtp://mailpit:1025"
export FLUX_MAIL_FROM="Flux <flux@example.test>"
export FLUX_AUTH_RATE_LIMIT=false
export FLUX_STREAM_HEARTBEAT_MS=1000

work=$(mktemp -d)
background_secret_dir="$work/background"
mkdir "$background_secret_dir"
head -c 32 /dev/urandom > "$background_secret_dir/background_key"
chmod 0444 "$background_secret_dir/background_key"
export FLUX_BACKGROUND_KEY_HOST_FILE="$background_secret_dir/background_key"

# Per-run identity provider secrets and realm (the redirect URI names this run's origin and the
# issuer-derived provider id, exactly as the API computes it).
issuer="http://keycloak:8080/realms/flux"
if command -v sha256sum >/dev/null 2>&1; then digest=$(printf '%s' "$issuer" | sha256sum); else digest=$(printf '%s' "$issuer" | shasum -a 256); fi
provider_id="oidc-$(printf '%s' "$digest" | cut -c1-12)"
mock_issuer="http://oidc-mock:9400"
if command -v sha256sum >/dev/null 2>&1; then mock_digest=$(printf '%s' "$mock_issuer" | sha256sum); else mock_digest=$(printf '%s' "$mock_issuer" | shasum -a 256); fi
mock_provider_id="oidc-$(printf '%s' "$mock_digest" | cut -c1-12)"
client_secret="oidc-client-$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')"
export FLUX_OIDC_TEST_PASSWORD="user-$(od -An -N12 -tx1 /dev/urandom | tr -d ' \n')"
export FLUX_OIDC_TEST_ADMIN_PASSWORD="admin-$(od -An -N12 -tx1 /dev/urandom | tr -d ' \n')"
export FLUX_OIDC_CLIENT_SECRET_HOST_FILE="$work/oidc_client_secret"
printf '%s\n' "$client_secret" > "$FLUX_OIDC_CLIENT_SECRET_HOST_FILE"
chmod 0444 "$FLUX_OIDC_CLIENT_SECRET_HOST_FILE"
export FLUX_OIDC_TEST_REALM="$work/flux-realm.json"
sed -e "s#__CLIENT_SECRET__#${client_secret}#" -e "s#__PUBLIC_ORIGIN__#${FLUX_PUBLIC_ORIGIN}#" \
  -e "s#__PROVIDER_ID__#${provider_id}#" -e "s#__USER_PASSWORD__#${FLUX_OIDC_TEST_PASSWORD}#g" \
  docker/oidc/flux-realm.template.json > "$FLUX_OIDC_TEST_REALM"
chmod 0444 "$FLUX_OIDC_TEST_REALM"

. scripts/test_images.sh
compose="docker compose -p $project -f docker/compose.source.yaml -f docker/compose.test.yaml -f docker/compose.oidc.test.yaml --profile test --profile oidc"

cleanup() {
  status=$?
  if [ "$status" -ne 0 ]; then
    $compose logs --no-color keycloak oidc-mock migrate api api-mock worker mailpit || true
  fi
  $compose down -v || true
  remove_project_images
  rm -rf "$work"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

$compose build migrate e2e
$compose up -d db migrate
$compose --profile setup run --rm files-init
$compose up -d --wait keycloak oidc-mock mailpit api api-mock worker

e2e() { $compose run --rm -e FLUX_OIDC_PROVIDER_ID="$provider_id" e2e node_modules/.bin/tsx --test --test-concurrency=1 "$@"; }

e2e tests/app/e2e/oidc.e2e.ts
# Bad ID tokens on the real callback, through the replica whose provider is the mock.
$compose run --rm -e FLUX_API_URL=http://api-mock:8080 -e FLUX_OIDC_MOCK_PROVIDER_ID="$mock_provider_id" e2e \
  node_modules/.bin/tsx --test --test-concurrency=1 tests/app/e2e/oidc-bad-token.e2e.ts
# A single sign-on session survives an API restart (prepare saves the browser state in /state).
e2e --test-name-pattern prepare tests/app/e2e/oidc-restart.e2e.ts
$compose restart api
$compose up -d --wait api
e2e --test-name-pattern verify tests/app/e2e/oidc-restart.e2e.ts

echo 'Single sign-on check passed.'
