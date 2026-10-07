# Repository layout and self-hosted distribution proposal (#75)

**Status:** accepted path and delivery amendment, 2026-09-27, after
[independent review of `e5d8f9d`](https://github.com/ColdPhase/flux/pull/79#pullrequestreview-5332150407)
and merge of PR #79. #76 implements the paths and #77 implements distribution;
this decision is not itself a release or permission to move active branches.

**#76 progress, 2026-09-30:** phase 1 adds the pull-only operator
[`docker/compose.yaml`](../../docker/compose.yaml) and its
[`docker/.env.example`](../../docker/.env.example) with the release marker
`ghcr.io/coldphase/flux@sha256:RELEASE_DIGEST` on `api`, `worker` and `migrate`, checked by
`tests/test_operator_compose.py` and `scripts/check_operator_compose.sh`
([install guide](../operations/install-release.md)). The `app/` move, the source/dev/test
Compose files under `docker/`, the launcher switch to `docker/.env` and the single env
template are implemented together in the remaining #76 slice. The historical prototype stays at
the repository root; application/configuration paths now follow the accepted map below.
Exact-head Docker build/runtime/browser/upgrade checks and independent PR review are
required before this slice is accepted. The observations at `603b35c` below remain historical.

**#77 packaging note, 2026-10-01:** GitHub stores a Release asset whose name begins with a
period under another name (`.env.example` becomes `default.env.example`) and
`actions/upload-artifact` skips hidden files. Wherever this proposal says the release attaches
`.env.example`, the asset is that same file published as `env.example`; `docker/.env.example`
keeps its name in the repository. The packaged `compose.yaml` differs from `docker/compose.yaml`
only in the digest and its header comment. See the [release pipeline](release-pipeline.md).

**Situation and decision:** A contributor should find the application in one
place, while an operator should install a versioned Flux without cloning its
source. The founder prefers `app/` for the application workspace and `docker/`
for Compose examples. The uncertainty is whether that layout simplifies actual
build, test and upgrade work enough to justify changing the accepted root pnpm
workspace and `infra/compose.yaml`. Folder names do not fix the [current
dependency debt](architecture.md#known-debt) in `core`.

## Observations, 2026-09-27

These are repository and documentation observations, not claims that the other
products' installation or upgrade paths were tested here. Links pin inspected
source revisions so the comparison can be repeated.

| Product | Observed source and delivery shape | Inference for Flux |
| --- | --- | --- |
| [Immich](https://github.com/immich-app/immich/tree/6b978d0c0d3dfddf43c9138314bc7d1c5e5295d2) | Root `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`; `server/`, `web/`, `packages/`, and [`docker/docker-compose.yml`](https://github.com/immich-app/immich/blob/6b978d0c0d3dfddf43c9138314bc7d1c5e5295d2/docker/docker-compose.yml). The Compose file warns that `main` may differ from the release and links to its matching release asset. Its [Docker workflow](https://github.com/immich-app/immich/blob/6b978d0c0d3dfddf43c9138314bc7d1c5e5295d2/.github/workflows/docker.yml) includes amd64 and arm64 builds. An [independent chart repository](https://github.com/immich-app/immich-charts/tree/4cde6937cd2fc12458bb1d8f014888f20b3fc193) publishes an OCI chart with a [release workflow](https://github.com/immich-app/immich-charts/blob/4cde6937cd2fc12458bb1d8f014888f20b3fc193/.github/workflows/release.yaml). | A separate Docker area and release-matched Compose are useful precedents. Root workspace files are also a viable precedent; `app/` is a Flux choice, not an industry requirement. A chart creates another versioned product to maintain. |
| [Plane](https://github.com/makeplane/plane/tree/888b0869dc6a3cc993e6f2f289ee81b191139e1f) | Root pnpm workspace with `apps/`, `packages/`, [`deployments/cli/community/docker-compose.yml`](https://github.com/makeplane/plane/blob/888b0869dc6a3cc993e6f2f289ee81b191139e1f/deployments/cli/community/docker-compose.yml) using `APP_RELEASE`, and a [separate Helm chart repository](https://github.com/makeplane/helm-charts/tree/cf0bccc7141260cd41c59ed13b3af7f9a92076bb). Its [installation guide](https://github.com/makeplane/plane/blob/888b0869dc6a3cc993e6f2f289ee81b191139e1f/deployments/cli/community/README.md) downloads setup and Compose assets from GitHub Releases. | Keeping deployment examples separate from source helps operators. Plane's many service images and installer script do not justify copying that complexity into Flux. |
| [Documenso](https://github.com/documenso/documenso/tree/a1d4bec1430a937395db9a4aae28979cd71c2831) | Root `package.json`/`package-lock.json`, `apps/`, `packages/`, plus [`docker/{development,production,testing}`](https://github.com/documenso/documenso/tree/a1d4bec1430a937395db9a4aae28979cd71c2831/docker). Its [Compose instructions](https://github.com/documenso/documenso/blob/a1d4bec1430a937395db9a4aae28979cd71c2831/apps/docs/content/docs/self-hosting/deployment/docker-compose.mdx) direct operators to a production file on the `release` branch; the inspected [production Compose](https://github.com/documenso/documenso/blob/a1d4bec1430a937395db9a4aae28979cd71c2831/docker/production/compose.yml) currently defaults to `documenso/documenso:latest`. | The environment split is clear, but a floating image tag weakens reproduction. Flux should bind downloaded configuration and image to one release. |

The sample shows no universal placement for pnpm files. It does support keeping
operator deployment files distinct and treating image and Compose compatibility
as a release contract. No competitor's user success, security or upgrade quality
was inferred from repository layout.

## Current Flux path and coupling map

At `main` `603b35c` the root `package.json`, lock, pnpm workspace, TypeScript,
ESLint and `.env.example` govern `apps/{web,server,worker}`,
`packages/{contracts,core,db,agent-runtime,sdk}`, `examples/external-agent`
and `tests/app`. `infra/Dockerfile` copies the whole repository into `/app`,
builds the workspace and copies `infra/dist/migrate.js` to its runtime stage.
`infra/compose.yaml` and `infra/compose.test.yaml` set `build.context: ..`, use
`infra/Dockerfile`, and run that migration path. The root `package.json` build
script calls `tsc -p infra/tsconfig.build.json`; `infra/migrate.ts` resolves
`packages/db/migrations` from the process working directory; and
`apps/server/src/index.ts` resolves `apps/web/dist` from `process.cwd()`.
`apps/web/scripts/generate-icons.ts` documents Compose and container paths and
defaults output to `apps/web/public/icons`. `scripts/check_application.sh` and
`scripts/check_runtime.sh` refer to the Compose files and `tests/app` paths;
both source `scripts/test_images.sh`, which discovers per-project images from
`docker compose config --images` for cleanup. Their `cd` to the repository root
currently supplies the working-directory invariant.
Since #55, root `package.json` also typechecks with
`tsc --noEmit -p apps/web/tsconfig.json` while root `tsconfig.json` excludes
`apps/web/**`; both configurations move together. `scripts/check_ui.sh` uses
the `ui` profile of `infra/compose.yaml`, sources `scripts/test_images.sh`,
and runs the `ui-test` service with isolated ports and volumes.
`infra/ui-tests.Dockerfile` copies `tests/ui/requirements.txt` and all of
`tests/ui/` into a pinned Python/Playwright image. These Python browser tests
are distinct from both TypeScript `tests/app` and root agent setup tests.
`scripts/check_contrast.py` reads `apps/web/src/ui/tokens.css` relative to the
repository root, while `docs/design/app-shell/README.md` and
`docs/development/containers.md` document the UI checks and paths.
The root `README.md`, `docs/development/containers.md`, `docs/CONTRIBUTING.md`,
`.github/workflows/application-checks.yml`, `.dockerignore`, and the layer scan
in `tests/app/support/architecture.ts` are part of this path contract.
The repository check still uses root `scripts/check_agent_setup.py`,
`tests/test_agent_setup.py` and `.agents/` and should remain discoverable there.

There is also real architectural debt independent of paths: the
[architecture map](architecture.md#known-debt) lists `core` imports of `@flux/db`,
Drizzle and pg-boss. Moving `packages/core` beneath `app/` cannot cure them.
The import scanner and its temporary allowlist need their scan roots updated
without growing the allowlist. Active #36 and #46 branches touch these modules;
rebase each after its owner has handed off a clean head, never edit another
worker's worktree.

## Recommendation and alternatives

Choose this accepted target:

```text
app/                       # the sole pnpm workspace root; image WORKDIR /app
  package.json, pnpm-lock.yaml, pnpm-workspace.yaml
  tsconfig.json, eslint.config.js, .env.example
  apps/{web,server,worker}/
  packages/{contracts,core,db,agent-runtime,sdk}/
  tests/{app,ui}/           # TypeScript app checks and Python/Playwright UI checks
  examples/external-agent/  # public client example; license stays Apache-2.0
  tooling/{migrate.ts,tsconfig.build.json}  # migration entry/build; SQL stays packages/db/migrations
docker/
  Dockerfile                # builds with app/ as context
  ui-tests.Dockerfile       # copies app/tests/ui with app/ as context
  compose.source.yaml       # source-built production-mode app for ./flux up
  compose.dev.yaml          # hot-reload overlay with bind mounts for ./flux dev
  compose.test.yaml         # test overlay over compose.source.yaml
  compose.yaml              # operator example pulling a release image
  .env.example              # sole source for launcher/operator .env
docs/                       # product, architecture, self-hosting and evidence
flux                         # root one-command launcher for #72
scripts/                    # repo-level checks and launcher implementation
.github/, .agents/, AGENTS.md, README.md, LICENSE
```

Place `app/` at the repository root rather than adding another workspace above
it. Keep package names and import direction from [architecture.md](architecture.md)
stable. `app/.env.example` documents application variable names for contributors;
it is never loaded by Compose or copied to a live `.env`. `docker/.env.example`
is the sole executable template. The root `./flux` launcher creates
`docker/.env` once from it with generated secrets, never overwrites it, and
passes `--env-file docker/.env` explicitly. An intentional shell export may
override a file value under Compose precedence; the launcher should otherwise
avoid exporting competing defaults. Operator installation copies the release
template beside its downloaded Compose file. Neither path loads `app/.env`.
#76 must check that shared variable names and descriptions stay in sync between
the two examples; only the Docker template supplies live values.
No secrets are copied into images. `docker/compose.yaml` must have no `build:`
stanza and must select a versioned `ghcr.io/coldphase/flux` image by digest.
One image can run server, worker and the one-shot migration entry point at the
same revision, as O-002 already requires.

| Command or audience | Compose input | Required behavior |
| --- | --- | --- |
| `./flux up` and `./flux demo`, including a fresh pre-release clone | `docker/compose.source.yaml` | Build the checked-out source into the production-mode image; migrate, start API/worker and then seed demo only on request. `demo` remains development-only and uses the public API. Does not depend on a published GHCR image. |
| `./flux dev` | `docker/compose.source.yaml` plus `docker/compose.dev.yaml` | Use the same dependencies and isolated volumes, with source bind mounts (`:z` on SELinux) and hot reload. Do not modify production data. |
| `scripts/check_application.sh`, `scripts/check_runtime.sh` | `docker/compose.source.yaml` plus `docker/compose.test.yaml` where test services are needed | Build from source with unique Compose project, ports and volumes; preserve `scripts/test_images.sh` image cleanup after each run. Runtime check can use the source file alone for its normal services. |
| `scripts/check_ui.sh` | `docker/compose.source.yaml --profile ui` | Build the source image and `ui-test` from `docker/ui-tests.Dockerfile` with `app/` as context, start isolated app/mail services, then run `app/tests/ui`; keep screenshot output and per-project image cleanup working. |
| Operator after first accepted release | Downloaded `compose.yaml` plus matching `.env.example` from that GitHub Release | Pull only the image identified by the release digest; no source checkout, compiler or build context. The pre-release repository `docker/compose.yaml` is an example for the future release and is **not** the `./flux up` default. |

For every source-built and operator image, the runtime working directory is the
application workspace root (`/app` in the container, corresponding to repository
`app/`). #76 must preserve this invariant for the SQL migration directory and
static web bundle, including in hot-reload mode, or replace both cwd-relative
lookups with module-relative paths and test them. The Dockerfile builds with
`app/` as context, compiles `app/tooling/migrate.ts` via
`app/tooling/tsconfig.build.json`, copies its output to `tooling/dist`, and runs
`node tooling/dist/migrate.js`; SQL stays in `packages/db/migrations`. The icon
script header, build paths, both root and web TypeScript configurations,
`app/tests/ui/requirements.txt`, `.dockerignore` (now scoped to
the `app/` build context), and architecture scanner must move with the workspace.
The scanner must cover `app/tooling/` as an entry-point layer without adding
new core exemptions. The root `./flux` must use paths relative to its own
file, so invocation from another shell directory still finds `docker/.env` and
the selected Compose files. When #76 lands, update the source start example in
`docs/product/playbook-the-5.md` §6 to this mapping.

Considered alternatives: (1) keep the accepted root pnpm plus `infra/` and only
repair docs and dependency boundaries: least merge risk, but leaves application
configuration across the contributor root against the founder's requested
navigation; (2) keep root pnpm but rename `infra/` to `docker/`: smaller move,
still splits the application build contract across root files; (3) add a root
pnpm umbrella above `app/`: duplicates workspace responsibility without a
current need. The chosen layout has higher path churn and Docker context cost;
therefore #76 must land only in bounded, tested PRs after the decision, while
unrelated feature delivery continues.

## Proposed O-002 and O-004 amendments

**O-002:** keep the accepted stack, runtime services, package responsibility and
transactional boundaries. Replace the paragraph fixing root pnpm and
`infra/compose.yaml` with the target above. The decision changes physical
placement and deployment entry points, not public HTTP contracts, data schemas
or application behavior. The `core`/adapter refactor remains #46 work.

**O-004:** keep the accepted complete-application release gate. Specify one
explicitly triggered final build from the accepted protected-main SHA, producing
an OCI image in GHCR for `linux/amd64` and `linux/arm64` (both must be built and
installed before calling either supported). Publish a `vX.Y.Z` tag under a Flux
**never-retag policy**, record the manifest digest and source SHA, plus an optional
convenience tag that is never the documented install target. GHCR tag immutability
is not assumed; the digest is the installation identity. Enable GitHub immutable
Releases if available and verify the setting before publication. Attach
release-matched `compose.yaml`,
`.env.example`, install/upgrade/backup/restore instructions, SHA-256 checksums,
dependency notices/SBOM and provenance to the GitHub Release. Sign image and
provenance if the publishing environment supports verified identity; record any
gap before publication. The Compose asset selects that exact version/digest,
including matching API, worker and migration command. Test the downloaded
assets and image, not only a source checkout. Preserve O-002's stopped-writer,
same-revision migration and consistent PostgreSQL/files backup policy; specify
the previous image and backup pair for rollback. A forward schema migration is
not assumed reversible.

Publication of `@flux/contracts`, `@flux/sdk` or other npm packages is outside
#77 until the dependency and notice review in [licensing.md](../product/licensing.md)
has its own accepted distribution contract.

Do not include a Helm chart in the first public release. A chart adds values,
secrets, upgrade hooks, storage and compatibility paths that must be tested for
every version and platform. The required k3s/live collaboration deployment
evidence in [milestone 2](../product/milestones/02-working-application.md)
remains; #63 owns that operational path and may use bounded manifests. If k3s
testing shows a maintained chart is the simplest reproducible distribution,
create an owned chart issue with version mapping to the OCI digest, storage,
secret and upgrade tests before publication. This decision should be revisited
when k3s operators need repeatable multi-instance installation or maintained
manifests become costlier than a chart.

## Migration and verification gates

1. **Decision:** peer-review this proposal at an exact SHA. Amend O-002/O-004
   only after acceptance; #75 stays open until links and any refined #76/#77
   contracts are recorded. #46's source boundary work can continue now.
2. **Application workspace (#76, owner @Zamojski5):** move root pnpm, TS,
   ESLint, env, `apps/`, `packages/`, application tests and the external-agent
   example together. Place `tests/ui/` under `app/tests/ui/`. Update both
   root and web `tsconfig` includes/excludes, workspace globs, package
   scripts, import scanner roots, license/NOTICE paths and Docker build COPY
   paths in the same PR. Keep root agent/document checks working. Verify frozen
   lock install, build, typecheck, lint, unit/integration and browser checks in
   Docker. Preserve active branches; use a fresh migration branch from current
   main and rebase dependent PRs only with their owners.
3. **Docker/deployment (#76 with #72):** move Dockerfile and source/dev/test
   Compose to `docker/`; relocate migration entry and build config to
   `app/tooling/` and change runtime command; create pull-only operator Compose.
   Update
   `scripts/check_application.sh`, `scripts/check_runtime.sh`, README,
   `scripts/test_images.sh`, `scripts/check_ui.sh`,
   `scripts/check_contrast.py`, the icon-generation instructions,
   `docs/development/containers.md`, `docs/design/app-shell/README.md`,
   CI paths, ignore rules and root `./flux`. `docker/ui-tests.Dockerfile`
   must copy `tests/ui` from the `app/` build context; retain the `ui` profile
   and its Mailpit dependency in the source Compose file.
   Preserve the `/app` working-directory invariant, the environment templates'
   separate roles and the command-to-Compose mapping above.
   Confirm `docker compose config`, clean clone build/migrate/start, isolated
   test volumes/ports, restart, persisted data and rollback by restoring the
   pre-move image/config. On unavailable macOS/SELinux hosts, report those
   checks as unverified for #76 rather than treating Linux as proof.
4. **Distribution (#77, owner @PelikanFix16):** after the completed candidate and
   integrated acceptance, build both image platforms from one SHA, test clean
   install, forward upgrade and coordinated backup/restore from downloaded
   assets. Verify digest, checksums and source mapping before publication.

Rollback for each layout PR is a Git revert plus the previous Compose invocation;
no data migration belongs to a path-only PR. If the source move changes runtime
behavior or requires schema change, stop and split that change with its own tests
and migration/restore plan. #75 does not authorize closing #46, #72, #76 or #77.
