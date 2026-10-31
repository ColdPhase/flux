#!/usr/bin/env bash
# Build, compare and squash Flux database migration sets in throwaway PostgreSQL containers (#779).
#
#   scripts/db_baseline.sh diff     <source-A> <source-B> [out-dir]
#   scripts/db_baseline.sh generate <source>   <out.sql>
#
# A <source> is a migrations directory, or git:<ref> for app/packages/db/migrations at that ref.
# Each source is applied the way tooling/migrate.ts applies it: every NNNN_name.sql in version
# order, each file in its own transaction that also records its version in flux_schema_version.
# Other entries (such as reverse/) are ignored, as the migrator ignores them.
#
# diff  exits 0 when both sources produce the same database: pg_dump --schema-only (owners,
#       privileges, comments, functions, triggers, policies) and every row of every table, sorted,
#       plus sequence positions. Column values whose default is now()-like are masked, since the
#       two runs happen at different times; the masked columns are listed in the report. The
#       ledger (flux_schema_version) is reported, not compared: a squash changes it on purpose.
# generate writes one migration that recreates the source's final database: pg_dump pre-data,
#       then the reference rows the migrations seeded (without now()-like columns, which take
#       their defaults at install time), sequence positions, then post-data (indexes,
#       constraints, triggers). It runs through tooling/migrate.ts: no psql meta-commands, no
#       COPY FROM stdin, and every setting is transaction-local.
#
# Only Docker is used. Containers run without a network and are removed on exit.
set -euo pipefail

here=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd -P)
# The image docker/compose.yaml runs (postgres 18.6-alpine).
image=${FLUX_BASELINE_PG_IMAGE:-postgres@sha256:77f585114c32fbca283dc835b0596f4e52b51b4c6662d7810b2f4084f60a1873}
work=$(mktemp -d "${TMPDIR:-/tmp}/flux-db-baseline.XXXXXX")
containers=()
cleanup() {
  for c in "${containers[@]}"; do docker rm -f "$c" >/dev/null 2>&1 || true; done
  rm -rf "$work"
}
trap cleanup EXIT

die() { echo "db_baseline: $*" >&2; exit 2; }

# Resolve a source into a local directory of migration files.
resolve() {
  local source=$1 dir
  if [[ $source == git:* ]]; then
    dir="$work/src-$(printf '%s' "$source" | tr -c 'A-Za-z0-9' '_')"
    mkdir -p "$dir"
    git -C "$here" archive "${source#git:}" app/packages/db/migrations | tar -x -C "$dir"
    printf '%s/app/packages/db/migrations' "$dir"
  else
    [ -d "$source" ] || die "no such migrations directory: $source"
    (cd "$source" && pwd -P)
  fi
}

# Start PostgreSQL with the migrations mounted read-only and wait for it.
start() {
  local name=$1 dir=$2
  docker run -d --rm --name "$name" --network none \
    -e POSTGRES_USER=flux -e POSTGRES_PASSWORD=baseline -e POSTGRES_DB=flux \
    -v "$dir":/migrations:ro,z "$image" >/dev/null
  containers+=("$name")
  for _ in $(seq 1 60); do
    # The entrypoint restarts the server once after init; wait for the final one.
    if docker exec "$name" psql -X -q -U flux -d flux -h 127.0.0.1 -c 'SELECT 1' >/dev/null 2>&1; then return 0; fi
    sleep 1
  done
  die "PostgreSQL in $name did not start"
}

psql_in() { local name=$1; shift; docker exec "$name" psql -X -q -v ON_ERROR_STOP=1 -U flux -d flux -h 127.0.0.1 "$@"; }

apply() {
  local name=$1 dir=$2 count=0 file version
  while IFS= read -r file; do
    version=$((10#${file:0:4}))
    if ! psql_in "$name" -1 -f "/migrations/$file" \
      -c "INSERT INTO flux_schema_version(version) VALUES ($version) ON CONFLICT DO NOTHING" >/dev/null 2>"$work/apply.err"; then
      cat "$work/apply.err" >&2
      die "$file failed in $name"
    fi
    count=$((count + 1))
  done < <(ls "$dir" | grep -E '^[0-9]{4}_[a-z0-9_]+\.sql$' | sort)
  [ "$count" -gt 0 ] || die "no migration files in $dir"
  echo "$count"
}

# Every user table except the ledger, as schema.table.
tables() {
  psql_in "$1" -At -c "SELECT format('%I.%I', n.nspname, c.relname) FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relkind IN ('r','p') AND n.nspname NOT IN ('pg_catalog','information_schema')
      AND n.nspname NOT LIKE 'pg_toast%' AND NOT (n.nspname = 'public' AND c.relname = 'flux_schema_version')
    ORDER BY 1"
}

# Columns of a table whose default is a clock reading: their values depend on when the SQL ran.
clock_columns() {
  psql_in "$1" -At -c "SELECT a.attname FROM pg_attribute a JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
    WHERE a.attrelid = '$2'::regclass AND a.attnum > 0 AND NOT a.attisdropped
      AND pg_get_expr(d.adbin, d.adrelid) ~* '^(now\(\)|CURRENT_TIMESTAMP|LOCALTIMESTAMP|CURRENT_DATE|clock_timestamp\(\)|statement_timestamp\(\)|transaction_timestamp\(\))'
    ORDER BY a.attnum"
}

snapshot() {
  local name=$1 out=$2 table masked rows
  docker exec "$name" pg_dump -U flux -h 127.0.0.1 -d flux --schema-only | grep -Ev '^\\(un)?restrict ' >"$out.schema.sql"
  : >"$out.rows.txt"
  while IFS= read -r table; do
    masked=$(clock_columns "$name" "$table" | paste -sd, -)
    rows=$(psql_in "$name" -At -c "SELECT (to_jsonb(t) - '{${masked}}'::text[])::text FROM $table t ORDER BY 1")
    # Masked columns are named only where rows exist, so the report lists what was actually hidden.
    printf '== %s%s\n' "$table" "${rows:+${masked:+ (masked: $masked)}}" >>"$out.rows.txt"
    [ -z "$rows" ] || printf '%s\n' "$rows" >>"$out.rows.txt"
  done < <(tables "$name")
  printf '== sequences\n' >>"$out.rows.txt"
  psql_in "$name" -At -c "SELECT format('%I.%I last_value=%s', schemaname, sequencename, coalesce(last_value::text, 'unused')) FROM pg_sequences ORDER BY 1" >>"$out.rows.txt"
  psql_in "$name" -At -c "SELECT string_agg(version::text, ',' ORDER BY version) FROM flux_schema_version" >"$out.ledger.txt"
}

changed() { grep -c '^[-+][^-+]' "$1" || true; }

# Exit 0 when B is the same database as A. The strict comparison is the pg_dump text. PostgreSQL
# stores `x BETWEEN 1 AND 3 AND y` as a nested AND but prints it flat, so a database restored from
# any dump (pg_restore included) reprints those CHECKs with fewer parentheses. That reprint alone
# is accepted only when (1) A restored from its own pg_dump is strictly identical to B, and (2) the
# strict A/B difference disappears when parentheses are ignored.
cmd_diff() {
  [ $# -ge 2 ] || die "usage: diff <source-A> <source-B> [out-dir]"
  local a b out=${3:-$work/out} n status=0 pid=$$
  a=$(resolve "$1"); b=$(resolve "$2")
  mkdir -p "$out"
  start "flux-db-baseline-$pid-a" "$a"; start "flux-db-baseline-$pid-b" "$b"
  n=$(apply "flux-db-baseline-$pid-a" "$a"); echo "A: applied $n migration files from $1"
  n=$(apply "flux-db-baseline-$pid-b" "$b"); echo "B: applied $n migration files from $2"
  snapshot "flux-db-baseline-$pid-a" "$out/a"; snapshot "flux-db-baseline-$pid-b" "$out/b"
  echo "A ledger: $(cat "$out/a.ledger.txt")"
  echo "B ledger: $(cat "$out/b.ledger.txt")"
  echo "Schema: $(grep -c . "$out/a.schema.sql") vs $(grep -c . "$out/b.schema.sql") lines; rows: $(grep -vc '^== ' "$out/a.rows.txt") vs $(grep -vc '^== ' "$out/b.rows.txt") in $(grep -c '^== ' "$out/a.rows.txt") tables"
  grep -h 'masked:' "$out/a.rows.txt" | sed 's/^== /Masked clock columns: /' || true
  if diff -u "$out/a.rows.txt" "$out/b.rows.txt" >"$out/rows.diff"; then echo "rows: identical"; else echo "rows: DIFFERENT ($(changed "$out/rows.diff") lines, $out/rows.diff)"; status=1; fi
  if diff -u "$out/a.schema.sql" "$out/b.schema.sql" >"$out/schema.diff"; then
    echo "schema: identical"
  else
    echo "schema: $(changed "$out/schema.diff") lines differ in text ($out/schema.diff)"
    start "flux-db-baseline-$pid-r" "$a"
    docker exec "flux-db-baseline-$pid-a" pg_dump -U flux -h 127.0.0.1 -d flux |
      docker exec -i "flux-db-baseline-$pid-r" psql -X -q -v ON_ERROR_STOP=1 -U flux -d flux -h 127.0.0.1 >/dev/null
    snapshot "flux-db-baseline-$pid-r" "$out/a-restored"
    if diff -u "$out/a-restored.schema.sql" "$out/b.schema.sql" >"$out/schema-restored.diff" &&
       diff -u <(tr -d '()' <"$out/a.schema.sql") <(tr -d '()' <"$out/b.schema.sql") >/dev/null; then
      echo "schema: equivalent (A restored from its own pg_dump is identical to B; the text lines differ only in parentheses, PostgreSQL's reprint of nested AND)"
    else
      echo "schema: DIFFERENT (A restored from its pg_dump vs B: $(changed "$out/schema-restored.diff") lines, $out/schema-restored.diff)"; status=1
    fi
  fi
  if [ $status -ne 0 ] && [ -z "${3:-}" ]; then head -n 80 "$out/schema-restored.diff" "$out/rows.diff" >&2 2>/dev/null || true; fi
  return $status
}

cmd_generate() {
  [ $# -eq 2 ] || die "usage: generate <source> <out.sql>"
  local src target=$2 name="flux-db-baseline-$$-g" table cols values masked identity n
  src=$(resolve "$1")
  start "$name" "$src"
  n=$(apply "$name" "$src")
  # Statements that change session state become transaction-local, so the migrator's own ledger
  # write in the same transaction (and its connection afterwards) sees the normal search_path.
  localize() {
    grep -Ev '^\\(un)?restrict |^-- Dumped (from|by) ' |
      sed -E "s/^SELECT pg_catalog\.set_config\('search_path', '', false\);$/SET LOCAL search_path = '';/; s/^SET ([a-z_]+) = /SET LOCAL \1 = /"
  }
  {
    printf -- '-- Flux v0.1 schema baseline (#779): the complete database of a fresh install.\n'
    printf -- '-- Generated by scripts/db_baseline.sh from %s numbered migrations (%s); edit only by regenerating.\n' "$n" "$1"
    printf -- '-- Later schema changes are new numbered files after this one.\n\n'
    docker exec "$name" pg_dump -U flux -h 127.0.0.1 -d flux --no-owner --no-privileges --section=pre-data | localize
    printf '\n--\n-- Reference rows\n--\n\n'
    while IFS= read -r table; do
      [ "$(psql_in "$name" -At -c "SELECT EXISTS (SELECT 1 FROM $table)")" = t ] || continue
      masked=$(clock_columns "$name" "$table" | paste -sd'|' -)
      cols=$(psql_in "$name" -At -c "SELECT string_agg(quote_ident(attname), ', ' ORDER BY attnum) FROM pg_attribute
        WHERE attrelid = '$table'::regclass AND attnum > 0 AND NOT attisdropped AND attgenerated = ''
          AND ('${masked}' = '' OR attname !~ '^(${masked})\$')")
      identity=$(psql_in "$name" -At -c "SELECT CASE WHEN bool_or(attidentity = 'a') THEN ' OVERRIDING SYSTEM VALUE' ELSE '' END
        FROM pg_attribute WHERE attrelid = '$table'::regclass AND attnum > 0 AND NOT attisdropped")
      printf 'INSERT INTO %s (%s)%s VALUES\n' "$table" "$cols" "$identity"
      values=$(printf '%s' "$cols" | sed -E 's/([^, ]+)/quote_nullable(\1::text)/g')
      psql_in "$name" -At -c "SELECT string_agg('  (' || concat_ws(', ', $values) || ')', E',\n' ORDER BY r::text) FROM (SELECT $cols FROM $table) r"
      printf ';\n\n'
    done < <(tables "$name")
    psql_in "$name" -At -c "SELECT format('SELECT pg_catalog.setval(%L, %s, true);', format('%I.%I', schemaname, sequencename), last_value)
      FROM pg_sequences WHERE last_value IS NOT NULL ORDER BY 1"
    docker exec "$name" pg_dump -U flux -h 127.0.0.1 -d flux --no-owner --no-privileges --section=post-data | localize
    printf '\n-- Restore the session search_path for the migrator ledger write in this transaction.\nSET LOCAL search_path TO DEFAULT;\n'
  } >"$target"
  echo "Wrote $target from $n migration files ($(grep -c . "$target") lines)"
}

case ${1:-} in
  diff) shift; cmd_diff "$@" ;;
  generate) shift; cmd_generate "$@" ;;
  *) die "usage: $0 diff <source-A> <source-B> [out-dir] | generate <source> <out.sql>" ;;
esac
