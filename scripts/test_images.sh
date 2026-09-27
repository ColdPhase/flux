# Sourced by the Docker check scripts after `$compose` and `$project` are set.
# Removes only the images this run built and tagged for its own Compose project.
# Base images, other projects' tags (e.g. flux-foundation:flux-demo) and the
# shared build cache are left alone. FLUX_KEEP_TEST_IMAGES=1 keeps them.

remove_project_images() {
  if [ "${FLUX_KEEP_TEST_IMAGES:-}" = 1 ]; then
    echo "FLUX_KEEP_TEST_IMAGES=1: kept per-run images tagged :$project" >&2
    return 0
  fi
  removed=0
  for image in $($compose config --images 2>/dev/null | sort -u); do
    case "$image" in
      *:"$project") ;;
      *) continue ;;
    esac
    if docker image inspect "$image" >/dev/null 2>&1 &&
      docker image rm -f "$image" >/dev/null 2>&1; then
      removed=$((removed + 1))
    fi
  done
  echo "Removed $removed per-run image(s) tagged :$project" >&2
}
