#!/usr/bin/env bash
# Flux's database entrypoint (F-041): the official docker-entrypoint.sh, with pg_search always in shared_preload_libraries.
# pg_search refuses to work unless it is preloaded, and a Compose file or an operator may replace the command (log settings,
# pg_stat_statements): a value they give keeps its libraries and gains pg_search; without one, pg_search is added.
# pg_search's planner notes ("JoinScan not used ...") are off unless the command sets them: they would be a log line for every
# query that joins the indexed table, which Flux's statements do by design.
set -euo pipefail
if [ "${1:-}" = postgres ]; then
  args=() preload=0 warnings=0
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
    esac
    args+=("$arg")
  done
  [ "$preload" = 1 ] || args+=(-c shared_preload_libraries=pg_search)
  [ "$warnings" = 1 ] || args+=(-c paradedb.planner_warnings=off)
  set -- "${args[@]}"
fi
exec docker-entrypoint.sh "$@"
