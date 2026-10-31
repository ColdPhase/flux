#!/bin/sh
# Simulated public self-hosted install (#63, founder direction 2026-10-30): Flux behind the documented Caddy on
# 443, LiveKit TURN/TLS on 443 and TURN/UDP on 3478 at its own public address, a DNS server for both names, one CA
# the clients trust, and two client networks behind NAT routers (one lets only TCP/443 and DNS out). Real browsers
# on the clients reach only the public side; a driver on the simulated Internet drives the Flux web app through
# them. See docs/development/live-media.md#simulated-public-host-63-2026-10-30.
#
# FLUX_SIM_RUNS: space-separated runs of BROWSER_A:BROWSER_B:PHASES; A is behind the restrictive router, B behind
# the open one. BROWSER is chromium, firefox or webkit, optionally +pixel7, +iphone13 or +ipad (a device
# descriptor); BROWSER@turn-udp also lets TURN/UDP out of router A, BROWSER@ice-tcp the SFU's ICE/TCP port 7881. Phases: connect, ai-off, four (Mia and Tom join
# from clients C and D), profiles (the measured AC-2 profiles and their thresholds), screen (screen publication by
# browser A), text (the 1440p code/text profile: a 2560x1440 terminal shared as Sharp text, static then scrolling,
# readability scored by SSIM and OCR against the source pixels), drop, loss, weak, sfu-restart, sfu-update,
# api-restart, access, turn-tls-probe (what browser A sends to TURN/TLS, captured on router A). The default runs the two- and
# four-person profiles, the two- and four-person 1440p text profiles, every Chromium case, Firefox over TURN/TLS, WebKit over TURN/UDP and over ICE/TCP (its Linux build cannot
# speak TURN over TLS; see docs/development/live-media.md), screen publication in Firefox and WebKit, and phone rows
# with a network drop. FLUX_SIM_CALIBRATE=1 records the profile thresholds without enforcing them.
# FLUX_SIM_LIVEKIT_CANDIDATE is the image the sfu-update phase updates to before rolling back.
# FLUX_SIM_ARTIFACT_DIR keeps the results (default: under FLUX_SIM_WORK_DIR or TMPDIR); resources.jsonl has the
# SFU's, API's and proxy's CPU, memory and network every two seconds, and resources-summary.json per measured window.
# FLUX_SIM_HOLD=1 keeps the stack up before the runs. Heavy and local: one simulation at a time (its subnets are
# fixed).
set -eu

cd "$(dirname "$0")/.."
project="flux-public-sim-$(date +%s)-$$"
work=$(mktemp -d "${FLUX_SIM_WORK_DIR:-${TMPDIR:-/tmp}}/flux-public-sim.XXXXXX")
artifacts=${FLUX_SIM_ARTIFACT_DIR:-$work/artifacts}
mkdir -p "$artifacts" "$work/certs" "$work/ca" "$work/ctl"
chmod 755 "$work" "$work/certs" "$work/ca"
chmod 777 "$work/ctl"
# Server certificates and keys for the proxy and the SFU; the clients and the driver get only the CA certificate.
export FLUX_SIM_CERT_DIR="$work/certs" FLUX_SIM_CA_DIR="$work/ca" FLUX_SIM_CTL_DIR="$work/ctl"
export POSTGRES_USER=flux POSTGRES_DB=flux
export POSTGRES_PASSWORD="flux-sim-$$-$(od -An -N8 -tx1 /dev/urandom | tr -d ' \n')"
export FLUX_FIXTURE_TOKEN="flux-sim-fixture-$$-$(od -An -N8 -tx1 /dev/urandom | tr -d ' \n')"
export FLUX_AUTH_SECRET="auth-sim-$$-$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')"
export FLUX_PORT="${FLUX_SIM_API_PORT:-35210}"
export FLUX_PUBLIC_ORIGIN=https://flux.sim.test
export FLUX_TRUSTED_PROXIES=10.213.0.10/32
export FLUX_IMAGE_TAG="$project"
export FLUX_LIVEKIT_API_KEY=fluxsimkey
export FLUX_LIVEKIT_API_SECRET="fluxsimsecret-$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')"
export FLUX_LIVEKIT_PUBLIC_IP=203.0.113.20
export FLUX_LIVEKIT_DOMAIN=turn.sim.test
export FLUX_LIVEKIT_TURN_DOMAIN=turn.sim.test
export FLUX_LIVEKIT_MEDIA_CIDR=203.0.113.20/32
export FLUX_LIVEKIT_TURN_CERT_DIR="$work/certs/turn"
export FLUX_VAPID_PUBLIC_KEY='' FLUX_VAPID_PRIVATE_KEY='' FLUX_VAPID_SUBJECT=''
candidate=${FLUX_SIM_LIVEKIT_CANDIDATE:-livekit/livekit-server:v1.13.11@sha256:25cd902de7cacbd5f1f779f6a6ac1eae20ba8f56b0935934ce6b0ab80d1e3d20}
runs=${FLUX_SIM_RUNS:-"chromium:chromium:connect,profiles chromium:chromium:connect,four,profiles chromium:chromium:connect,text chromium:chromium:connect,four,text chromium:chromium:connect,ai-off,drop,loss,weak,access chromium:chromium:connect,sfu-update chromium:chromium:connect,sfu-restart chromium:chromium:connect,api-restart firefox:chromium:connect,drop,access chromium:firefox:connect,drop,access chromium:webkit:connect,drop,access webkit@turn-udp:chromium:connect,drop webkit@ice-tcp:chromium:connect,drop firefox:chromium:connect,screen webkit@turn-udp:chromium:connect,screen chromium+pixel7:chromium:connect,drop webkit+iphone13@turn-udp:chromium:connect,drop chromium:webkit+ipad:connect,access webkit:chromium:turn-tls-probe"}
printf 'Public simulation %s, results in %s\n' "$project" "$artifacts"

compose="docker compose -p $project -f docker/compose.source.yaml -f docker/compose.live.yaml -f docker/compose.live.turn.yaml -f docker/public-sim/compose.yaml"
cleanup() {
  status=$?
  if [ -n "${ctl_pid:-}" ]; then kill "$ctl_pid" 2>/dev/null || true; fi
  if [ -n "${sampler_pid:-}" ]; then kill "$sampler_pid" 2>/dev/null || true; fi
  if [ "$status" -ne 0 ]; then
    $compose logs --no-color --tail=200 api proxy router-a router-b dns > "$artifacts/compose-logs.txt" 2>&1 || true
    $compose logs --no-color livekit > "$artifacts/livekit.log" 2>&1 || true
  fi
  cp "$work"/ctl/*.json "$work"/ctl/*.png "$artifacts"/ 2>/dev/null || true
  [ ! -f "$artifacts/resources.jsonl" ] || python3 -I docker/public-sim/resources.py "$artifacts/resources.jsonl" > "$artifacts/resources-summary.json" 2>&1 || true
  $compose --profile sim-driver down -v --remove-orphans >/dev/null 2>&1 || true
  docker image rm "flux-foundation:$project" "flux-public-sim-infra:$project" "flux-public-sim-client:$project" >/dev/null 2>&1 || true
  docker run --rm -v "$work:/work:z" alpine:3.21 rm -rf /work/certs /work/ca /work/ctl >/dev/null 2>&1 || true
  rm -rf "$work/certs" "$work/ca" "$work/ctl"
  exit "$status"
}
trap cleanup EXIT HUP INT TERM

$compose build migrate dns client-a
# One local CA signs the Flux and the TURN name; the clients install only its certificate.
# FLUX_SIM_TURN_IP_SAN=1 (diagnostic only) also names the media address in the TURN certificate, which a publicly
# issued certificate for a DNS name does not do.
docker run --rm --network none -e "TURN_IP_SAN=${FLUX_SIM_TURN_IP_SAN:+,IP:203.0.113.20}" -v "$work/certs:/certs:z" "flux-public-sim-infra:$project" sh -ec '
  cd /certs
  openssl req -x509 -newkey rsa:2048 -nodes -days 2 -subj "/CN=Flux simulation CA" -keyout ca.key -out ca.crt 2>/dev/null
  for name in flux.sim.test turn.sim.test; do
    san=; [ "$name" = turn.sim.test ] && san=$TURN_IP_SAN
    printf "subjectAltName=DNS:%s%s\nbasicConstraints=critical,CA:FALSE\nextendedKeyUsage=serverAuth\nkeyUsage=digitalSignature,keyEncipherment\n" "$name" "$san" > "$name.ext"
    openssl req -newkey rsa:2048 -nodes -subj "/CN=$name" -keyout "$name.key" -out "$name.csr" 2>/dev/null
    openssl x509 -req -in "$name.csr" -CA ca.crt -CAkey ca.key -CAcreateserial -days 2 -extfile "$name.ext" -out "$name.crt" 2>/dev/null
  done
  mkdir turn && cat turn.sim.test.crt > turn/fullchain.pem && cp turn.sim.test.key turn/privkey.pem
  rm ca.key ./*.csr ./*.ext && chmod 644 ./*.crt ./*.key turn/*'
cp "$work/certs/ca.crt" "$work/ca/ca.crt"
$compose up -d db migrate
$compose --profile setup run --rm files-init
$compose up -d --wait api worker livekit dns proxy router-a router-b client-a client-b client-c client-d
$compose config --services > "$artifacts/services.txt"
if grep -E -q 'egress|ingress|agent' "$artifacts/services.txt"; then echo 'unexpected media processor in the stack' >&2; exit 1; fi

# Executes the driver's requests (router impairments, restarts), nothing else.
(
  while :; do
    for request in "$work"/ctl/req-*; do
      case "$request" in *.tmp|*'*') continue ;; esac
      [ -f "$request" ] || continue
      name=${request##*/req-}
      command=$(cat "$request")
      rm -f "$request"
      case "$command" in
        "drop a on"|"drop a off") out=$($compose exec -T router-a /bin/sh /impair.sh drop "${command##* }" 2>&1) ;;
        "netem a off"|"netem b off") side=$(printf '%s' "$command" | cut -d' ' -f2); out=$($compose exec -T "router-$side" /bin/sh /impair.sh netem off 2>&1) ;;
        "netem a "*|"netem b "*) side=$(printf '%s' "$command" | cut -d' ' -f2); out=$($compose exec -T "router-$side" /bin/sh /impair.sh netem ${command#netem ? } 2>&1) ;; # shellcheck disable=SC2086
        "restart livekit") out=$($compose restart livekit 2>&1) ;;
        "restart api") out=$($compose restart api 2>&1; $compose up -d --wait api 2>&1) ;;
        # The documented SFU upgrade: a new pinned image, then back to the previous digest.
        "update livekit") printf 'services:\n  livekit:\n    image: %s\n' "$candidate" > "$work/livekit-candidate.yaml"
          out=$($compose -f "$work/livekit-candidate.yaml" up -d --wait --no-deps livekit 2>&1
            docker inspect --format '{{.Config.Image}}' "$($compose ps -q livekit)") ;;
        "rollback livekit") out=$($compose up -d --wait --no-deps livekit 2>&1
            docker inspect --format '{{.Config.Image}}' "$($compose ps -q livekit)") ;;
        "screen a on "*|"screen c on "*) side=$(printf '%s' "$command" | cut -d' ' -f2); out=$($compose exec -T "client-$side" screen-source on "${command#screen ? on }" 2>&1) ;;
        # The 1440p text profile on client A: display size, the terminal text, and a grab of the source pixels.
        "screen a size "*) out=$($compose exec -T client-a screen-source size "${command#screen a size }" 2>&1) || out="failed: $out" ;;
        "screen a text "*) out=$($compose exec -T client-a screen-source text ${command#screen a text } 2>&1) || out="failed: $out" ;; # shellcheck disable=SC2086
        "screen a grab "*) out=$($compose exec -T client-a screen-source grab "/ctl/${command#screen a grab }.png" 2>&1) || out="failed: $out" ;;
        "screen a off"|"screen c off") side=$(printf '%s' "$command" | cut -d' ' -f2); out=$($compose exec -T "client-$side" screen-source off 2>&1) ;;
        "netem-host b 10.213.2.11 off") out=$($compose exec -T router-b /bin/sh /impair.sh netem-host 10.213.2.11 off 2>&1) ;;
        "netem-host b 10.213.2.11 "*) out=$($compose exec -T router-b /bin/sh /impair.sh netem-host 10.213.2.11 ${command#netem-host b 10.213.2.11 } 2>&1) ;; # shellcheck disable=SC2086
        # The person presses Yes in WebKit's own screen-sharing prompt on client A (allow-display.sh).
        "allow-display a") out=$($compose exec -T client-a allow-display 2>&1) || out="allow-display failed: $out" ;;
        "counters a") out=$($compose exec -T router-a /bin/sh /impair.sh counters 2>&1) ;;
        "sniff a") out=$($compose exec -T router-a /bin/sh /impair.sh sniff 2>&1) ;;
        "mark "*) printf '{"t": %s, "mark": "%s"}\n' "$(date +%s.%N)" "${command#mark }" >> "$artifacts/resources.jsonl"; out=marked ;;
        *) out="refused: $command" ;;
      esac
      printf '%s\n' "$out" > "$work/ctl/done-$name"
    done
    sleep 0.1
  done
) &
ctl_pid=$!
# CPU, memory and cumulative network bytes of the SFU, API and proxy every two seconds (docker stats), with the
# driver's window marks in the same file; summarized per window at the end.
(
  ids="$($compose ps -q livekit) $($compose ps -q api) $($compose ps -q proxy)"
  while :; do
    case " $($compose ps -q livekit) " in *" ${ids%% *} "*) ;; *) ids="$($compose ps -q livekit) $($compose ps -q api) $($compose ps -q proxy)" ;; esac
    # shellcheck disable=SC2086
    docker stats --no-stream --format '{{json .}}' $ids 2>/dev/null | sed "s/^/{\"t\": $(date +%s.%N), \"s\": /; s/\$/}/" >> "$artifacts/resources.jsonl"
    sleep 2
  done
) &
sampler_pid=$!

# From the simulated Internet: names, TLS chain and hostnames, the proxy, and the TURN/TLS listener.
$compose --profile sim-driver run --rm --entrypoint sh driver -ec '
  printf "nameserver 203.0.113.53\n" > /etc/resolv.conf
  getent hosts flux.sim.test turn.sim.test
  curl -fsS --cacert /certs/ca.crt https://flux.sim.test/api/v1/health
  echo | openssl s_client -connect turn.sim.test:443 -servername turn.sim.test -verify_hostname turn.sim.test -verify_return_error -CAfile /certs/ca.crt -brief 2>&1 | grep -E "Verification|Protocol"' > "$artifacts/public-side.txt" 2>&1
cat "$artifacts/public-side.txt"
# Client A reaches only 443 and DNS; client B reaches anything public; neither reaches the API or database directly.
$compose exec -T client-a sh -ec '
  curl -fsS -o /dev/null -w "client-a https %{http_code}\n" https://flux.sim.test/
  if timeout 3 bash -c "echo > /dev/tcp/203.0.113.20/7881" 2>/dev/null; then echo "client-a reached ICE/TCP 7881"; exit 1; fi
  if getent hosts api db >/dev/null; then echo "client-a resolves internal names"; exit 1; fi
  echo "client-a: ICE/TCP 7881 blocked, no internal names"' | tee -a "$artifacts/public-side.txt"
$compose exec -T client-b sh -ec '
  timeout 3 bash -c "echo > /dev/tcp/203.0.113.20/7881" && echo "client-b: ICE/TCP 7881 reachable"
  if timeout 3 bash -c "echo > /dev/tcp/10.213.0.10/443" 2>/dev/null; then echo "client-b reached the proxy network"; exit 1; fi
  echo "client-b: proxy network unreachable"' | tee -a "$artifacts/public-side.txt"

# FLUX_SIM_HOLD=1 keeps the simulation up for inspection until $work/hold is removed.
if [ "${FLUX_SIM_HOLD:-0}" = 1 ]; then
  touch "$work/hold"; printf 'Holding: %s; remove %s/hold to continue\n' "$compose" "$work"
  while [ -e "$work/hold" ]; do sleep 2; done
fi
failed=
for run in $runs; do
  a=${run%%:*} rest=${run#*:}; b=${rest%%:*} phases=${rest#*:}
  # BROWSER@turn-udp: router A also lets TURN/UDP to the media host out for this run; BROWSER@ice-tcp lets the
  # SFU's ICE/TCP port out instead (UDP still blocked, no TLS).
  path=; case "$a" in *@turn-udp) path=turn-udp; a=${a%@turn-udp} ;; *@ice-tcp) path=ice-tcp; a=${a%@ice-tcp} ;; esac
  log="$artifacts/driver-$a${path:+-$path}-$b-$(printf '%s' "$phases" | tr ',' '-').log"
  # The same run twice keeps both logs.
  n=2; while [ -e "$log" ]; do log="${log%.log}"; log="${log%-run[0-9]*}-run$n.log"; n=$((n + 1)); done
  printf '== run %s behind the restrictive router%s, %s behind the open one: %s\n' "$a" "${path:+ ($path allowed)}" "$b" "$phases"
  [ -z "$path" ] || $compose exec -T router-a /bin/sh /impair.sh "$path" on
  since=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  relay=; case "$path" in turn-udp) relay=udp ;; ice-tcp) relay=ice-tcp ;; esac
  FLUX_SIM_A_RELAY=$relay FLUX_SIM_BROWSER_A=$a FLUX_SIM_BROWSER_B=$b FLUX_SIM_PHASES=$phases \
    $compose --profile sim-driver run --rm driver 2>&1 | tee "$log"
  [ -z "$path" ] || $compose exec -T router-a /bin/sh /impair.sh "$path" off
  $compose logs --no-color --since "$since" livekit > "${log%.log}.livekit.txt" 2>&1 || true
  # The SFU's side of a TURN/TLS probe: why a handshake failed, as its TURN server logged it.
  case "$phases" in *turn-tls-probe*) grep -m1 -o 'TLS handshake failed: .*' "${log%.log}.livekit.txt" || echo 'no failed TURN/TLS handshake logged' ;; esac
  for side in a b; do
    $compose exec -T "router-$side" /bin/sh /impair.sh counters > "${log%.log}.router-$side.txt" 2>&1 || true
  done
  # tee hides the driver's status; its last line says whether it finished. Later runs still run.
  grep -q '"kind": "done"' "$log" || failed="$failed $run"
done
if [ -n "$failed" ]; then printf 'Failed runs:%s\n' "$failed" >&2; exit 1; fi
printf 'Public simulation passed; results in %s\n' "$artifacts"
