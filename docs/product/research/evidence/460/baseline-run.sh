#!/bin/sh
# Portable, opt-in reconstruction. Historical executed wrapper is in historical/.
set -eu
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec "$script_dir/research-run.sh" baseline "$@"
