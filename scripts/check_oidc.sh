#!/bin/sh
# Human single sign-on (#113) and provider sign-in on the MCP authorization path (#310) in Docker: a pinned, disposable Keycloak (docker/compose.oidc.test.yaml)
# is the operator's OpenID Connect provider; a real browser runs the authorization-code flow against
# the Compose API. Covers sign-in, the same subject across an email change, refused unverified and
# colliding identities, a replayed or forged callback, a session across an API restart, session
# revocation, mail to each chosen mailbox, links that open only while authorized, and one
# message per actual mailbox. A deterministic mock provider with a second API replica checks that
# ID tokens with a bad nonce, signature, issuer or audience are refused on the real callback.
# FLUX_OIDC_CLOSEOUT=1 also exercises genuine boot outage/recovery and the official pinned MCP
# clients against Keycloak (only their model endpoint is mocked; no vendor account is used).
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
outage_pid=
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
old_issuer="http://keycloak:8080/realms/flux-legacy"
if command -v sha256sum >/dev/null 2>&1; then old_digest=$(printf '%s' "$old_issuer" | sha256sum); else old_digest=$(printf '%s' "$old_issuer" | shasum -a 256); fi
old_provider_id="oidc-$(printf '%s' "$old_digest" | cut -c1-12)"
export FLUX_OIDC_OLD_ISSUER="$old_issuer"
export FLUX_OIDC_OLD_PROVIDER_ID="$old_provider_id"
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
  if [ -n "$outage_pid" ]; then kill "$outage_pid" 2>/dev/null || true; fi
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
if [ "${FLUX_OIDC_CLOSEOUT:-0}" = "1" ]; then $compose --profile mcp-clients build test mcp-clients; fi
$compose up -d db migrate
$compose --profile setup run --rm files-init
if [ "${FLUX_OIDC_CLOSEOUT:-0}" = "1" ]; then
  $compose wait migrate
  # Direct checker/SQL regressions need only this fresh database; finish them before the sole-provider
  # API starts, so test-provider reconciliation cannot touch a real Keycloak session.
  $compose run --rm --no-deps test node_modules/.bin/tsx --test tests/app/idp-standing.test.ts
  # Deliberately omit the IdP, including Compose's dependency startup, for the real boot-outage row.
  export FLUX_OIDC_TEST_SSO_MODE=sso
  $compose up -d --no-deps --wait api mailpit
  $compose run --rm --no-deps -e FLUX_OIDC_PROVIDER_ID="$provider_id" e2e \
    node_modules/.bin/tsx --test tests/app/e2e/oidc-boot-outage.e2e.ts > "$work/boot-outage.log" 2>&1 &
  outage_pid=$!
  attempts=0
  until grep -q OIDC_BOOT_OUTAGE_OBSERVED "$work/boot-outage.log"; do
    if ! kill -0 "$outage_pid" 2>/dev/null || [ "$attempts" -ge 90 ]; then cat "$work/boot-outage.log"; exit 1; fi
    attempts=$((attempts + 1)); sleep 1
  done
  $compose up -d --wait keycloak
  if wait "$outage_pid"; then cat "$work/boot-outage.log"; else cat "$work/boot-outage.log"; exit 1; fi
  outage_pid=
fi
# Migration phase first (#315): the API runs in prepare mode, so password accounts may link Keycloak before cutover.
export FLUX_OIDC_TEST_SSO_MODE=prepare
$compose up -d --wait keycloak oidc-mock mailpit api api-mock worker

e2e() { $compose run --rm -e FLUX_OIDC_PROVIDER_ID="$provider_id" e2e node_modules/.bin/tsx --test --test-concurrency=1 "$@"; }

# Link a password account before cutover, restart the API between the start and the finish, refuse held identities.
link() { $compose run --rm -e FLUX_OIDC_PROVIDER_ID="$provider_id" -e FLUX_OIDC_OLD_ISSUER="$old_issuer" \
  -e FLUX_OIDC_OLD_PROVIDER_ID="$old_provider_id" -e FLUX_LINK_PHASE="$1" e2e node_modules/.bin/tsx --test --test-concurrency=1 --test-name-pattern "$2" tests/app/e2e/oidc-link.e2e.ts; }
link prepare "prepare: a password account starts"
$compose restart api
$compose up -d --wait api
link prepare "prepare: (an ordinary provider|after the API restart|a subject already held|a link cannot)"
link prepare "prepare: seed an explicit old-issuer recovery account"
# Cutover (#315): the API restarts in SSO-only mode. The password-only accounts stay refused; the linked one signs in
# with the provider and reaches the same account.
export FLUX_OIDC_TEST_SSO_MODE=sso
$compose up -d --wait api
# The operator re-key (#315) in the running SSO-only API: refused without --allow-sso, and with it the lookup by Flux id
# still refuses an address or an unknown id. The refusal names its code, and nothing is written.
cli() { $compose exec -T api node apps/server/dist/identity/cli.js "$@"; }
refused=$(cli link nobody@acme.test --subject sub-cli --reason "check" 2>&1 || true)
echo "$refused" | grep -q 'refused (SSO_MODE)' || { echo "$refused" >&2; echo "Expected the SSO-only refusal from the operator command" >&2; exit 1; }
missing=$(cli link nobody@acme.test --subject sub-cli --reason "check" --allow-sso 2>&1 || true)
echo "$missing" | grep -q 'refused (NO_ACCOUNT)' || { echo "$missing" >&2; echo "Expected NO_ACCOUNT for an address, even with the flag" >&2; exit 1; }

# Positive issuer-change recovery: this named password account has one explicit legacy mapping and real old MCP
# authority. The explicit old issuer must match that mapping, while a currently held target subject still refuses.
recovery_user_id=$($compose run --rm e2e node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync("/state/oidc-recovery.json", "utf8")).userId)')
recovery_new_subject=$($compose run --rm e2e node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync("/state/oidc-recovery.json", "utf8")).newSubject)')
recovery_held_subject=$($compose run --rm e2e node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync("/state/oidc-recovery.json", "utf8")).heldSubject)')
without_old=$(cli link "$recovery_user_id" --subject "$recovery_new_subject" --reason "issuer migration test" --allow-sso 2>&1 || true)
echo "$without_old" | grep -q 'refused (OLD_ISSUER_REQUIRED)' || { echo "$without_old" >&2; echo "Expected OLD_ISSUER_REQUIRED without --old-issuer" >&2; exit 1; }
wrong_old=$(cli link "$recovery_user_id" --old-issuer "http://unrelated.example.test" --subject "$recovery_new_subject" --reason "issuer migration test" --allow-sso 2>&1 || true)
echo "$wrong_old" | grep -q 'refused (OLD_IDENTITY_MISMATCH)' || { echo "$wrong_old" >&2; echo "Expected OLD_IDENTITY_MISMATCH for a wrong old issuer" >&2; exit 1; }
held=$(cli link "$recovery_user_id" --old-issuer "$old_issuer" --subject "$recovery_held_subject" --reason "issuer migration test" --allow-sso 2>&1 || true)
echo "$held" | grep -q 'refused (SUBJECT_HELD)' || { echo "$held" >&2; echo "Expected a held target subject to refuse recovery" >&2; exit 1; }
recovered=$(cli link "$recovery_user_id" --old-issuer "$old_issuer" --subject "$recovery_new_subject" --reason "issuer migration test" --allow-sso 2>&1 || true)
echo "$recovered" | grep -q '^rekeyed:' || { echo "$recovered" >&2; echo "Expected a successful issuer-change re-key" >&2; exit 1; }
# The operator unlink (#315) is the only removal of the provider sign-in. In SSO-only mode the last way in is refused
# (the account has no usable password), an unknown account is not linked, and nothing is written by a refusal.
unlink_last=$(cli unlink "$recovery_user_id" --reason "check" 2>&1 || true)
echo "$unlink_last" | grep -q 'refused (LAST_IDENTITY)' || { echo "$unlink_last" >&2; echo "Expected LAST_IDENTITY from the operator unlink in SSO-only mode" >&2; exit 1; }
unlink_missing=$(cli unlink nobody@acme.test --reason "check" 2>&1 || true)
echo "$unlink_missing" | grep -q 'refused (NOT_LINKED)' || { echo "$unlink_missing" >&2; echo "Expected NOT_LINKED for an address" >&2; exit 1; }
link recovery "recovery: issuer re-key keeps the Flux account"
link cutover "cutover:"

e2e tests/app/e2e/oidc.e2e.ts
# Provider sign-in on the MCP authorization path (F-024 S1, #310): a scripted client, Keycloak, Chromium.
e2e tests/app/e2e/oidc-mcp.e2e.ts
# Bad ID tokens on the real callback, through the replica whose provider is the mock.
$compose run --rm -e FLUX_API_URL=http://api-mock:8080 -e FLUX_OIDC_MOCK_PROVIDER_ID="$mock_provider_id" e2e \
  node_modules/.bin/tsx --test --test-concurrency=1 tests/app/e2e/oidc-bad-token.e2e.ts
# Each of the 8 refused callbacks (4 modes x 2 identities) failed in the API's ID-token verifier.
refused=$($compose logs --no-color api-mock | grep -c 'id_token failed verification' || true)
echo "api-mock refused $refused ID tokens in its verifier"
if [ "$refused" -ne 8 ]; then echo "Expected 8 ID-token verification refusals, saw $refused" >&2; exit 1; fi
# A single sign-on session survives an API restart (prepare saves the browser state in /state).
e2e --test-name-pattern prepare tests/app/e2e/oidc-restart.e2e.ts
$compose restart api
$compose up -d --wait api
e2e --test-name-pattern verify tests/app/e2e/oidc-restart.e2e.ts

if [ "${FLUX_OIDC_CLOSEOUT:-0}" = "1" ]; then
  $compose --profile mcp-clients run --rm -e FLUX_OIDC_PROVIDER_ID="$provider_id" \
    -e FLUX_OIDC_TEST_PASSWORD="$FLUX_OIDC_TEST_PASSWORD" mcp-clients sh -c \
    'node apps/runtime/dist/install/main.js && exec node_modules/.bin/tsx --test --test-concurrency=1 tests/app/e2e/oidc-clients.e2e.ts'
  export FLUX_OIDC_TEST_STANDING=off
  $compose up -d --wait api
  $compose run --rm -e FLUX_OIDC_PROVIDER_ID="$provider_id" -e FLUX_OIDC_EXPECT_STANDING_OFF=1 e2e \
    node_modules/.bin/tsx --test --test-concurrency=1 --test-name-pattern '^(setup:|confirmation age)' tests/app/e2e/oidc-mcp.e2e.ts
fi

echo 'Single sign-on check passed.'
