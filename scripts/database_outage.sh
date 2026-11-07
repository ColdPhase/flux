# Sourced by scripts/check_database_outage.sh and scripts/check_application.sh after `$compose` is set (and FLUX_PORT exported).
# A short database outage must not stop the API or the worker (#889): a stopped PostgreSQL ends every connection with a 57P01
# `error` event, and an event with no listener is an uncaught exception that ends the process. The check stops the database,
# starts it again, and requires that the API answers its health check again and that no service restarted or exited.
# The services it watches are the ones of `$compose` that hold a database pool; `restart: unless-stopped` would hide a crash
# behind a quick restart, so it compares the start time and restart count of each container before and after.

outage_state() {
  docker inspect -f '{{ .State.StartedAt }} {{ .RestartCount }} {{ .State.Running }}' "$1"
}

check_database_outage() {
  outage_services="api worker"
  for service in $outage_services; do
    container=$($compose ps -q "$service")
    [ -n "$container" ] || { echo "database outage: $service is not running before the outage" >&2; return 1; }
    eval "outage_before_$service=\$(outage_state \$container)"
    eval "outage_container_$service=\$container"
  done
  $compose up -d --wait api worker
  echo "database outage: stopping the database" >&2
  $compose stop db
  # Long enough for every pool to have its connections ended and to notice the refusals of a database that is down.
  sleep 8
  for service in $outage_services; do
    eval "container=\$outage_container_$service"
    case "$(outage_state "$container")" in *" true") ;; *) echo "database outage: $service stopped while the database was down" >&2; return 1 ;; esac
  done
  echo "database outage: starting the database" >&2
  $compose start db
  $compose up -d --wait db
  deadline=$(( $(date +%s) + 90 ))
  until wget -q -O /dev/null -T 3 "http://127.0.0.1:${FLUX_PORT}/api/v1/health" 2>/dev/null || curl -fsS -o /dev/null -m 3 "http://127.0.0.1:${FLUX_PORT}/api/v1/health" 2>/dev/null; do
    if [ "$(date +%s)" -ge "$deadline" ]; then echo "database outage: the API did not answer its health check within 90 s of the database returning" >&2; return 1; fi
    sleep 1
  done
  # The worker has no health endpoint: give it the same time to open its connections again, then compare.
  sleep 5
  for service in $outage_services; do
    eval "container=\$outage_container_$service; before=\$outage_before_$service"
    after=$(outage_state "$container")
    if [ "$before" != "$after" ]; then
      echo "database outage: $service restarted or stopped (before: $before; after: $after)" >&2
      $compose logs --no-color --tail 40 "$service" >&2 || true
      return 1
    fi
  done
  if $compose logs --no-color api worker | grep -E "Unhandled 'error' event|uncaughtException|Uncaught" >/dev/null; then
    echo "database outage: a service logged an unhandled error" >&2
    return 1
  fi
  echo "database outage: api and worker kept running, and the API is healthy again" >&2
}
