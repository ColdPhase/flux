#!/bin/sh
# Docker check of the agent runtime (F-022 T3, #278) through ./flux, as an operator runs it, on an
# isolated copy of this checkout with its own Compose project, ports, volumes and image tags.
#
# The copy gets a docker/compose.override.yaml (the operator override file ./flux reads) made of
# docker/compose.runtime.test.yaml, which swaps in the TEST ONLY fake `claude` and `codex` (no
# subscription, no vendor contact). It checks: off by default; the switch on; `docker inspect` limits; several
# owners in the one runtime, each under their own user id, with no cross-owner reach; escape attempts from inside it;
# the supervisor's closed set on the live runtime; release (sign-out, delete, the others untouched,
# empty /tmp, then a second owner); bind refused while /data has an entry; operator release; the
# Claude Code sign-in console (T4 #279: each method's exact command in a PTY, the CLI's URL, a pasted code,
# signed in only from `auth status`, sign-out, cross-member attach refused, the PTY ending on exit and on
# disconnect, a seeded-secret scan, and the console and its notices in a browser at phone width); backup
# without slot volumes; restore reconciliation; switching off; purge; reset removing the volumes.
# FLUX_RUNTIME_SCREENSHOT_DIR (absolute) keeps the browser step's screenshots.
#
# T6 (#281) adds Codex: the switch lists both clients, ChatGPT's device sign-in runs through the console and
# one assistant run goes to the owner's fake Codex.
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
# T4: the fake credential the console's sign-ins write, and the codes typed at the CLI's prompt.
console_secret="fake-console-login-$(od -An -N8 -tx1 /dev/urandom | tr -d ' \n')"
console_code="fake-code-$(od -An -N6 -tx1 /dev/urandom | tr -d ' \n')"
project=''

step() { printf '\n== %s\n' "$*"; }
fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }

cleanup() {
  status=$?
  if [ "$status" -ne 0 ] && [ -n "$project" ]; then
    (cd "$copy" && FLUX_IMAGE_TAG="$project" docker compose --project-directory docker --env-file docker/.env -p "$project" -f docker/compose.source.yaml -f docker/compose.source.runtime.yaml -f docker/compose.override.yaml --profile runtime logs --no-color --tail 60 api worker runtime-manager runtime-egress runtime-install runtime-1 2>/dev/null) || true
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
# The operator override: the test overlay's services.
cp docker/compose.runtime.test.yaml docker/compose.override.yaml

env_set() { # KEY VALUE in the copy's docker/.env, as an operator edits it
  awk -v k="$1" -v v="$2" 'BEGIN { done = 0 } index($0, k "=") == 1 { if (!done) print k "=" v; done = 1; next } { print } END { if (!done) print k "=" v }' docker/.env > docker/.env.tmp
  cat docker/.env.tmp > docker/.env && rm -f docker/.env.tmp
}
compose() { FLUX_IMAGE_TAG="$project" docker compose --project-directory docker --env-file docker/.env -p "$project" -f docker/compose.source.yaml -f docker/compose.source.runtime.yaml -f docker/compose.override.yaml "$@"; }
cid() { compose --profile runtime ps -q "$1"; }
# Root inside the throwaway test container: the state volume here was not prepared by files-init.
live() { compose --profile test run --rm --no-deps -T -u 0 test node_modules/.bin/tsx tests/app/agent-runtime-live.check.ts "$@"; }
value() { printf '%s\n' "$1" | sed -n "s/^$2=//p" | tail -n 1; }
runtime_containers() { docker ps -aq --filter "label=com.docker.compose.project=$project" | xargs -r docker inspect -f '{{ index .Config.Labels "com.docker.compose.service" }}' | grep -E '^runtime-' || true; }
# Addresses on a bridge, read in a container in the Docker host's network namespace (the host's own `ip`
# is Linux-only and, with Docker Desktop, would look at the wrong machine). Empty when there is none.
host_addr() { docker run --rm --network host --cap-drop ALL --read-only --entrypoint ip "flux-test-tools:$project" -4 addr show dev "$1" 2>/dev/null | sed -n 's/^ *inet \([0-9.]*\).*/\1/p'; }
ip_on() { docker inspect -f "{{ with index .NetworkSettings.Networks \"${project}_$2\" }}{{ .IPAddress }}{{ end }}" "$1"; }

step "1. Off by default: no runtime service starts and the API reports the feature disabled"
./flux up </dev/null   # no terminal: the first-run subscription question is not asked
project=$(sed -n 's/^FLUX_PROJECT=//p' docker/.env)
[ -n "$project" ] || fail "no project name"
[ -z "$(runtime_containers)" ] || fail "runtime containers exist while FLUX_AGENT_RUNTIME is empty: $(runtime_containers)"
grep -q '^FLUX_RUNTIME_SECRET_1=[0-9a-f]\{64\}$' docker/.env || fail "./flux did not generate the runtime's secret"
compose --profile test build test
live off

step "2. Switch on (claude_code with the Commercial Terms date)"
# The live steps sign the same test owners in many times from one address.
env_set FLUX_AUTH_RATE_LIMIT false
env_set FLUX_AGENT_RUNTIME claude_code,codex
if ./flux up 2>"$work/up.err"; then fail "claude_code started without the Commercial Terms statement"; fi
grep -q 'FLUX_AGENT_RUNTIME_COMMERCIAL_TERMS' "$work/up.err" || fail "the refusal does not name FLUX_AGENT_RUNTIME_COMMERCIAL_TERMS"
env_set FLUX_AGENT_RUNTIME_COMMERCIAL_TERMS 2026-10-05
./flux up
for service in runtime-manager runtime-egress runtime-1; do
  [ -n "$(cid "$service")" ] || fail "$service is not running"
done
compose --profile runtime logs --no-color runtime-install | grep -q 'TEST ONLY: fake Claude Code' || fail "runtime-install did not fill the tools volume"

step "3. docker inspect: limits and security options of the runtime; no engine socket anywhere"
# shellcheck disable=SC2046
docker inspect $(docker ps -q --filter "label=com.docker.compose.project=$project") > "$work/inspect.json"
python3 "$here/scripts/agent-runtime/inspect.py" "$project" "$copy" < "$work/inspect.json"
# Negative controls: the same check fails on a writable root, an added capability or a socket mount.
for mutation in 'c["HostConfig"]["ReadonlyRootfs"] = False' 'c["HostConfig"]["CapAdd"] = ["NET_ADMIN"]' \
  'c["Mounts"].append({"Type": "bind", "Source": "/var/run/docker.sock", "Destination": "/var/run/docker.sock", "RW": True})' \
  'c["Mounts"].append({"Type": "bind", "Source": "/var/run", "Destination": "/host-run", "RW": False})' \
  'c["HostConfig"]["PidsLimit"] = 0' 'c["NetworkSettings"]["Networks"]["x_default"] = {}'; do
  if python3 -c "import json, sys
cs = json.load(open(sys.argv[1]))
c = next(c for c in cs if c['Config']['Labels'].get('com.docker.compose.service') == 'runtime-1')
$mutation
json.dump(cs, sys.stdout)" "$work/inspect.json" | python3 "$here/scripts/agent-runtime/inspect.py" "$project" "$copy" >/dev/null; then
    fail "inspect.py accepted the runtime with: $mutation"
  fi
done
printf 'inspect.py refuses each of the 6 mutated runtimes\n'
# Measured footprint of idle runtime services (F-022 "Limits": T3 records them).
# shellcheck disable=SC2046
docker stats --no-stream --format '{{ .Name }}\t{{ .MemUsage }}\t{{ .PIDs }} pids' $(docker ps -q --filter "label=com.docker.compose.project=$project")
# A person's own user id in the runtime, as `docker exec -u` wants it.
person_of() { docker exec "$(cid runtime-1)" stat -c %u:%g "/data/$1"; }

step "4. Owners share one runtime; no API input reaches another owner's place; there is no fixed number of people"
out=$(live wait-ready 1); printf '%s\n' "$out"
out=$(live two-owners); printf '%s\n' "$out"
a_slot=$(value "$out" A_SLOT)
live bind C >/dev/null
live bind D >/dev/null
live bind E >/dev/null
live room-for-everyone F

step "5. Escape attempts from inside the runtime"
slot_cid=$(cid "$a_slot")
a=$(live slot-of A)
a_binding=$(value "$a" BINDING)
a_person=$(person_of "$a_binding")
b_binding=$(value "$(live slot-of B)" BINDING)
[ "$a_person" != "$(person_of "$b_binding")" ] || fail "two people share a user id"
docker exec -i -u "$a_person" "$slot_cid" node --input-type=module - supervisor < "$here/scripts/agent-runtime/probe-process.mjs"
docker exec -i -u "$a_person" "$slot_cid" node --input-type=module - /opt/flux-runtime/apps/runtime/native/protect.node < "$here/scripts/agent-runtime/probe-process.mjs"
if docker exec -u "$a_person" "$slot_cid" ls "/data/$b_binding" >/dev/null 2>&1; then fail "one person can list another's directory"; fi
if docker exec -u "$a_person" "$slot_cid" ls /data >/dev/null 2>&1; then fail "a person can list who else is in the runtime"; fi
# The host's own address on the project's default bridge: the runtime must not reach the host there either.
gateway=$(docker network inspect -f '{{ range .IPAM.Config }}{{ .Gateway }}{{ end }}' "${project}_default")
# The runtime's network gives the host no address at all (com.docker.network.bridge.inhibit_ipv4).
bridge="br-$(docker network inspect -f '{{ .Id }}' "${project}_runtime-1" | cut -c1-12)"
[ -z "$(host_addr "$bridge")" ] || fail "the host has an address on the runtime's bridge: $(host_addr "$bridge")"
# Control: the project's default bridge does carry a host address.
[ -n "$(host_addr "br-$(docker network inspect -f '{{ .Id }}' "${project}_default" | cut -c1-12)")" ] || fail "control: no host address on the default bridge"
printf 'no host address on the runtime bridge\n'
docker exec -i -u "$a_person" \
  -e FLUX_PROBE_DB="$(ip_on "$(compose ps -q db)" default)" \
  -e FLUX_PROBE_API_DEFAULT="$(ip_on "$(compose ps -q api)" default)" \
  -e FLUX_PROBE_API_RUNTIME="$(ip_on "$(compose ps -q api)" runtime-api)" \
  -e FLUX_PROBE_API_CONTROL="$(ip_on "$(compose ps -q api)" runtime-control)" \
  -e FLUX_PROBE_WORKER="$(ip_on "$(compose ps -q worker)" default)" \
  -e FLUX_PROBE_MANAGER_CONTROL="$(ip_on "$(cid runtime-manager)" runtime-control)" \
  -e FLUX_PROBE_GATEWAY="${gateway:-}" \
  "$slot_cid" node --input-type=module - < "$here/scripts/agent-runtime/probe-slot.mjs"

step "6. The live supervisor refuses anything outside the closed set"
docker exec -i -e FLUX_PROBE_BOUND_SLOT="$a_slot" -e FLUX_PROBE_BINDING="$a_binding" "$(cid runtime-manager)" node --input-type=module - < "$here/scripts/agent-runtime/probe-supervisor.mjs"

step "7. Release: sign out, delete that person only; nobody else is touched and the runtime does not restart"
docker exec -u "$a_person" "$slot_cid" sh -c "umask 077; printf '{\"login\":\"$marker\"}' > /data/$a_binding/claude/.credentials.json; sleep 300 &"
restarts=$(docker inspect -f '{{ .RestartCount }}' "$slot_cid")
boot=$(value "$(live boot "$a_slot")" BOOT)
out=$(live remove A "$a_slot" "$boot"); printf '%s\n' "$out"
[ "$(value "$out" SIGN_OUT_FAILED)" = false ] || fail "the fake CLI's sign-out was not reported as done"
[ "$(docker inspect -f '{{ .RestartCount }}' "$slot_cid")" = "$restarts" ] || fail "the runtime restarted for one person's release"
if docker exec "$slot_cid" test -e "/data/$a_binding"; then fail "the person's directory survived the release"; fi
if docker exec "$slot_cid" ps -o uid= -A | grep -qx " *${a_person%:*}"; then fail "a process of the person survived the release"; fi
docker exec "$slot_cid" test -d "/data/$b_binding" || fail "someone else's directory went with the release"
out=$(live bind G); printf '%s\n' "$out"
g_binding=$(value "$out" BINDING)
docker exec "$slot_cid" test -d "/data/$g_binding" || fail "the next owner has no place"
live no-secret-in-db "$marker"

step "8. A stray entry in /data takes the runtime out of use; the operator sees it and removing it is enough"
docker exec "$slot_cid" sh -c 'echo stray > /data/stray'
live expect-slot-state "$a_slot" out_of_pool
./flux runtime status | tee "$work/status.txt"
grep -q "$a_slot.*out_of_pool (data_not_empty)" "$work/status.txt" || fail "./flux runtime status does not show the runtime out of use"
docker exec "$slot_cid" rm /data/stray
live expect-slot-state "$a_slot" ready

step "9. Operator release from ./flux runtime release"
./flux runtime release "$(value "$(live email-of C)" EMAIL)"
live expect-release C operator

step "9b. The Claude Code sign-in console (T4): each method, the URL, a pasted code, status only, sign-out, no secret anywhere"
out=$(live console-bind T); printf '%s\n' "$out"
t_slot=$(value "$out" SLOT); t_binding=$(value "$out" BINDING)
t_cid=$(cid "$t_slot")
seed_login() { # the fake credential and account the next sign-in writes (the CLI's home is emptied by each sign-out)
  docker exec -u "$(person_of "$t_binding")" "$t_cid" sh -c "umask 077; printf '%s' '$console_secret' > /data/$t_binding/claude/fake-secret; printf 'tara@example.org' > /data/$t_binding/claude/fake-account"
}
logins_running() { docker exec "$t_cid" ps -o args | grep -c '[a]uth login' || true; }
for method in claude_account console sso; do
  case "$method" in claude_account) expected='["auth","login"]' ;; console) expected='["auth","login","--console"]' ;; sso) expected='["auth","login","--sso"]' ;; esac
  seed_login
  out=$(live console-sign-in T "$method" "$console_code" "$console_secret"); printf '%s\n' "$out"
  [ "$(value "$out" ACCOUNT)" = 't***@example.org' ] || fail "$method: the masked account is not shown"
  docker exec "$t_cid" cat "/data/$t_binding/claude/fake-calls.jsonl" | python3 -c '
import json, sys
calls = [json.loads(line) for line in sys.stdin if line.strip()]
commands = [c["argv"] for c in calls if "event" not in c]
assert commands == [json.loads(sys.argv[1]), ["auth", "status"]], commands
login = next(c for c in calls if "event" not in c)
assert login["tty"] is True and login["env"]["TERM"] == "xterm-256color", login
assert not [n for n in login["envNames"] if "FLUX" in n or "SECRET" in n], login["envNames"]
assert next(c for c in calls if c.get("event") == "code")["code"].startswith(sys.argv[2] + "#")
print("ran exactly", commands[0], "in a terminal, then auth status")' "$expected" "$console_code"
  [ "$(logins_running)" = 0 ] || fail "$method: the login command still runs after it exited"
  docker exec "$t_cid" grep -q "$console_secret" "/data/$t_binding/claude/.credentials.json" || fail "control: the fake login is not in the slot"
  out=$(live console-sign-out T); printf '%s\n' "$out"
  [ "$(value "$out" SIGN_OUT_FAILED)" = false ] || fail "$method: the CLI's logout was not reported done"
  if docker exec "$t_cid" test -e "/data/$t_binding/claude/.credentials.json"; then fail "$method: sign-out left the login"; fi
done
live console-cross T U
out=$(live console-leave T); printf '%s\n' "$out"
[ "$(value "$out" RECOVERY)" = fresh-binding ] || fail "disconnect did not prove a fresh place"
# Recovery changes the binding. All following controls target the current one.
out=$(live console-bind T); printf '%s\n' "$out"
t_slot=$(value "$out" SLOT); t_binding=$(value "$out" BINDING); t_cid=$(cid "$t_slot")
[ "$(logins_running)" = 0 ] || fail "a login command still runs after its console was left"
live console-no-fields T
# A failed logout still deletes the login and tells the owner.
seed_login
live console-sign-in T claude_account "$console_code" "$console_secret" >/dev/null

step "9c. A run on the owner's own Claude Code (T5 #280): the real worker, the slot, the fake CLI reading Flux through runtime-egress's /mcp"
out=$(live runtime-run T); printf '%s\n' "$out"
docker exec "$t_cid" cat "/data/$t_binding/claude/fake-calls.jsonl" | python3 -c '
import json, sys
calls = [json.loads(line) for line in sys.stdin if line.strip()]
run = [c for c in calls if c.get("event") == "run"]
assert len(run) == 1, run
assert run[0]["authorization"] == "run_token", run[0]["authorization"]
assert "FLUX_RUN_TOKEN" in run[0]["envNames"]
assert not any(arg.startswith("eyJ") for arg in run[0]["argv"]), "the token is an argument"
listed = [c for c in calls if c.get("event") == "tools_list"]
assert listed and listed[0]["status"] == 200 and "flux_list_contexts" in listed[0]["tools"], listed
results = [c for c in calls if c.get("event") == "tool_result"]
assert results and all(r["status"] == 200 and not r["isError"] for r in results), results
print("the CLI got the run token only in FLUX_RUN_TOKEN, reached /mcp through runtime-egress and its call was answered")'
[ -z "$(docker exec "$t_cid" ls /tmp)" ] || fail "the run left files in the runtime's /tmp"
if docker exec "$t_cid" test -e "/data/$t_binding/claude/projects"; then fail "a transcript remains in the binding directory"; fi
docker exec -u "$(person_of "$t_binding")" "$t_cid" sh -c "rm -f /data/$t_binding/claude/fake-calls.jsonl"

step "9e. A run's own tools (#1437): from the sandbox shell, on the runtime's real networks, nothing but the egress (and with Landlock ABI 4 not even that)"
abi=$(docker exec "$t_cid" /opt/flux-runtime/sandbox/flux-sandbox abi)
# The tools need Landlock's network rules (ABI 4, Linux 6.7; coordinator decision on #1437): below that the runtime keeps them off.
[ "$abi" -ge 4 ] || fail "this host's Landlock (ABI $abi) cannot forbid TCP: the runtime keeps the CLIs' tools off (needs Linux 6.7, ABI 4)"
tcp_rule=1
compose --profile runtime logs --no-color runtime-1 | grep -q '"event":"ready".*"landlock":'"$abi" || fail "the runtime did not report Landlock ABI $abi at start"
python3 - "$here/scripts/agent-runtime/probe-sandbox-net.mjs" > "$work/sandbox-run.json" <<PY
import json, sys
probe = open(sys.argv[1]).read()
env = " ".join(f"{k}={v}" for k, v in {
  "FLUX_PROBE_TCP_RULE": "$tcp_rule", "FLUX_PROBE_DB": "$(ip_on "$(compose ps -q db)" default)",
  "FLUX_PROBE_API_DEFAULT": "$(ip_on "$(compose ps -q api)" default)", "FLUX_PROBE_API_RUNTIME": "$(ip_on "$(compose ps -q api)" runtime-api)",
  "FLUX_PROBE_API_CONTROL": "$(ip_on "$(compose ps -q api)" runtime-control)", "FLUX_PROBE_WORKER": "$(ip_on "$(compose ps -q worker)" default)",
  "FLUX_PROBE_MANAGER_CONTROL": "$(ip_on "$(cid runtime-manager)" runtime-control)", "FLUX_PROBE_GATEWAY": "${gateway:-}"}.items())
command = "cat > net.mjs <<'FLUXPROBE'\n" + probe + "FLUXPROBE\n" + env + " node net.mjs"
print(json.dumps({"calls": [{"name": "Bash", "args": {"command": command}}, {"name": "flux_list_contexts"}]}))
PY
docker exec -i -u "$(person_of "$t_binding")" "$t_cid" sh -c "cat > /data/$t_binding/claude/fake-run.json" < "$work/sandbox-run.json"
out=$(live sandbox-run T); printf '%s\n' "$out"
docker exec "$t_cid" cat "/data/$t_binding/claude/fake-calls.jsonl" | python3 -c '
import json, sys
calls = [json.loads(line) for line in sys.stdin if line.strip()]
own = [c for c in calls if c.get("event") == "own_tool"]
assert len(own) == 1 and own[0]["shell"] == "/opt/flux-runtime/sandbox/bin/bash", own
print(own[0]["output"])
assert "NETPROBE=ok" in own[0]["output"], own[0]["output"]
print("the run'"'"'s own shell reached nothing but what the sandbox and the egress allow")'
[ -z "$(docker exec "$t_cid" ls -A /scratch)" ] || fail "the run left its scratch"
docker exec -u "$(person_of "$t_binding")" "$t_cid" sh -c "rm -f /data/$t_binding/claude/fake-calls.jsonl /data/$t_binding/claude/fake-run.json"

step "9d. Codex (T6 #281): ChatGPT device sign-in through the console, then a run on the owner's own Codex (fake codex exec --json)"
out=$(live codex-sign-in T); printf '%s\n' "$out"
[ "$(value "$out" CODEX_SIGNED_IN)" = true ] || fail "the Codex device sign-in did not complete"
out=$(live codex-run T); printf '%s\n' "$out"
docker exec "$t_cid" cat "/data/$t_binding/codex/fake-calls.jsonl" | python3 -c '
import json, sys
calls = [json.loads(line) for line in sys.stdin if line.strip()]
run = [c for c in calls if c.get("event") == "run"]
assert len(run) == 1, run
assert run[0]["authorization"] == "run_token", run[0]["authorization"]
assert "FLUX_RUN_TOKEN" in run[0]["envNames"]
assert not any(arg.startswith("eyJ") for arg in run[0]["argv"]), "the token is an argument"
overrides = run[0]["overrides"]
assert overrides["features"]["shell_tool"] is False and overrides["web_search"] == "disabled", overrides
assert list(overrides["mcp_servers"]) == ["flux"] and overrides["mcp_servers"]["flux"]["required"] is True
methods = [c.get("method") for c in calls if c.get("event") == "app_server" and c.get("method") != "initialized"]
assert methods == ["initialize", "model/list", "initialize", "config/read", "initialize", "account/rateLimits/read"], methods
results = [c for c in calls if c.get("event") == "tool_result"]
assert results and all(r["status"] == 200 and not r["isError"] for r in results), results
print("Codex got the run token only in FLUX_RUN_TOKEN, every override, the preflight, and reached /mcp through runtime-egress")'
[ -z "$(docker exec "$t_cid" ls /tmp)" ] || fail "the Codex run left files in the runtime's /tmp"
if docker exec "$t_cid" test -e "/data/$t_binding/codex/sessions"; then fail "a Codex transcript remains in the binding directory"; fi

docker exec -u "$(person_of "$t_binding")" "$t_cid" sh -c "printf logout_fails > /data/$t_binding/claude/fake-scenario"
out=$(live console-sign-out T); printf '%s\n' "$out"
[ "$(value "$out" SIGN_OUT_FAILED)" = true ] || fail "a failed logout was not reported"
if docker exec "$t_cid" test -e "/data/$t_binding/claude/.credentials.json"; then fail "a failed logout left the login"; fi
# The console, its notices and a failed sign-in (a code starting fake-reject-) in a browser, at phone width and on a desktop (tests/ui/test_runtime_console.py).
if [ -n "${FLUX_RUNTIME_SCREENSHOT_DIR:-}" ]; then mkdir -p "$FLUX_RUNTIME_SCREENSHOT_DIR"; export FLUX_UI_SCREENSHOT_DIR="$FLUX_RUNTIME_SCREENSHOT_DIR"; fi
compose --profile ui build ui-test
compose --profile ui run --rm --no-deps -e FLUX_UI_RUNTIME=on -w /work/tests/ui ui-test python3 -m unittest -v test_runtime_console
# T's place is removed (sign out, delete), so the restore below sees the same people as before.
boot=$(value "$(live boot "$t_slot")" BOOT)
live remove T "$t_slot" "$boot" >/dev/null
live no-secret-in-db "$console_secret"

step "10. ./flux backup contains no runtime volume"
docker exec -u "$(person_of "$g_binding")" "$slot_cid" sh -c "umask 077; printf '{\"login\":\"$marker\"}' > /data/$g_binding/claude/.credentials.json"
# Control: the login marker is in the runtime's volume, so finding it in the archive would be a leak.
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
# After the backup, G removes their place and a new owner K gets one.
boot=$(value "$(live boot "$a_slot")" BOOT)
live remove G "$a_slot" "$boot" >/dev/null
out=$(live bind K)
k_binding=$(value "$out" BINDING)
./flux restore "$archive" -y
docker volume inspect "${project}_${a_slot}-data" >/dev/null || fail "restore removed the runtime's volume"
live expect-binding G sign_in_again
live expect-slot-state "$a_slot" ready
for _ in 1 2 3 4 5 6 7 8 9 10; do docker exec "$(cid "$a_slot")" test -e "/data/$k_binding" || break; sleep 1; done
if docker exec "$(cid "$a_slot")" test -e "/data/$k_binding"; then fail "K's directory (no binding after the restore) was not deleted"; fi
printf 'K binding %s released by the reconciliation; G must sign in again\n' "$k_binding"

step "12. Logs: no fake login marker, console login or typed code in any service log"
compose --profile runtime logs --no-color > "$work/logs.txt" 2>/dev/null
[ -s "$work/logs.txt" ] || fail "control: no logs were read"
for value in "$marker" "$console_secret" "$console_code" 'Paste code here' 'oauth/authorize'; do
  if grep -qF "$value" "$work/logs.txt"; then fail "a log holds $value"; fi
done
printf 'no login marker, console login, typed code or console output in the logs\n'

step "13. Switching off stops the runtime and keeps its volume"
env_set FLUX_AGENT_RUNTIME ''
./flux up
[ -z "$(runtime_containers)" ] || fail "runtime containers still exist after switching off: $(runtime_containers)"
docker volume inspect "${project}_runtime-1-data" >/dev/null || fail "switching off removed the runtime's volume"
live off

step "14. ./flux runtime purge signs out and deletes every login"
if ! ./flux runtime purge -y > "$work/purge.txt" 2>&1; then
  cat "$work/purge.txt"
  fail "off→purge failed"
fi
cat "$work/purge.txt"
grep -q 'signed out (claude_code ok, codex ok)' "$work/purge.txt" || fail "off→purge did not attempt sign-out successfully"
if grep -Ei 'sign-out NOT confirmed|Not every.*signed out|could not be signed out|cannot be signed out|Could not start.*sign out' "$work/purge.txt" >/dev/null; then
  fail "off→purge left a sign-out unconfirmed"
fi
[ -z "$(docker volume ls -q --filter "label=com.docker.compose.project=$project" | grep -E '_runtime-' || true)" ] || fail "purge left runtime volumes"
./flux runtime status | grep -q 'no binding' || true

step "15. ./flux reset signs out first and removes the runtime's volumes"
env_set FLUX_AGENT_RUNTIME claude_code,codex
./flux up
live wait-ready 1 >/dev/null
out=$(live bind M); m_slot=$(value "$out" SLOT); m_binding=$(value "$out" BINDING)
docker exec -u "$(person_of "$m_binding")" "$(cid "$m_slot")" sh -c "umask 077; printf '{}' > /data/$m_binding/claude/.credentials.json"
./flux reset -y | tee "$work/reset.txt"
grep -q "Signing out the agent runtime logins first" "$work/reset.txt" || fail "reset did not sign out first"
grep -q "$m_slot: signed out (claude_code ok" "$work/reset.txt" || fail "reset did not sign out M's login"
[ -z "$(docker volume ls -q --filter "label=com.docker.compose.project=$project" | grep -E '_runtime-' || true)" ] || fail "reset left runtime volumes"

printf '\nAgent runtime check passed.\n'
