# AC-7 of F-030 (#655), the stolen-disk part; sourced by scripts/check_encryption.sh after the run, with $compose,
# $project and $scan_dir set. The test wrote every encoding of workspace A's canaries (raw, JSON-escaped, hex,
# SHA-256 hex, base64 in both alphabets at all three offsets) and a prefix of each of B's; AC-4's secret encodings
# (keys and passwords) are added.
#   1. pg_dump of the whole database (the pg-boss schema included; plain SQL, so TOASTed values are decompressed):
#      no encoding of A, every B prefix (positive control).
#   2. The whole stack stops. The raw PostgreSQL volume (pg_wal included) and the files volume: no encoding of A; the
#      volume scan finds B's uncompressed canaries (positive control).
#   3. The writable layer of every container (`docker diff` names the changed paths, `docker cp` provides them): no
#      encoding of A.
#   4. Every container's log and the whole PostgreSQL log: no encoding of A.

$compose run --rm --no-deps -T test cat /state/encryption-canaries-A.txt > "$scan_dir/canaries-a"
$compose run --rm --no-deps -T test cat /state/encryption-canaries-B.txt > "$scan_dir/canaries-b"
$compose run --rm --no-deps -T test cat /state/encryption-canaries-B-pgdata.txt > "$scan_dir/canaries-b-pgdata"
$compose run --rm --no-deps -T test cat /state/encryption-canaries-B-files.txt > "$scan_dir/canaries-b-files"
# The keys and passwords of the run (AC-4's list: DEK, subkeys, KEK, holder keys, boot key, passwords, recovery code)
# are canaries of the disk too.
cat "$scan_dir/secrets" >> "$scan_dir/canaries-a"
[ "$(grep -c . "$scan_dir/canaries-a")" -ge 100 ] || { echo "too few encodings of A's canaries ($(grep -c . "$scan_dir/canaries-a"))" >&2; exit 1; }
[ "$(grep -c . "$scan_dir/canaries-b")" -ge 20 ] || { echo "too few canaries of B" >&2; exit 1; }
hit() { # label file
  if grep -aqiF -f "$scan_dir/canaries-a" "$2"; then
    echo "AC-7: A's canary found in $1: $(grep -aoiF -f "$scan_dir/canaries-a" "$2" | head -3 | cut -c1-40 | paste -sd' ' -)" >&2
    exit 1
  fi
}

# 1. pg_dump.
$compose exec -T db pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --no-owner > "$scan_dir/dump.sql"
grep -q 'CREATE SCHEMA pgboss' "$scan_dir/dump.sql" || { echo 'the dump lacks the pg-boss schema' >&2; exit 1; }
hit 'the pg_dump' "$scan_dir/dump.sql"
missing=$(while read -r control; do grep -qF -- "$control" "$scan_dir/dump.sql" || echo "$control"; done < "$scan_dir/canaries-b")
[ -z "$missing" ] || { echo "positive control: B's canaries missing from the dump: $missing" >&2; exit 1; }

# 4 (logs first, while the containers still exist, and before anything else logs).
$compose logs --no-color > "$scan_dir/all.log" 2>&1
hit 'a container log' "$scan_dir/all.log"

# 2. The stack stops; the raw volumes are read by a throwaway container of the database image.
db_image=$(docker inspect -f '{{.Config.Image}}' "$($compose ps -aq db)")
$compose stop
# The test's own state volume holds the canary lists; the scanned volumes are the database's and the files'.
# SELinux hosts label each volume for its own container, so the scanner runs unlabelled; the patterns come on stdin.
scan_volume() { # volume patterns
  docker run --rm -i --network none --security-opt label=disable -v "$1:/scan:ro" --entrypoint sh "$db_image" \
    -c 'grep -raiF -f - -l /scan > /tmp/hits; status=$?; head -5 /tmp/hits; [ "$status" -le 1 ] || echo SCAN-ERROR' < "$2"
}
for name in pgdata files; do
  volume="${project}_$name"
  docker volume inspect "$volume" > /dev/null || { echo "no volume $volume to scan" >&2; exit 1; }
  scan_volume "$volume" "$scan_dir/canaries-a" > "$scan_dir/volume.hits"
  ! grep -q SCAN-ERROR "$scan_dir/volume.hits" || { echo "the scan of volume $volume failed" >&2; exit 1; }
  [ ! -s "$scan_dir/volume.hits" ] || { echo "AC-7: A's canary found in volume $volume: $(cat "$scan_dir/volume.hits")" >&2; exit 1; }
  # Per-string positive controls: every one must be found in this volume, not any one.
  while read -r control; do
    printf '%s\n' "$control" > "$scan_dir/control"
    scan_volume "$volume" "$scan_dir/control" > "$scan_dir/volume-b"
    ! grep -q SCAN-ERROR "$scan_dir/volume-b" || { echo "the scan of volume $volume failed" >&2; exit 1; }
    [ -s "$scan_dir/volume-b" ] || { echo "positive control: B's $control is not in volume $volume" >&2; exit 1; }
  done < "$scan_dir/canaries-b-$name"
done
volumes="${project}_pgdata (pg_wal included) and ${project}_files"

# 3. Writable layers.
layers=0
for container in $($compose ps -aq); do
  for path in $(docker diff "$container" | awk '$1 != "D" { print $2 }'); do
    docker cp "$container:$path" - 2>/dev/null > "$scan_dir/layer.tar" || continue
    hit "the writable layer of $(docker inspect -f '{{.Name}}' "$container") ($path)" "$scan_dir/layer.tar"
    layers=$((layers + 1))
  done
done
[ "$layers" -gt 0 ] || { echo "no changed path in any container layer was scanned" >&2; exit 1; }
echo "AC-7 disk scan (case-insensitive): $(grep -c . "$scan_dir/canaries-a") encodings of A, pg_dump $(wc -c < "$scan_dir/dump.sql") bytes, volumes: $volumes, $layers changed paths in container layers, $(wc -l < "$scan_dir/all.log") log lines, 0 hits; each of B's $(grep -c . "$scan_dir/canaries-b") controls in the dump, $(grep -c . "$scan_dir/canaries-b-pgdata") in the PostgreSQL volume and $(grep -c . "$scan_dir/canaries-b-files") in the files volume"
