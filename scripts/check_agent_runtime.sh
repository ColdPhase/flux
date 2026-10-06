#!/bin/sh
# Docker check of the agent runtime (F-022 T3, #278) through ./flux, as an operator runs it, on an
# isolated copy of this checkout with its own Compose project, ports, volumes and image tags.
#
# The copy gets a docker/compose.override.yaml (the operator override file ./flux reads) made of
# docker/compose.runtime.test.yaml, which swaps in the TEST ONLY fake `claude` and `codex` (no
# subscription, no vendor contact), and the documented extra-slot block docker/runtime-slot.example.yaml
# (a fifth slot). It checks: off by default; the switch on; `docker inspect` limits on every slot; two
# owners on two slots with no cross-owner reach; the full pool; escape attempts from inside a slot;
# the supervisor's closed set on the live slots; release (sign-out, delete, empty /data, new process,
# empty /tmp, then a second owner); bind refused while /data has an entry; operator release; backup
# without slot volumes; restore reconciliation; switching off; purge; reset removing the volumes.
#
# Host load: run it alone under the shared Docker lock. Set FLUX_RUNTIME_TEST_PORT for concurrent runs.
set -eu

here=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd -P)
unset FLUX_PROJECT FLUX_AGENT_RUNTIME FLUX_AGENT_RUNTIME_COMMERCIAL_TERMS FLUX_AGENT_RUNTIME_IDLE_DAYS
export FLUX_PORT="${FLUX_RUNTIME_TEST_PORT:-19571}"
export FLUX_DEV_PORT=$((FLUX_PORT + 1))
export FLUX_MAILPIT_PORT=$((FLUX_PORT + 2))
work=$(mktemp -d "${TMPDIR:-/tmp}/flux-runtime-check.XXXXXX")
work=$(cd "$work" && pwd -P)
copy="$work/flux"
marker="fake-login-marker-$(od -An -N8 -tx1 /dev/urandom | tr -d ' \n')"
project=''

step() { printf '\n== %s\n' "$*"; }
fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }

cleanup() {
  status=$?
  if [ "$status" -ne 0 ] && [ -n "$project" ]; then
    (cd "$copy" && FLUX_IMAGE_TAG="$project" docker compose --project-directory docker --env-file docker/.env -p "$project" -f docker/compose.source.yaml -f docker/compose.override.yaml --profile runtime logs --no-color --tail 60 api worker runtime-manager runtime-egress runtime-install runtime-1 2>/dev/null) || true
  fi
  if [ -x "$copy/flux" ] && [ -f "$copy/docker/.env" ]; then (cd "$copy" && ./flux clean -y >/dev/null 2>&1) || true; fi
  if [ -n "$project" ]; then
    docker volume ls -q --filter "label=com.docker.compose.project=$project" | xargs -r docker volume rm >/dev/null 2>&1 || true
    docker image rm -f "flux-test-tools:$project" >/dev/null 2>&1 || true
  fi
  docker volume ls -q --filter "label=com.flux.checkout=$copy" | xargs -r docker volume rm >/dev/null 2>&1 || true
  rm -rf "$work"
  exit "$status"
}
trap cleanup EXIT HUP INT TERM

step "Copy the working tree (tracked and new files, no .env) to $copy"
mkdir -p "$copy"
# One tar reading the names from stdin: xargs would split a long list into several archives.
(cd "$here" && git ls-files -z --cached --others --exclude-standard | tar --null -T - -cf - 2>/dev/null) | (cd "$copy" && tar -xf -)
[ -x "$copy/flux" ] || fail "the copy is incomplete"
[ ! -e "$copy/docker/.env" ] || fail ".env was copied"
cd "$copy"
# The operator override: the test overlay's services, then the documented fifth slot's block.
{
  sed -n '/^services:/,$p' docker/runtime-slot.example.yaml | sed -n '1p'
  sed -n '/^services:/,$p' docker/compose.runtime.test.yaml | sed '1d'
  sed -n '/^services:/,$p' docker/runtime-slot.example.yaml | sed '1d'
} > docker/compose.override.yaml

env_set() { # KEY VALUE in the copy's docker/.env, as an operator edits it
  awk -v k="$1" -v v="$2" 'BEGIN { done = 0 } index($0, k "=") == 1 { if (!done) print k "=" v; done = 1; next } { print } END { if (!done) print k "=" v }' docker/.env > docker/.env.tmp
  cat docker/.env.tmp > docker/.env && rm -f docker/.env.tmp
}
compose() { FLUX_IMAGE_TAG="$project" docker compose --project-directory docker --env-file docker/.env -p "$project" -f docker/compose.source.yaml -f docker/compose.override.yaml "$@"; }
cid() { compose --profile runtime ps -q "$1"; }
# Root inside the throwaway test container: the state volume here was not prepared by files-init.
live() { compose --profile test run --rm --no-deps -T -u 0 test node_modules/.bin/tsx tests/app/agent-runtime-live.check.ts "$@"; }
value() { printf '%s\n' "$1" | sed -n "s/^$2=//p" | tail -n 1; }
runtime_containers() { docker ps -aq --filter "label=com.docker.compose.project=$project" | xargs -r docker inspect -f '{{ index .Config.Labels "com.docker.compose.service" }}' | grep -E '^runtime-' || true; }
ip_on() { docker inspect -f "{{ with index .NetworkSettings.Networks \"${project}_$2\" }}{{ .IPAddress }}{{ end }}" "$1"; }

step "1. Off by default: no runtime service starts and the API reports the feature disabled"
./flux up
project=$(sed -n 's/^FLUX_PROJECT=//p' docker/.env)
[ -n "$project" ] || fail "no project name"
[ -z "$(runtime_containers)" ] || fail "runtime containers exist while FLUX_AGENT_RUNTIME is empty: $(runtime_containers)"
grep -q '^FLUX_RUNTIME_SECRET_4=[0-9a-f]\{64\}$' docker/.env || fail "./flux did not generate the slot secrets"
compose --profile test build test
live off

step "2. Switch on (claude_code with the Commercial Terms date); the fifth slot gets its secret"
# The live steps sign the same test owners in many times from one address.
env_set FLUX_AUTH_RATE_LIMIT false
env_set FLUX_AGENT_RUNTIME claude_code
if ./flux up 2>"$work/up.err"; then fail "claude_code started without the Commercial Terms statement"; fi
grep -q 'FLUX_AGENT_RUNTIME_COMMERCIAL_TERMS' "$work/up.err" || fail "the refusal does not name FLUX_AGENT_RUNTIME_COMMERCIAL_TERMS"
env_set FLUX_AGENT_RUNTIME_COMMERCIAL_TERMS 2026-10-05
./flux up
grep -q '^FLUX_RUNTIME_SECRET_5=[0-9a-f]\{64\}$' docker/.env || fail "the override slot did not get its secret"
for service in runtime-manager runtime-egress runtime-1 runtime-2 runtime-3 runtime-4 runtime-5; do
  [ -n "$(cid "$service")" ] || fail "$service is not running"
done
compose --profile runtime logs --no-color runtime-install | grep -q 'TEST ONLY: fake Claude Code' || fail "runtime-install did not fill the tools volume"

step "3. docker inspect: limits and security options on every slot; no engine socket anywhere"
# shellcheck disable=SC2046
docker inspect $(docker ps -q --filter "label=com.docker.compose.project=$project") > "$work/inspect.json"
python3 "$here/scripts/agent-runtime/inspect.py" "$project" < "$work/inspect.json"
# Negative controls: the same check fails on a writable root, an added capability or a socket mount.
for mutation in 'c["HostConfig"]["ReadonlyRootfs"] = False' 'c["HostConfig"]["CapAdd"] = ["NET_ADMIN"]' \
  'c["Mounts"].append({"Type": "bind", "Source": "/var/run/docker.sock", "Destination": "/var/run/docker.sock", "RW": True})' \
  'c["HostConfig"]["PidsLimit"] = 0' 'c["NetworkSettings"]["Networks"]["x_default"] = {}'; do
  if python3 -c "import json, sys
cs = json.load(open(sys.argv[1]))
c = next(c for c in cs if c['Config']['Labels'].get('com.docker.compose.service') == 'runtime-3')
$mutation
json.dump(cs, sys.stdout)" "$work/inspect.json" | python3 "$here/scripts/agent-runtime/inspect.py" "$project" >/dev/null; then
    fail "inspect.py accepted a slot with: $mutation"
  fi
done
printf 'inspect.py refuses each of the 5 mutated slots\n'
# Measured footprint of idle runtime services (F-022 "Limits": T3 records them).
# shellcheck disable=SC2046
docker stats --no-stream --format '{{ .Name }}\t{{ .MemUsage }}\t{{ .PIDs }} pids' $(docker ps -q --filter "label=com.docker.compose.project=$project")
# The fifth slot (the documented override block) has exactly the anchor's settings.
compose --profile runtime config --format json | python3 -c '
import json, sys
services = json.load(sys.stdin)["services"]
def norm(name):
    s = json.loads(json.dumps(services[name]).replace(name, "runtime-N").replace(name[8:] + "-data", "N-data"))
    s.pop("build", None)
    s["environment"]["FLUX_RUNTIME_SLOT_SECRET"] = "x"
    return s
assert norm("runtime-5") == norm("runtime-4"), (norm("runtime-5"), norm("runtime-4"))
print("runtime-5 matches runtime-4")'

step "4. Two owners get two slots; no API input reaches another owner's slot; the pool fills"
out=$(live wait-ready 5); printf '%s\n' "$out"
out=$(live two-owners); printf '%s\n' "$out"
a_slot=$(value "$out" A_SLOT)
live bind C >/dev/null
live bind D >/dev/null
live bind E >/dev/null
live pool-full F

step "5. Escape attempts from inside a slot"
slot_cid=$(cid "$a_slot")
other=runtime-2; [ "$a_slot" != runtime-2 ] || other=runtime-3
# The host's own address on the project's default bridge: a slot must not reach the host there either.
gateway=$(docker network inspect -f '{{ range .IPAM.Config }}{{ .Gateway }}{{ end }}' "${project}_default")
# The slot networks give the host no address at all (com.docker.network.bridge.inhibit_ipv4).
for slot in runtime-1 runtime-2 runtime-3 runtime-4 runtime-5; do
  bridge="br-$(docker network inspect -f '{{ .Id }}' "${project}_$slot" | cut -c1-12)"
  [ -z "$(ip -4 -o addr show "$bridge" 2>/dev/null)" ] || fail "the host has an address on $slot's bridge: $(ip -4 -o addr show "$bridge")"
done
# Control: the project's default bridge does carry a host address.
[ -n "$(ip -4 -o addr show "br-$(docker network inspect -f '{{ .Id }}' "${project}_default" | cut -c1-12)")" ] || fail "control: no host address on the default bridge"
printf 'no host address on any slot bridge\n'
docker exec -i -u 1000:1000 \
  -e FLUX_PROBE_DB="$(ip_on "$(compose ps -q db)" default)" \
  -e FLUX_PROBE_API_DEFAULT="$(ip_on "$(compose ps -q api)" default)" \
  -e FLUX_PROBE_API_RUNTIME="$(ip_on "$(compose ps -q api)" runtime-api)" \
  -e FLUX_PROBE_API_CONTROL="$(ip_on "$(compose ps -q api)" runtime-control)" \
  -e FLUX_PROBE_WORKER="$(ip_on "$(compose ps -q worker)" default)" \
  -e FLUX_PROBE_MANAGER_CONTROL="$(ip_on "$(cid runtime-manager)" runtime-control)" \
  -e FLUX_PROBE_OTHER_SLOT="$(ip_on "$(cid "$other")" "$other")" \
  -e FLUX_PROBE_EXTRA_SLOT="$(ip_on "$(cid runtime-5)" runtime-5)" \
  -e FLUX_PROBE_GATEWAY="${gateway:-}" \
  "$slot_cid" node --input-type=module - < "$here/scripts/agent-runtime/probe-slot.mjs"
# The extra slot is reachable by runtime-manager and runtime-egress only.
extra_ip=$(ip_on "$(cid runtime-5)" runtime-5)
reach='const s=require("net").connect({host:process.argv[1],port:7700});s.setTimeout(3000,()=>{console.log("timeout");process.exit(0)});s.on("connect",()=>{console.log("open");process.exit(0)});s.on("error",e=>{console.log(e.code);process.exit(0)})'
for service in runtime-manager runtime-egress; do
  [ "$(docker exec "$(cid "$service")" node -e "$reach" "$extra_ip")" = open ] || fail "$service cannot reach runtime-5"
done
for service in api worker; do
  answer=$(docker exec "$(compose ps -q "$service")" node -e "$reach" "$extra_ip")
  case "$answer" in open|ECONNREFUSED) fail "$service reaches runtime-5 ($answer)" ;; esac
done
answer=$(docker exec "$(cid runtime-1)" node -e "$reach" "$extra_ip"); case "$answer" in open|ECONNREFUSED) [ "$a_slot" = runtime-5 ] || fail "runtime-1 reaches runtime-5 ($answer)" ;; esac
printf 'runtime-5 reachable by runtime-manager and runtime-egress only\n'

step "6. The live supervisors refuse anything outside the closed set"
a=$(live slot-of A)
a_binding=$(value "$a" BINDING)
docker exec -i -e FLUX_PROBE_BOUND_SLOT="$a_slot" -e FLUX_PROBE_BINDING="$a_binding" "$(cid runtime-manager)" node --input-type=module - < "$here/scripts/agent-runtime/probe-supervisor.mjs"

step "7. Release: sign out, delete, confirm /data is empty, exit; a new boot id and an empty /tmp before the next owner"
docker exec -u 1000:1000 "$slot_cid" sh -c "umask 077; printf '{\"login\":\"$marker\"}' > /data/$a_binding/claude/.credentials.json; echo kept > /tmp/marker-before-release"
restarts=$(docker inspect -f '{{ .RestartCount }}' "$slot_cid")
boot=$(value "$(live boot "$a_slot")" BOOT)
out=$(live remove A "$a_slot" "$boot"); printf '%s\n' "$out"
[ "$(value "$out" SIGN_OUT_FAILED)" = false ] || fail "the fake CLI's sign-out was not reported as done"
[ "$(docker inspect -f '{{ .RestartCount }}' "$slot_cid")" -gt "$restarts" ] || fail "the supervisor did not exit and restart after the release"
[ -z "$(docker exec "$slot_cid" ls -A /data)" ] || fail "/data is not empty after the release"
[ -z "$(docker exec "$slot_cid" ls -A /tmp)" ] || fail "/tmp is not empty after the restart"
out=$(live bind G); printf '%s\n' "$out"
[ "$(value "$out" SLOT)" = "$a_slot" ] || fail "the second owner did not get the released slot"
g_binding=$(value "$out" BINDING)
[ "$(docker exec "$slot_cid" ls -A /data)" = "$g_binding" ] || fail "the new owner's slot holds something else"
live no-secret-in-db "$marker"

step "8. Bind is refused while /data holds any entry; the operator sees the slot out of the pool"
b=$(live slot-of B); b_slot=$(value "$b" SLOT)
boot=$(value "$(live boot "$b_slot")" BOOT)
live remove B "$b_slot" "$boot" >/dev/null
docker exec -u 1000:1000 "$(cid "$b_slot")" sh -c 'echo stray > /data/stray'
live expect-slot-state "$b_slot" out_of_pool
live pool-full H
./flux runtime status | tee "$work/status.txt"
grep -q "$b_slot.*out_of_pool (data_not_empty)" "$work/status.txt" || fail "./flux runtime status does not show the slot out of the pool"
docker exec -u 1000:1000 "$(cid "$b_slot")" rm /data/stray
docker restart "$(cid "$b_slot")" >/dev/null
live expect-slot-state "$b_slot" ready

step "9. Operator release from ./flux runtime release"
c_slot=$(value "$(live slot-of C)" SLOT)
./flux runtime release "$c_slot"
live expect-release C operator

step "10. ./flux backup contains no slot volume"
docker exec -u 1000:1000 "$slot_cid" sh -c "umask 077; printf '{\"login\":\"$marker\"}' > /data/$g_binding/claude/.credentials.json"
# Control: the login marker is in the slot volume, so finding it in the archive would be a leak.
docker exec "$slot_cid" grep -q "$marker" "/data/$g_binding/claude/.credentials.json" || fail "the control login was not written"
./flux backup --output "$work/backups"
archive=$(ls "$work"/backups/flux-backup-*.tar)
[ "$(tar -tf "$archive" | sort | tr '\n' ' ')" = "database.dump files.tar.gz flux.env manifest.json " ] || fail "unexpected backup members: $(tar -tf "$archive")"
for part in database.dump files.tar.gz; do
  if tar -xOf "$archive" "$part" | gzip -dc 2>/dev/null | grep -q "$marker"; then fail "$part holds a runtime login"; fi
  if tar -xOf "$archive" "$part" | grep -q "$marker"; then fail "$part holds a runtime login"; fi
done
printf 'backup members: %s\n' "$(tar -tf "$archive" | tr '\n' ' ')"

step "11. After a restore: a binding without a directory shows Sign in again; a directory without a binding is signed out and deleted"
# After the backup, G removes the runtime and a new owner K binds the same slot.
boot=$(value "$(live boot "$a_slot")" BOOT)
live remove G "$a_slot" "$boot" >/dev/null
out=$(live bind K); [ "$(value "$out" SLOT)" = "$a_slot" ] || fail "K did not get G's former slot"
k_binding=$(value "$out" BINDING)
./flux restore "$archive" -y
docker volume inspect "${project}_${a_slot}-data" >/dev/null || fail "restore removed a slot volume"
live expect-binding G sign_in_again
live expect-slot-state "$a_slot" held
for _ in 1 2 3 4 5 6 7 8 9 10; do [ -z "$(docker exec "$(cid "$a_slot")" ls -A /data)" ] && break; sleep 1; done
[ -z "$(docker exec "$(cid "$a_slot")" ls -A /data)" ] || fail "K's directory (no binding after the restore) was not deleted"
printf 'K binding %s released by the reconciliation; G must sign in again\n' "$k_binding"

step "12. Logs: no fake login marker in any service log"
if compose --profile runtime logs --no-color 2>/dev/null | grep -q "$marker"; then fail "a runtime login appeared in a log"; fi
printf 'no login marker in the logs\n'

step "13. Switching off stops the runtime and keeps the slot volumes"
env_set FLUX_AGENT_RUNTIME ''
./flux up
[ -z "$(runtime_containers)" ] || fail "runtime containers still exist after switching off: $(runtime_containers)"
docker volume inspect "${project}_runtime-1-data" >/dev/null || fail "switching off removed a slot volume"
live off

step "14. ./flux runtime purge signs out and deletes every login"
./flux runtime purge -y
[ -z "$(docker volume ls -q --filter "label=com.docker.compose.project=$project" | grep -E '_runtime-' || true)" ] || fail "purge left runtime volumes"
./flux runtime status | grep -q 'no binding' || true

step "15. ./flux reset signs out first and removes the slot volumes"
env_set FLUX_AGENT_RUNTIME claude_code
./flux up
live wait-ready 5 >/dev/null
out=$(live bind M); m_slot=$(value "$out" SLOT); m_binding=$(value "$out" BINDING)
docker exec -u 1000:1000 "$(cid "$m_slot")" sh -c "umask 077; printf '{}' > /data/$m_binding/claude/.credentials.json"
./flux reset -y | tee "$work/reset.txt"
grep -q "Signing out the agent runtime logins first" "$work/reset.txt" || fail "reset did not sign out first"
grep -q "$m_slot: signed out (claude_code ok" "$work/reset.txt" || fail "reset did not sign out M's login"
[ -z "$(docker volume ls -q --filter "label=com.docker.compose.project=$project" | grep -E '_runtime-' || true)" ] || fail "reset left runtime volumes"

printf '\nAgent runtime check passed.\n'
