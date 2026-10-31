#!/usr/bin/env bash
# Release acceptance runner (#249): runs every automated row of
# docs/agents/release-acceptance/v0.1.0-rc.1.md against ONE candidate SHA, serially, in Docker, and collects the
# logs and a summary into one evidence folder. It publishes nothing, dispatches no release workflow, never
# freezes or pushes main and never posts on GitHub. Rows that need a person or an independent look are listed in
# the matrix ("Manual and independent rows") and in the summary this script writes; it does not pass them.
#
#   scripts/release/acceptance.sh [options] <40-hex candidate SHA>
#     --list               print the steps (id, matrix rows, command) and exit
#     --only a,b,...       run only these step ids
#     --skip a,b,...       skip these step ids
#     --resume             keep earlier PASS results in the evidence folder and run only the rest
#     --out DIR            evidence folder (absolute; default .worktrees/acceptance-<sha12>-evidence)
#     --dispatch-checks    when the SHA has no required-check runs and origin/main is the SHA, dispatch
#                          application-checks.yml and repository-checks.yml on main and wait for them
#
# The candidate is checked out once as a detached, clean worktree in .worktrees/acceptance-<sha12> (never /tmp,
# which is RAM on the maintainers' hosts) and every step runs the CANDIDATE's own scripts there. Steps run one at
# a time: concurrent Docker suites cause timeouts and false failures. Ports come from FLUX_ACCEPTANCE_PORT_BASE
# (default 34000, next 99 ports), so a running ./flux dev stack is not touched. The VAPID variables of a dev
# docker/.env are blanked. FLUX_ACCEPTANCE_OFFLINE=1 skips the steps that download the pinned real CLIs.
# FLUX_DRYRUN_PLATFORMS / FLUX_DRYRUN_SMOKE_PLATFORM pass through to the release dry run (arm64 needs QEMU).
#
# Exit status: 0 when every selected step passed, 1 when one failed, 2 on a usage or checkout error.
set -euo pipefail

root=$(cd "$(dirname "$0")/../.." && pwd)
repo_slug=${FLUX_ACCEPTANCE_REPO:-ColdPhase/flux}
milestone=${FLUX_ACCEPTANCE_MILESTONE:-Flux — complete application and release}
# Issues that close with the release itself (acceptance, image, runtime image).
release_issues=${FLUX_ACCEPTANCE_RELEASE_ISSUES:-249 77 358}
port=${FLUX_ACCEPTANCE_PORT_BASE:-34000}

usage() { sed -n '7,15p' "$0" | sed 's/^# \{0,1\}//' >&2; exit 2; }

list_only=0 resume=0 dispatch=0 only='' skip='' out='' sha=''
while [ $# -gt 0 ]; do
  case "$1" in
    --list) list_only=1 ;;
    --resume) resume=1 ;;
    --dispatch-checks) dispatch=1 ;;
    --only) only=${2:?}; shift ;;
    --skip) skip=${2:?}; shift ;;
    --out) out=${2:?}; shift ;;
    -h|--help) usage ;;
    -*) echo "unknown option: $1" >&2; usage ;;
    *) [ -z "$sha" ] || usage; sha=$1 ;;
  esac
  shift
done

# id | matrix rows | needs internet (1/0) | command, run with bash in the candidate worktree.
# $EVIDENCE is this step's own evidence directory; $SHA the candidate.
steps() {
  cat <<'STEPS'
foundation|R-16 OPS-3|0|python3 scripts/check_agent_setup.py && python3 -m unittest discover -s tests -p 'test_*.py'
milestone|R-2|0|release_step_milestone
required-checks|R-16|0|release_step_required_checks
application|R-5 R-7 R-8 OPS-1 OPS-6 FD-3 F rows C rows P rows AIM rows MOB-1 MOB-3 MOB-4 MOB-5|0|FLUX_E2E_EVIDENCE_DIR="$EVIDENCE" ./scripts/check_application.sh
ui-chromium|R-9 R-10 R-11 U rows A rows MOB-2 MOB-3 F rows|0|./scripts/check_ui.sh
ui-webkit|R-11 MOB-1 MOB-2 MOB-3 MOB-5 A rows|0|FLUX_UI_BROWSER=webkit ./scripts/check_ui.sh $WEBKIT_MODULES
runtime|R-3|0|./scripts/check_runtime.sh
operator-compose|R-3|0|./scripts/check_operator_compose.sh
launcher|R-3 F1|0|./scripts/check_flux_cli.sh
backup|R-6 R-7|0|./scripts/check_backup.sh
oidc|OPS-1 FD-5 8.15|0|./scripts/check_oidc.sh
encryption|ENC-1|0|./scripts/check_encryption.sh
agent-runtime|AIM-3 AIM-4|0|FLUX_RUNTIME_SCREENSHOT_DIR="$EVIDENCE" ./scripts/check_agent_runtime.sh
runtime-cli-contract|AIM-3|1|./scripts/check_runtime_cli_contract.sh
runtime-install|AIM-3|1|./scripts/check_runtime_install.sh
mcp-clients|CO-1 CO-5 PROV-5|1|./scripts/check_mcp_clients.sh
live-sfu|LIVE-4|0|./scripts/check_live_sfu.sh
live-turn|LIVE-1 LIVE-2|0|FLUX_LIVE_TURN_ARTIFACT_DIR="$EVIDENCE" ./scripts/check_live_turn.sh
live-ui|LIVE-3 8.14a|0|FLUX_UI_SCREENSHOT_DIR="$EVIDENCE" ./scripts/check_live_ui.sh
live-platforms|LIVE-3|0|FLUX_LIVE_UI_PATTERN=test_live_platforms.py ./scripts/check_live_ui.sh
live-k3s|LIVE-1|0|./scripts/check_live_k3s.sh
public-sim|LIVE-1 LIVE-2 LIVE-3 LIVE-4|0|FLUX_SIM_ARTIFACT_DIR="$EVIDENCE" ./scripts/check_public_sim.sh
live-editing|LIVE-5|0|./scripts/check_live_editing.sh
live-editing-two-api|LIVE-5|0|./scripts/check_live_editing.sh --two-api
live-editing-restart|LIVE-5|0|./scripts/check_live_editing_restart.sh "$EVIDENCE/restart"
performance|FD-3 ADAPT-5|0|FLUX_PERF_OUT="$EVIDENCE" ./scripts/check_performance.sh
docs-site|DOC-1|0|./scripts/check_docs_site.sh
changelog|DOC-2|0|python3 scripts/changelog.py check && python3 scripts/changelog.py show
release-dry-run|R-12 R-13|0|./scripts/release/dry_run.sh "$EVIDENCE/assets"
STEPS
}

# Phone, tablet and PWA modules that must also pass in WebKit (MOB/ADAPT, emulation under #268). The whole
# WebKit UI suite is not a v0.1 gate: CDP-only cases skip themselves, and check_application.sh already runs
# its WebKit e2e rows. Override with FLUX_ACCEPTANCE_WEBKIT_MODULES.
WEBKIT_MODULES=${FLUX_ACCEPTANCE_WEBKIT_MODULES:-test_scenarios test_adaptive_matrix test_phone_final test_phone_shell test_pwa_device test_update_prompt test_notifications test_settings test_instant_send test_home_final test_inbox_final test_tasks_final test_wiki_final test_conversation_final test_detail_panel_final test_new_project_final test_sign_in}
export WEBKIT_MODULES

# Unknown ids in --only/--skip are a typo, not an empty selection.
known=",$(steps | cut -d'|' -f1 | paste -sd, -),"
for id in ${only//,/ } ${skip//,/ }; do
  [[ "$known" == *",$id,"* ]] || { echo "unknown step id: $id (see --list)" >&2; exit 2; }
done

if [ "$list_only" = 1 ]; then
  steps | awk -F'|' '{ printf "%-22s %-12s %s\n      rows: %s\n", $1, ($3 == 1 ? "(internet)" : ""), $4, $2 }'
  exit 0
fi

[[ "$sha" =~ ^[0-9a-f]{40}$ ]] || { echo 'candidate must be a full 40-hex SHA' >&2; usage; }
command -v docker >/dev/null || { echo 'docker is required' >&2; exit 2; }
command -v gh >/dev/null || { echo 'gh is required (milestone and required-check rows)' >&2; exit 2; }
git -C "$root" fetch -q origin main || true
git -C "$root" cat-file -e "$sha^{commit}" 2>/dev/null || { echo "unknown commit $sha (fetch it first)" >&2; exit 2; }
if ! git -C "$root" merge-base --is-ancestor "$sha" origin/main; then
  echo "$sha is not on origin/main: a release candidate comes from protected main" >&2
  exit 2
fi

short=${sha:0:12}
worktree="$root/.worktrees/acceptance-$short"
out=${out:-$root/.worktrees/acceptance-$short-evidence}
case "$out" in /*) ;; *) echo '--out must be absolute' >&2; exit 2 ;; esac
case "$out" in /tmp/*) echo 'warning: /tmp may be RAM (tmpfs); prefer the default under .worktrees' >&2 ;; esac
if [ -d "$worktree" ]; then
  [ "$(git -C "$worktree" rev-parse HEAD)" = "$sha" ] || { echo "$worktree is not at $sha" >&2; exit 2; }
else
  git -C "$root" worktree add -q --detach "$worktree" "$sha"
fi
[ -z "$(git -C "$worktree" status --porcelain)" ] || { echo "$worktree has local changes" >&2; exit 2; }
mkdir -p "$out"
status_file="$out/status.tsv"
[ "$resume" = 1 ] && [ -f "$status_file" ] || printf 'step\tresult\tseconds\tstarted_utc\trows\n' > "$status_file"

# Isolation from a developer's ./flux dev stack and docker/.env (VAPID leaks into check runs).
export FLUX_VAPID_PUBLIC_KEY='' FLUX_VAPID_PRIVATE_KEY='' FLUX_VAPID_SUBJECT=''
export FLUX_TEST_PORT=$((port)) FLUX_TEST_MAILPIT_PORT=$((port + 1))
export FLUX_UI_PORT=$((port + 2)) FLUX_UI_MAILPIT_PORT=$((port + 3))
export FLUX_RUNTIME_TEST_PORT=$((port + 4)) FLUX_OPERATOR_TEST_PORT=$((port + 5))
export FLUX_CLI_TEST_PORT=$((port + 6)) FLUX_CLI_TEST_DEV_PORT=$((port + 7)) FLUX_CLI_TEST_MAILPIT_PORT=$((port + 8))
export FLUX_BACKUP_TEST_PORT=$((port + 10)) FLUX_OIDC_TEST_PORT=$((port + 20))
export FLUX_LIVE_TEST_PORT=$((port + 30)) FLUX_LIVE_TEST_ICE_TCP_PORT=$((port + 31))
export FLUX_LIVE_TEST_ICE_UDP_PORT=$((port + 32)) FLUX_LIVE_TEST_TURN_UDP_PORT=$((port + 33))
export FLUX_LIVE_TURN_TEST_PORT=$((port + 40)) FLUX_LIVE_TURN_TEST_ICE_TCP_PORT=$((port + 41))
export FLUX_LIVE_TURN_TEST_ICE_UDP_PORT=$((port + 42)) FLUX_LIVE_TURN_TEST_SIGNAL_PORT=$((port + 43))
export FLUX_LIVE_TURN_TEST_TLS_PORT=$((port + 44)) FLUX_LIVE_TURN_TEST_TURN_UDP_PORT=$((port + 45))
export FLUX_LIVE_UI_PORT=$((port + 50)) FLUX_LIVE_UI_MAILPIT_PORT=$((port + 51)) FLUX_LIVE_UI_ICE_TCP_PORT=$((port + 52))
export FLUX_LIVE_UI_ICE_UDP_PORT=$((port + 53)) FLUX_LIVE_UI_TURN_UDP_PORT=$((port + 54))
export FLUX_LIVE_EDITING_PORT=$((port + 60)) FLUX_LIVE_EDITING_MAILPIT_PORT=$((port + 61))
export FLUX_PERF_PORT=$((port + 70)) FLUX_DOCS_PORT=$((port + 71)) FLUX_SIM_API_PORT=$((port + 72))
export FLUX_DRYRUN_PORT=$((port + 80)) FLUX_DRYRUN_PROJECT="fluxacc$$"
export SHA=$sha RELEASE_REPO=$repo_slug RELEASE_MILESTONE=$milestone RELEASE_ISSUES=$release_issues

# R-2: every milestone issue is closed except the ones the release itself closes.
release_step_milestone() {
  local open
  open=$(gh issue list -R "$RELEASE_REPO" --milestone "$RELEASE_MILESTONE" --state open --limit 200 \
    --json number,title --jq '.[] | "\(.number)\t\(.title)"')
  printf 'Open issues in "%s" on %s:\n%s\n' "$RELEASE_MILESTONE" "$(date -u +%FT%TZ)" "${open:-none}"
  local blocking
  blocking=$(printf '%s\n' "$open" | awk -F'\t' -v keep=" $RELEASE_ISSUES " 'NF && index(keep, " " $1 " ") == 0')
  if [ -n "$blocking" ]; then printf '\nStill open and not closed by the release itself:\n%s\n' "$blocking"; return 1; fi
}

# R-16: the two required checks succeeded on this exact commit.
release_step_required_checks() {
  local runs missing='' name
  runs=$(gh api "repos/$RELEASE_REPO/commits/$SHA/check-runs?per_page=100" \
    --jq '.check_runs[] | "\(.name)\t\(.status)\t\(.conclusion)\t\(.html_url)"')
  printf 'Check runs on %s:\n%s\n' "$SHA" "${runs:-none}"
  for name in 'Agent setup' 'Application validation'; do
    printf '%s\n' "$runs" | grep -q "^$name	completed	success	" || missing="$missing [$name]"
  done
  if [ -n "$missing" ]; then
    printf '\nNo successful run of:%s on %s.\n' "$missing" "$SHA"
    printf 'A squash merge gets no PR run of its own. With main at %s, dispatch them:\n' "$SHA"
    printf '  gh workflow run application-checks.yml --ref main; gh workflow run repository-checks.yml --ref main\n'
    printf 'or rerun this step with --dispatch-checks.\n'
    return 1
  fi
}

dispatch_required_checks() {
  [ "$(git -C "$root" rev-parse origin/main)" = "$sha" ] || {
    echo "--dispatch-checks: origin/main is not $sha; the dispatched run would test another commit" >&2; return 1; }
  local wf id
  for wf in application-checks.yml repository-checks.yml; do
    gh workflow run "$wf" -R "$repo_slug" --ref main
  done
  # Wait for the runs of the two workflows on this SHA (they appear a few seconds after the dispatch).
  for wf in application-checks.yml repository-checks.yml; do
    id=''
    for _ in $(seq 1 30); do
      id=$(gh run list -R "$repo_slug" --workflow "$wf" --event workflow_dispatch --commit "$sha" --limit 1 \
        --json databaseId --jq '.[0].databaseId // empty')
      [ -n "$id" ] && break
      sleep 5
    done
    [ -n "$id" ] || { echo "no dispatched run of $wf on $sha" >&2; return 1; }
    gh run watch -R "$repo_slug" "$id" --exit-status >/dev/null
  done
}
export -f release_step_milestone release_step_required_checks

selected() {
  local id=$1
  if [ -n "$only" ] && [[ ",$only," != *",$id,"* ]]; then return 1; fi
  if [ -n "$skip" ] && [[ ",$skip," == *",$id,"* ]]; then return 1; fi
  return 0
}

{
  echo "candidate_sha=$sha"
  echo "origin_main=$(git -C "$root" rev-parse origin/main)"
  echo "runner_commit=$(git -C "$root" rev-parse HEAD)"
  echo "started_utc=$(date -u +%FT%TZ)"
  echo "host=$(uname -srm)"
  echo "cpus=$(getconf _NPROCESSORS_ONLN 2>/dev/null || echo unknown)"
  echo "docker=$(docker version --format '{{.Server.Version}}' 2>/dev/null || echo unknown)"
  echo "compose=$(docker compose version --short 2>/dev/null || echo unknown)"
  echo "port_base=$port"
} > "$out/environment.txt"

if [ "$dispatch" = 1 ] && selected required-checks; then
  dispatch_required_checks 2>&1 | tee "$out/required-checks-dispatch.log" || true
fi

failed=0
while IFS='|' read -r id rows network cmd; do
  selected "$id" || continue
  if [ "$resume" = 1 ] && awk -F'\t' -v id="$id" '$1 == id && $2 == "PASS" { found = 1 } END { exit !found }' "$status_file"; then
    printf '%-22s PASS (kept from an earlier run)\n' "$id"
    continue
  fi
  log="$out/$id.log"
  started=$(date -u +%FT%TZ)
  if [ "$network" = 1 ] && [ "${FLUX_ACCEPTANCE_OFFLINE:-0}" = 1 ]; then
    printf '%s\tSKIPPED-OFFLINE\t0\t%s\t%s\n' "$id" "$started" "$rows" >> "$status_file"
    printf '%-22s SKIPPED (FLUX_ACCEPTANCE_OFFLINE=1)\n' "$id"
    continue
  fi
  evidence="$out/$id"
  rm -rf "$evidence" && mkdir -p "$evidence"
  printf '%-22s running (log %s)\n' "$id" "$log"
  t0=$(date +%s)
  set +e
  ( cd "$worktree" && EVIDENCE="$evidence" bash -c "set -euo pipefail; echo \"+ $cmd\"; $cmd" ) > "$log" 2>&1 < /dev/null
  rc=$?
  set -e
  secs=$(( $(date +%s) - t0 ))
  if [ "$rc" = 0 ]; then result=PASS; else result="FAIL($rc)"; failed=1; fi
  # Drop earlier results of this step, then record the new one.
  awk -F'\t' -v id="$id" '$1 != id' "$status_file" > "$status_file.new" && mv "$status_file.new" "$status_file"
  printf '%s\t%s\t%s\t%s\t%s\n' "$id" "$result" "$secs" "$started" "$rows" >> "$status_file"
  rmdir "$evidence" 2>/dev/null || true
  printf '%-22s %s in %ss\n' "$id" "$result" "$secs"
done < <(steps)

{
  echo "# Release acceptance run: \`$sha\`"
  echo
  echo "Runner: \`scripts/release/acceptance.sh\` at \`$(git -C "$root" rev-parse --short=12 HEAD)\`;"
  echo "the steps ran the candidate's own scripts in \`.worktrees/acceptance-$short\`. Environment: \`environment.txt\`."
  echo
  echo '| Step | Result | Seconds | Started (UTC) | Matrix rows |'
  echo '| --- | --- | --- | --- | --- |'
  tail -n +2 "$status_file" | awk -F'\t' '{ printf "| %s | %s | %s | %s | %s |\n", $1, $2, $3, $4, $5 }'
  echo
  echo 'Acceptance lines on #249 for this SHA (founder decision on #249, 2026-10-31; checked by'
  echo '`scripts/release/verify_acceptance.py` in `final-release.yml`):'
  echo
  echo '```text'
  echo "ACCEPTED RELEASE CANDIDATE $sha"
  echo "INDEPENDENT RELEASE REVIEW $sha reviewer=<agent name> session=<reviewer's session id or URL>"
  echo '```'
  echo
  echo 'The first is posted by PelikanFix16. The second by the independent reviewer (through a founder login),'
  echo 'whose session must not appear in any commit message up to this SHA: the reviewer wrote none of it.'
  echo
  echo 'Automated steps only. The rows that need a person or an independent look are in'
  echo '`docs/agents/release-acceptance/v0.1.0-rc.1.md`, "Manual and independent rows"; record their verdicts'
  echo 'against this SHA on #249. Logs are local evidence: link a summary, do not commit raw logs.'
} > "$out/SUMMARY.md"

printf '\nSummary: %s\n' "$out/SUMMARY.md"
exit "$failed"
