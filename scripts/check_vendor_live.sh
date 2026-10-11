#!/bin/sh
# OPTIONAL, never required, never in CI (founder direction on #279, 2026-10-08): the live vendor check.
# Flux is accepted on mocks and fakes only: no test, check or acceptance step uses a real vendor account,
# subscription or spend. This script exists for a maintainer who wants to look at the real vendors once,
# by hand, on their own machine. It refuses unless FLUX_LIVE_VENDOR=1 is set, and it is not part of
# scripts/check_application.sh or of any required check (tests/test_vendor_live.py fails if it is).
#
# With the opt-in it only READS: `claude auth status` and `codex login status` for the logins the
# maintainer already has on this machine. It signs nothing in or out and sends no prompt. Its output
# stays on the terminal and can hold an account address, so it is not published or committed.
set -eu

if [ "${FLUX_LIVE_VENDOR:-}" != "1" ]; then
  echo "check_vendor_live.sh is an optional live-vendor check and refuses to run without FLUX_LIVE_VENDOR=1." >&2
  echo "Flux's checks use fakes and mocks only; nothing requires a real vendor account." >&2
  exit 2
fi

if command -v claude >/dev/null 2>&1; then
  echo "== claude auth status"
  claude auth status || true
else
  echo "claude is not installed on this machine: skipped"
fi
if command -v codex >/dev/null 2>&1; then
  echo "== codex login status"
  codex login status || true
else
  echo "codex is not installed on this machine: skipped"
fi
# A signed-out CLI exits 1 by design; this script only shows what is there.
