# Reproducing the bounded #460 research

These are opt-in **historical research probes**, not a production validation
lane and not part of CI or `check_application.sh`. The sanitized baseline and
prototype results were author-run on 2026-10-10; the docs correction on
2026-10-11 does not replay those client/runtime tests. The temporary prototype
is not shipped compatibility or built-in Connect support.

All paths below are relative to this directory. Original results and probes,
[`source-manifest.json`](source-manifest.json),
[`prototype-patch.json`](prototype-patch.json) and
[`prototype-Dockerfile`](prototype-Dockerfile) are preserved unchanged.
The exact executed wrappers/configs are retained in `historical/`, with
[`historical-file-hashes.json`](historical-file-hashes.json). Their personal
worktree and `/tmp` paths are provenance only; do not execute them as portable
commands. Their comments describe the harness ancestry, not additional cases
proved by these bounded probes. Author-local logs are supplementary; results
retain their final hashes but do not promise those files exist on your machine.

Use [`baseline-run.sh`](baseline-run.sh) or [`prototype-run.sh`](prototype-run.sh).
They find all research files relative to themselves and require a Git repository
containing exact server object `975747426a778cc4471bd4c9eabb8910eb187671`.
They archive that object into an owned temporary directory; the input repository
and its current branch/worktree are never modified. The prototype verifies the
archived JSON string's UTF-8 SHA-256 before applying it only to a separate
throwaway source fragment, which supplies the two named-context files to Docker.
The retained original app source, migration ledger and production branch stay
unchanged. No host app dependency install is involved (Python standard library,
Git, shell, tar and Docker Compose are preparation tools).

From the repository root, after checking port/IPAM availability:

```sh
FLUX_RESEARCH_SOURCE_DIR="$PWD" \
FLUX_RESEARCH_OUTPUT_DIR="$PWD/research-baseline-output" \
FLUX_TEST_PORT=19820 FLUX_TEST_MAILPIT_PORT=19821 \
FLUX_RESEARCH_SUBNET_DEFAULT=10.198.100.0/24 \
FLUX_RESEARCH_SUBNET_CONTROL=10.198.101.0/24 \
FLUX_RESEARCH_SUBNET_API=10.198.102.0/24 \
  docs/product/research/evidence/460/baseline-run.sh --prepare-only
```

Choose a **new** output directory each time (the runner refuses an existing
one). Substitute `prototype-run.sh` and a new output directory to prepare the
prototype. Preparation verifies exact source/patch and resolved Compose
configuration; it does not build/start Docker resources or execute clients.
Remove `--prepare-only` for an actual Docker run. Check the chosen ports and all
three subnet ranges first; examples are not a reservation or permission to
collide with another lane. Output contains results/project identity; do not dump
resolved environment/configuration because it contains ephemeral test secrets.

Actual runs build the pinned source/client images, start only their Compose
project, and run the corresponding archived probe with real Linux amd64 Codex
0.160.1 plus the scripted local model endpoint. Both modes need network access
to retrieve checksummed pinned Codex/code-mode-host assets and the pinned,
signature-checked Claude release used by the harness. No vendor account, API key,
paid model call or external account sign-in is used. This does not certify native
registration discovery or genuine model instruction obedience.

The common [`research-run.sh`](research-run.sh) installs signal/exit cleanup for
its owned stage directory, named containers/volumes/networks and project-tagged
images. Evidence output is retained, as are other projects and shared cache.
The original [`baseline-results.json`](baseline-results.json) and
[`prototype-results.json`](prototype-results.json) remain the evidence for the
2026-10-10 runs; any rerun must receive its own dated exact-pin result rather
than overwrite those files or silently promote the proposal to supported.
