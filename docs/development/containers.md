# Container development

Founder decision, 2026-09-27: **the application and its dependencies run in
Docker/Compose**. Do not install PostgreSQL, Redis, queues, or application
toolchains as services on a contributor's host.

## Contract for the selected application stack

The architecture and first application setup task must supply:

- Reviewed Dockerfiles and a Compose configuration for application services,
  development tooling, and any database/queue actually selected.
- A documented clean start, dependency installation, migration, fixture/seed,
  lint/type/test, build, stop, backup, and restore workflow using containers.
- Locked dependencies, reviewed base images, health checks, and deterministic
  readiness. Starting a container is not proof that its service is ready.
- Named persistent volumes, example configuration without real credentials,
  and documented ownership of data. Never delete volumes or reset a shared
  database to fix a test without explicit authorization for those data.
- Separate Compose project names per worker/task, isolated data and test accounts,
  and nonconflicting published ports. Avoid fixed container names that collide.
- The same container commands in GitHub Actions; no CI-only hidden host database
  setup or claim that a host-only test proves the supported installation works.
- Release builds from the accepted source revision, appropriate container image
  or other agreed deliverables, and installation/update/restore verification.

The [accepted O-002 architecture](../product/application-architecture-proposal.md)
selects PostgreSQL. The first application foundation in `infra/compose.yaml`
starts PostgreSQL, a one-shot migration, the API and a separate worker with named
`pgdata` and `files` volumes. See [application foundation](application-foundation.md)
for the current clean-start, validation and backup/restore commands. This is an
application skeleton; #29's identity/session and project policy slices are now
merged, while collaboration and release verification remain separate tasks.

The `files` mounts on `files-init`, API and worker all use `:z` so SELinux gives
the shared volume a label accessible to both running services. `files-init`
still sets ownership for their non-root UID; all three mounts must keep the
shared label option or one container can deny another's writes on SELinux hosts.

## Local task worktrees

Keep each task or independent review in its own Git worktree under the repository
root's `.worktrees/` directory, for example
`git worktree add .worktrees/54-local-layout -b codex-hubert/54-local-layout main`.
The root-anchored [ignore rule](../../.gitignore) keeps these machine-local
checkouts out of ordinary `git status`; it does not remove or hide tracked
source. Existing worktrees stay in place. Use `git worktree list` to inspect them
before any cleanup and never delete another agent's checkout or uncommitted work.
One issue has one assignee and its branch has one writer; see the
[agent workflow](../agents/workflow.md#4-implement-and-hand-off).

Run concurrent application checks with a distinct Compose project name,
published port values, volumes and test accounts per task. For example, use
`-p flux54-hubert` with a task-specific `FLUX_TEST_PORT` instead of reusing the
default test project or another worker's persistent volumes. The
[application foundation guide](application-foundation.md) has the current
Compose commands; the worktree location does not change their container-only
runtime requirement.

### Launcher and development mode

`./flux` at the repository root wraps these Compose commands for people: `up`
(generated `.env`, build, migrate, start), `demo` (development seed through the public
API), `dev` (hot reload with source bind mounts via `infra/compose.dev.yaml`, `:z`
labels, separate `<project>-dev` volumes), `down`, `logs`, `reset` and `clean`. See
[application foundation](application-foundation.md#one-command-start-flux-issue-72).
`./scripts/check_flux_cli.sh` tests it with its own project names, ports and image tags
and removes them afterwards; set `FLUX_CLI_TEST_PORT`, `FLUX_CLI_TEST_DEV_PORT` and
`FLUX_CLI_TEST_MAILPIT_PORT` for concurrent runs. `./flux clean` removes only the
`flux-*` images tagged with its own project names; the build cache advice below applies.

### Disk hygiene

Each `scripts/check_*.sh` run builds images tagged with its own Compose
project (`flux-foundation:<project>`, `flux-test-tools:<project>`,
`flux-e2e:<project>`, 0.6–4 GB each). After `down -v`, the cleanup trap removes
exactly those tags and prints how many it removed, on success or failure. It
never removes base images, other projects' tags such as
`flux-foundation:flux-demo`, or the shared build cache. Set
`FLUX_KEEP_TEST_IMAGES=1` to keep a run's images for debugging, then remove
them yourself with `docker image rm`. Incident, 2026-09-27: before this cleanup,
about 60 leftover images and 62 GB of build cache filled a developer disk
([#71](https://github.com/ColdPhase/flux/issues/71)).

The build cache speeds up every worker's next build, so the checks do not prune
it. Check usage with `docker system df` and, when it grows large on your own
machine, run `docker builder prune --filter until=72h` (or
`docker builder prune -a` when no concurrent checks are running). Remove
leftovers from older or interrupted runs with
`docker images --format '{{.Repository}}:{{.Tag}}' | grep -E '^flux-[a-z-]+:flux-(test|runtime)-'`,
then `docker image rm` on the tags you confirm are not in use.

Git, Docker/Compose, GitHub CLI, the installed official coding-agent CLIs, and
Python 3.11+ for this repository's standard-library foundation checks are host
tools. Those checks are separate from the Flux application's runtime and do not
require installing an application toolchain.

The existing static HTML prototype can still be opened directly in a browser.
It is historical exploration material and is not the application environment.

## Identity services and variables

Human login (issue #29) uses Better Auth inside the API container, on the same
PostgreSQL database (migration `0002_identity.sql`). Sessions are rows in
`auth_sessions`, so they survive an API restart; a revoked session fails on the
next request. The API reads these variables (see `.env.example`):

| Variable | Meaning |
| --- | --- |
| `FLUX_PUBLIC_ORIGIN` | Required. The exact origin people open, e.g. `https://flux.example.org`. It is the only origin accepted for state-changing browser requests and the base of mailed links. `Host` and `X-Forwarded-*` are never used to derive it. An `https` origin makes cookies `Secure` with the `__Secure-` prefix. Plain `http` is accepted only for loopback development (`localhost`, `127.0.0.0/8`, `[::1]`); any other `http` origin stops the API at startup. |
| `FLUX_AUTH_SECRET` | Required, at least 32 random characters. Signs session cookies; changing it signs everyone out. |
| `FLUX_TRUSTED_PROXIES` | Comma-separated proxy IPs/CIDRs. Only a request whose socket peer is listed may supply `X-Forwarded-For` as the client address. Empty (default) trusts no proxy. |
| `FLUX_SMTP_URL`, `FLUX_MAIL_FROM` | SMTP transport URL (e.g. `smtp://user:pass@mail.example.org:587`) and sender for password reset mail. If unset, password reset answers `503 PASSWORD_RESET_UNAVAILABLE` and `/api/v1/auth/capabilities` reports `unavailable`. |
| `FLUX_PASSWORD_RESET_TTL_SECONDS` | Reset token lifetime, 60–86400, default 3600. Tokens are single use and stored hashed. |
| `FLUX_AUTH_RATE_LIMIT` | `true` (default) enables Better Auth's in-memory login rate limit. Only the test script turns it off. |
| `FLUX_STREAM_HEARTBEAT_MS` | WebSocket stream ping, session revalidation and polling interval in milliseconds (default `25000`, minimum `100`). The test script uses `1000`. See [access policy](access-policy.md#websocket-stream). |

For development, the `dev` Compose profile adds a local mail catcher
(Mailpit, pinned by digest). Set `FLUX_SMTP_URL=smtp://mailpit:1025` and a
`FLUX_MAIL_FROM` in `.env`, then open the caught mail at
`http://127.0.0.1:${FLUX_MAILPIT_PORT:-8025}`:

```sh
docker compose --env-file .env -p flux28 -f infra/compose.yaml --profile dev up -d --build
```

Endpoints: Better Auth under `/api/auth/*` (`sign-up/email`, `sign-in/email`,
`sign-out`, `request-password-reset`, `reset-password`); Flux session routes
`GET /api/v1/me`, `GET /api/v1/sessions` (never returns tokens),
`DELETE /api/v1/sessions/:id` and `POST /api/v1/sessions/revoke-others`.
Server code resolves the caller with `requirePrincipal(request)` from
`apps/server/src/identity`, which maps the session user to a `human` `Principal`.

`./scripts/check_application.sh` runs the identity suite in the `test` profile
against the running API and mail catcher, including a session check across
`docker compose restart api`. Set `FLUX_TEST_PORT` / `FLUX_TEST_MAILPIT_PORT`
to avoid port clashes with another concurrent run.

## PWA and Web Push

Issue #41 adds the installable shell and the Web Push foundation. The API serves
`/manifest.webmanifest`, icons under `/icons/`, `/offline.html` and the service
worker `/sw.js` (scope `/`, `Cache-Control: no-cache`) from the same origin as
`/api/v1`. Hashed `/assets/*` are `immutable`; HTML, manifest and icons revalidate.
Browsers only run service workers and push in a secure context: `https://`, or
`http://localhost`/`127.0.0.1` for development.

The service worker is hand-written (`apps/web/src/pwa/sw.js`) and emitted by a
small Vite plugin (`apps/web/build/service-worker-plugin.ts`) that injects the
precache list and a content-hash version; there is no Workbox dependency. It
precaches the built shell, answers navigations network-first with the offline
page as fallback, and never handles `/api/*`. A new version installs and waits;
the page shows "A new version of Flux is available — Reload", and only that
choice activates it. Placeholder icons are regenerated with
`apps/web/scripts/generate-icons.ts` (usage in the file header).

| Variable | Service | Meaning |
| --- | --- | --- |
| `FLUX_VAPID_PUBLIC_KEY` | API, worker | Base64url P-256 public key given to browsers as `applicationServerKey`. Empty on the API means `GET /api/v1/push/public-key` and `POST /api/v1/push/subscriptions` answer `503 PUSH_UNAVAILABLE`. |
| `FLUX_VAPID_PRIVATE_KEY` | worker only | Signs the VAPID JWT. Keep it secret; it never reaches the API container. |
| `FLUX_VAPID_SUBJECT` | worker only | Operator contact for push services, `mailto:` or `https:`. |
| `FLUX_PUSH_ALLOW_PRIVATE_NETWORK` | worker | `false` by default: the worker refuses push endpoints that resolve to private, loopback or link-local addresses at connect time. Only the test override sets `true` for its local push mock. |

The worker requires all three VAPID values together, checks that the public key
matches the private key and stops at startup otherwise. Generate a key pair once
per deployment with the pinned `web-push` CLI in the built image and copy both
values into `.env`:

```sh
docker compose --env-file .env -p flux28 -f infra/compose.yaml run --rm --no-deps -T migrate \
  apps/worker/node_modules/.bin/web-push generate-vapid-keys --json
```

**Rotation and recovery.** Browser subscriptions are bound to the public key they
were created with. Back up the key pair with the other secrets; restoring it keeps
existing subscriptions working. After a deliberate rotation (suspected leak) or a
lost key, deploy the new pair to API and worker together. Push services then reject
old subscriptions (typically 403); the worker records the failure on the row and
does not retry. The web client compares its subscription key with the server key
on start (`syncPushSubscription`) and re-subscribes without a prompt when
permission is still granted; devices that stay closed miss pushes until then, and
the inbox still has every notification. Rows answering 404/410 are deleted.

Outbound access: the worker must reach the browser push services over HTTPS, for
example `fcm.googleapis.com` (Chrome/Android), `*.push.apple.com` (Safari, iOS and
iPadOS home-screen apps), `*.push.services.mozilla.com` (Firefox) and `*.notify.windows.com` (Edge on Windows).

Endpoints, all resolved with `requirePrincipal` and limited to the caller's rows
(another user's id is `404`): `GET /api/v1/push/public-key`,
`GET|POST /api/v1/push/subscriptions` (idempotent per endpoint; a browser that
signs in to another account moves its subscription to that account),
`DELETE /api/v1/push/subscriptions/:id`, `GET /api/v1/inbox?limit=`,
`GET /api/v1/inbox/:id` and `POST /api/v1/inbox/:id/read`.

**Audience.** Every notification names its source (`workspace`, `project` or
`draft`, with its `workspace_id`). Server code creates one with `createNotifier(db,
boss)` from `apps/server/src/push` (the core use case `createNotification`): the
recipient must be allowed `<type>.read` on the source at that moment, otherwise
nothing is stored (`404 SOURCE_NOT_FOUND`). The inbox list and unread count apply
the access policy's `visibleFilter` per workspace, and `GET`/`POST .../:id` call
`authorize` again, so a revoked grant, an explicit deny, a draft made private or
removal from the workspace hides the row (`404`) until access returns. The row is
stored in the same transaction as one `push.send` job per subscription with an
active session (5 retries, exponential backoff up to 10 minutes, for
429/5xx/network errors).

**Device sessions.** Each subscription stores the Better Auth session that created
it (`session_id`, foreign key `ON DELETE CASCADE`). Sign-out, revoking a session,
revoke-others, password reset (which revokes all sessions) and account deletion all
delete the session row, and with it that device's subscriptions, whichever code path
ends the session. The web client also unsubscribes before signing out
(`signOutDevice`). After signing in again, the client's start-up sync re-registers
the browser subscription under the new session.

**Before each send** the worker rechecks from current rows that the account still
owns the subscription and the notification, that the subscribing session exists and
has not expired (otherwise the subscription is deleted), and that the recipient can
still see the source through the access policy (otherwise the job completes without
sending). The lock-screen rule in [mobile-pwa.md](../product/mobile-pwa.md#lock-screen-privacy)
decides what the payload may contain.

**Layers (#46).** `packages/core/src/push` holds the use cases and their ports
(`NotificationRepository`, `PushSubscriptionRepository`, `JobQueue`,
`NotificationUnitOfWork`, `PushDeliveryRepository`, `PushSender`,
`SourceReadAuthorizer`) and imports no Drizzle, `@flux/db`, pg-boss or web-push;
`tests/app/architecture.test.ts` enforces that transitively. Drizzle row adapters
are in `packages/db/src/repositories/push.ts`, the policy adapter is
`policySourceReader` in `packages/core/src/access`, and the server (routes,
inbox filter, pg-boss queue, transaction) and worker (web-push sender) assemble them.

`./scripts/check_application.sh` layers `infra/compose.test.yaml` over the base
file: a local HTTPS push-service mock that verifies the VAPID signature and records
the encrypted body (the test decrypts it), fresh VAPID keys per run, a Chromium
check through an HTTPS proxy (registration and control, offline fallback,
update prompt) and a final API run without keys. Do not use that override
outside tests.

## Web app and browser tests

The web app (`apps/web`, React 19 + React Router 8 Data Mode, built by Vite into the API
image) is served by the API on the same origin. Its design tokens and components are
described in [the app shell record](../design/app-shell/README.md).
`python3 scripts/check_contrast.py` checks token contrast without Docker.

`./scripts/check_ui.sh` builds the image (which runs build, typecheck and lint), starts the
stack in its own Compose project on `127.0.0.1:${FLUX_UI_PORT:-18591}` with Mailpit, and runs
`tests/ui` (copied into the image, `unittest discover`) in a Playwright 1.62 container (`infra/ui-tests.Dockerfile`, image pinned by
digest, Python client pinned by hash). Inside that container the browser opens the
loopback `FLUX_PUBLIC_ORIGIN`, which a small forwarder carries to the API service, so origin
checks and cookies behave as on the host. It takes about two minutes after the first image
build. Set `FLUX_UI_SCREENSHOT_DIR` to an absolute path (for example
`"$PWD/docs/design/app-shell"`) to save screenshots, and `FLUX_UI_PORT` /
`FLUX_UI_MAILPIT_PORT` to avoid clashes with a concurrent run. It is kept separate from
`check_application.sh` so the PR check stays fast.
