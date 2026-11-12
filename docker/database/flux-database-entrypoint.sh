#!/usr/bin/env bash
# Flux's database entrypoint (F-041): the official docker-entrypoint.sh, with pg_search always in shared_preload_libraries.
# pg_search refuses to work unless it is preloaded, and a Compose file or an operator may replace the command (log settings,
# pg_stat_statements): a value they give keeps its libraries and gains pg_search; without one, pg_search is added.
# Two pg_search defaults, unless the command sets them:
# - its planner notes ("JoinScan not used ...") are off: they would be a log line for every query that joins the indexed table;
# - its custom scan is off. With it on, pg_search plans every query on an indexed table and refuses any condition on a column that
#   the index holds twice (search_documents' title and body, once per stemmer: "Query is ambiguous"). Flux's BM25 statements turn
#   it on for their own transaction (SET LOCAL, packages/db/src/repositories/search.ts); every other statement plans as before.
set -euo pipefail
if [ "${1:-}" = postgres ]; then
  args=() preload=0 warnings=0 scan=0
  for arg in "$@"; do
    case "$arg" in
      shared_preload_libraries=*|--shared_preload_libraries=*|--shared-preload-libraries=*)
        preload=1
        value=${arg#*=}
        case ",${value// /}," in
          *,pg_search,*) ;;
          ,,) arg="${arg%%=*}=pg_search" ;;
          *) arg="${arg%%=*}=$value,pg_search" ;;
        esac ;;
      paradedb.planner_warnings=*|--paradedb.planner_warnings=*) warnings=1 ;;
      paradedb.enable_custom_scan=*|--paradedb.enable_custom_scan=*) scan=1 ;;
    esac
    args+=("$arg")
  done
  [ "$preload" = 1 ] || args+=(-c shared_preload_libraries=pg_search)
  [ "$warnings" = 1 ] || args+=(-c paradedb.planner_warnings=off)
  [ "$scan" = 1 ] || args+=(-c paradedb.enable_custom_scan=off)
  set -- "${args[@]}"
fi
exec docker-entrypoint.sh "$@"
