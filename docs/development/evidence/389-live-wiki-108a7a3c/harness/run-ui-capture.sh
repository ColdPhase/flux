#!/usr/bin/env bash
# Temporary #389 evidence runner. Mirrors check_live_editing.sh setup/cleanup and
# adds a host screenshot bind mount plus one read-only live-reader capture harness.
set -euo pipefail
repo=/home/hubert/Develop/flux-389
evidence=${FLUX_389_EVIDENCE_DIR:?Set FLUX_389_EVIDENCE_DIR to a fresh absolute directory}
expected_source=${FLUX_389_SOURCE_SHA:?Set FLUX_389_SOURCE_SHA to the reviewed composed commit}
engine=${FLUX_UI_BROWSER:-chromium}
case "$engine" in chromium|webkit) ;; *) echo "FLUX_UI_BROWSER must be chromium or webkit" >&2; exit 2 ;; esac
case "$evidence" in /*) ;; *) echo "FLUX_389_EVIDENCE_DIR must be absolute" >&2; exit 2 ;; esac
if [ -e "$evidence" ] && [ -n "$(ls -A "$evidence")" ]; then echo "Evidence directory must be new or empty" >&2; exit 2; fi
mkdir -p "$evidence/screenshots"
cd "$repo"
actual_source=$(git rev-parse HEAD)
if [[ "$actual_source" != "$expected_source" ]]; then
  echo "Source SHA mismatch: expected $expected_source, found $actual_source" >&2
  exit 2
fi
export POSTGRES_USER=flux POSTGRES_DB=flux
export POSTGRES_PASSWORD="flux-live-capture-$$-$(date +%s)"
export FLUX_FIXTURE_TOKEN="fixture-live-capture-$$-$(date +%s)"
export FLUX_PORT="${FLUX_LIVE_EDITING_PORT:-18691}"
export FLUX_MAILPIT_PORT="${FLUX_LIVE_EDITING_MAILPIT_PORT:-18692}"
export FLUX_PUBLIC_ORIGIN="http://127.0.0.1:${FLUX_PORT}"
export FLUX_AUTH_SECRET="auth-live-capture-$$-$(date +%s)-$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')"
export FLUX_SMTP_URL=smtp://mailpit:1025 FLUX_MAIL_FROM='Flux <flux@example.test>'
export FLUX_AUTH_RATE_LIMIT=false
export FLUX_VAPID_PUBLIC_KEY= FLUX_VAPID_PRIVATE_KEY= FLUX_VAPID_SUBJECT=
export FLUX_DEVELOPMENT_LIVE_EDITING_TELEMETRY= FLUX_DEVELOPMENT_LIVE_EDITING_API_INSTANCE=
. scripts/test_images.sh
project="flux-live-capture-$(date +%s)-$$"
compose="docker compose -p $project -f docker/compose.source.yaml -f docker/compose.live-editing.test.yaml --profile ui"
capture_script=/home/hubert/Develop/flux-evidence-archive/flux389-b1baa8a1-capture/capture_live_reader.py
status=0
cleanup() {
  status=$?
  if [ "$status" -ne 0 ]; then $compose logs --no-color --tail 300 api > "$evidence/compose-api-failure.log" 2>&1 || true; fi
  $compose down -v > "$evidence/compose-down.log" 2>&1 || true
  remove_project_images > "$evidence/image-cleanup.log" 2>&1 || true
  exit "$status"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
printf '%s\n' "source=$actual_source" "engine=$engine" "runner=$0" > "$evidence/run-metadata.txt"
sha256sum "$0" "$capture_script" scripts/check_live_editing.sh > "$evidence/harness-sha256.txt"
$compose build migrate ui-test > "$evidence/build.log" 2>&1
$compose up -d db migrate > "$evidence/services.log" 2>&1
$compose --profile setup run --rm files-init >> "$evidence/services.log" 2>&1
$compose up -d --wait api >> "$evidence/services.log" 2>&1
set -- \
  test_live_editing.LiveEditingJourney.test_01_live_characters_named_cursors_own_undo_and_immutable_save \
  test_live_editing.LiveEditingJourney.test_02_ordinary_reader_tracks_working_text_and_history_stays_saved \
  test_live_editing.LiveEditingJourney.test_07_phone_tablet_and_private_capture_are_real_browser_journeys \
  test_wiki_final.WikiFinal.test_phone_title_chips_and_edit \
  test_wiki_final.WikiFinal.test_computer_two_panes_and_outline
$compose run --rm --no-deps -v "$evidence/screenshots:/screenshots:z" \
  -e FLUX_LIVE_EDITING_TEST=1 -e FLUX_UI_BROWSER="$engine" -e FLUX_UI_SCREENSHOTS=/screenshots \
  -w /work/tests/ui ui-test python3 -m unittest -v "$@" > "$evidence/unittest.log" 2>&1
$compose run --rm --no-deps -v "$evidence/screenshots:/screenshots:z" \
  -v "$capture_script:/work/tests/ui/capture_389_live_reader.py:ro,z" \
  -e FLUX_LIVE_EDITING_TEST=1 -e FLUX_UI_BROWSER="$engine" -e FLUX_UI_SCREENSHOTS=/screenshots \
  -w /work/tests/ui ui-test python3 capture_389_live_reader.py > "$evidence/live-reader-capture.log" 2>&1
python3 - "$evidence" "$engine" "$actual_source" <<'PY'
import hashlib, json, pathlib, struct, sys
root = pathlib.Path(sys.argv[1]); engine = sys.argv[2]; source_sha = sys.argv[3]
rows = []
for path in sorted((root / "screenshots").glob("*.png")):
    data = path.read_bytes()
    width, height = struct.unpack(">II", data[16:24])
    rows.append({"file": path.name, "widthPx": width, "heightPx": height,
                 "sha256": hashlib.sha256(data).hexdigest()})
manifest = {
  "sourceSha": source_sha,
  "engine": engine, "browserZoom": "default (not changed by runner)",
  "fixtures": {"liveReader": "Ada writer + Kai reader; saved doc plus a live heading and text before Save",
               "wiki": "Community garden sensors; five published pages; WikiFinal class fixture"},
  "captureContexts": {
    "live-reader-desktop-1440-light.png": {"viewportCssPx": [1440, 900], "deviceScaleFactor": 1, "theme": "light", "fixture": "liveReader", "mobileEmulation": False},
    "live-reader-phone-390-light.png": {"viewportCssPx": [390, 844], "deviceScaleFactor": 1, "theme": "light", "fixture": "liveReader", "mobileEmulation": False},
    "wiki-final-phone-390-light.png": {"viewportCssPx": [390, 844], "deviceScaleFactor": 2, "theme": "light", "fixture": "wiki", "mobileEmulation": True},
    "wiki-final-phone-390-dark.png": {"viewportCssPx": [390, 844], "deviceScaleFactor": 2, "theme": "dark", "fixture": "wiki", "mobileEmulation": True},
    "wiki-final-desktop-1440-light.png": {"viewportCssPx": [1440, 900], "deviceScaleFactor": 1, "theme": "light", "fixture": "wiki", "mobileEmulation": False},
    "wiki-final-desktop-1440-dark.png": {"viewportCssPx": [1440, 900], "deviceScaleFactor": 1, "theme": "dark", "fixture": "wiki", "mobileEmulation": False},
  },
  "screenshots": rows,
}
(root / "screenshot-manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
if len(rows) != 6:
    raise SystemExit(f"Expected six evidence frames, found {len(rows)}")
PY
sha256sum "$evidence"/screenshots/*.png "$evidence"/screenshot-manifest.json > "$evidence/SHA256SUMS"
