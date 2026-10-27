# GitHub App connection

**2026-10-05:** [G-1](2026-10-05-app-and-task-rules.md) (proposed, #266 item 12) keeps the
read-only App and adds rules by which linked PRs move the same Flux task, one-click App setup,
polling for instances without public HTTPS, and suggested links found in PRs.

This is the first implementation slice of [#74](https://github.com/ColdPhase/flux/issues/74).
Repository bindings and verified task/PR references are implemented under each
reader's own GitHub authorization. G-1a task rules ("Let linked PRs move this task") are implemented as recorded in
[G-1 §2a](2026-10-05-app-and-task-rules.md#2a-g-1a-as-implemented). Local-agent delivery, external review publication,
polling without public HTTPS, manifest setup and portable import recovery remain pending (the project export already lists task rules dormant and withholds repository bindings, see `docs/operations/export.md`). Fixture checks do not
complete the whole issue.

## Operator configuration

Create a GitHub App for this Flux instance. Configure its authorization callback
and post-installation setup URL as
`<FLUX_PUBLIC_ORIGIN>/api/v1/integrations/github/callback`, with the origin equal
to the configured public Flux origin. GitHub must reach the public HTTPS webhook
at `<FLUX_PUBLIC_ORIGIN>/api/v1/integrations/github/webhook`. Loopback development
is not real webhook installation evidence. Keep authorization separate from App
installation; do not enable automatic user authorization during installation.

Use repository permissions **Metadata, Pull requests, Checks and Commit statuses:
read-only**. Add **Issues: read-only** to subscribe to PR conversation comments
(`issue_comment`): GitHub requires this event permission even though Flux never
imports or synchronizes GitHub issues. The installation verifier rejects all
write permissions. No organization/account permissions or App private key are
needed by this user-token slice. Enable expiring user tokens and PKCE S256.

Subscribe to `pull_request`, `pull_request_review`, `pull_request_review_comment`,
`issue_comment`, `check_run`, `check_suite` and `status`. Installation and user
revocation stop authority; additions never create bindings. Signed `ping` is
admitted without authority. The read-only profile supports check-run created and
completed and check-suite completed, excluding write-only requested actions.
Use JSON delivery and a random webhook secret with at least 32 characters.

Set all six optional instance values, then restart the API:

| Value | Meaning |
| --- | --- |
| `FLUX_GITHUB_CLIENT_ID` | App OAuth client ID |
| `FLUX_GITHUB_CLIENT_SECRET` | App OAuth client secret; server only |
| `FLUX_GITHUB_APP_ID` | Positive decimal App ID, not installation ID |
| `FLUX_GITHUB_APP_SLUG` | App URL slug from its settings |
| `FLUX_GITHUB_WEBHOOK_SECRET` | The configured webhook HMAC secret |
| `FLUX_GITHUB_ENCRYPTION_KEY` | Random 32-byte key as 64 hex characters |

Development and packaged Compose pass these only to the API. All empty means
the page reports GitHub unavailable. Partial/invalid configuration fails startup.
Keep the encryption key with protected backup secrets. Database credentials are
AES-256-GCM encrypted and bound to the Flux user, App and authorization generation.
Changing the key requires explicit reconnection; no token belongs in a model,
browser response, export or another user's row. After exact migrations, `./flux
restore` always revokes restored GitHub credentials, bindings and OAuth flows
before restarting writers. Original facts remain unavailable history; explicit
authorization and binding selection are required. Portable source import remains
pending; importing data must not restore active provider grants.

Credential envelopes also bind the configured OAuth client, verified GitHub user
and authorization generation. Changing that identity or upgrading an incompatible
old envelope requires explicit authorization again; current capabilities report
authorization required and no old repository facts are returned. Pending PKCE
flows reject a changed App/client/session/project before exchanging the code.
The integration does not silently reseal old credentials under new settings.

Permission-checked operations pin current credentials in their outer transaction
before repository-binding locks. Later provider reads reuse that exact capability.
GitHub-local PostgreSQL lock/statement timeouts cancel before the unchanged driver
deadline so rollback drains. Contended revocation may fail truthfully and require
retry; a failed action is never presented as completed or allowed to poison the pool.

## Project settings and recovery

A manager opens **Details → GitHub repositories**, authorizes their own GitHub
account, installs the App if needed and explicitly selects an installation and
repository. These are distinct steps. Newly installed repositories never expand
Flux bindings. Each reader authorizes their own GitHub account. A Flux-only
member cannot read even cached private repository names or PR facts.
A viewer who independently authorizes GitHub and still has repository access can
select a task and read its existing PR references; linking/managing controls remain
restricted to writers/managers.

Select an existing Flux task, binding, exact PR number and **Required output** or
**Related context**. The server verifies the actual PR and stable repository ID;
the number alone never correlates work. Original authors, current commits and
source/verification timestamps stay distinct. Checks are an execution hint; they
do not certify branch protection, eligible review or native task acceptance.

**Refresh access** clears private projections before checking again. A failed
provider check shows a non-sensitive error without cached facts. Disconnecting a
binding stops processing and retains internal history; disconnecting a person's
authorization stops their authorized bindings. A fresh authorization generation
requires explicit repository reconnection by a manager.

**Linked PRs move the same task (G-1a).** In task Details, a person who can edit the task turns on **Let linked PRs
move this task** and picks what happens once every required PR is merged: **Ready to close** (default when the task
has written criteria) or **Mark it done**. A manager can make that the project default for new required links.
- An open required PR starts the task, a failing check blocks it and checks passing again unblock it.
- A PR closed without merge blocks it. Done needs Complete mode, no written criteria, done prerequisites and passing
  checks on every merged head; otherwise the task shows Ready to close.
- A manual change of status or blocker pauses the rule until someone resumes it. So does losing the author's access
  or a required repository: disconnect, uninstall, removal from the installation, revoked authorization or restore.
  Re-binding never restarts it.
- Each automatic change appears in the task's history as "by GitHub rule · set up by <name>", with the PR, its
  head commit and the delivery or reconciliation behind it.
- Routes: `GET`/`PUT /api/v1/work/<taskId>/github-rule`, `POST …/github-rule/resume`, and `PUT
  /api/v1/projects/<projectId>/github/rule-default`. Viewers get 403 and people outside the project 404.
- Migration `0052_github_task_rules.sql` is additive.

Signed deliveries persist before 202. Restart-safe retries are per binding,
under current Flux/GitHub access, and fetch current provider state. Requests have
fixed origins, 10-second timeouts, 2 MiB bodies and bounded pagination.
`POST /api/v1/github/bindings/<bindingId>/reconcile` schedules known-link recovery
under current manager and repository authority; it is a local reconciliation,
not a fake provider event. Every 30-minute window, the API schedules known linked
objects in batches of five. Each job targets one binding; pending local work is
coalesced during an outage. No repository discovery scan or agent wake occurs.
Completed/irrelevant raw deliveries expire after seven days; pending deliveries
survive outages. Internal #153 bridge metadata remains undelivered until a
recipient/subscription adapter checks current repository access. No provider
facts enter ordinary discussions, notifications, events or exports. Native task status, blocker text and rule history
change only through a task rule a writer turned on (G-1a).

Run source and SQL/API checks in Docker with `./scripts/check_application.sh`.
`app/tests/app/github.test.ts`, `github-rules.test.ts`, `github-rules-core.test.ts` and the browser checks
`e2e/github.e2e.ts` and `e2e/github-rules.e2e.ts` inject typed provider fixtures; these are
not real installation evidence. Full acceptance needs a least-privilege test
App, public TLS callbacks and real PR/check/review/merge/duplicate/out-of-order/
access-loss/recovery evidence at the pinned head, plus all remaining native rule,
manual override and local-client outcomes.

Primary sources checked 2026-09-30:
[App user authorization/PKCE](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app),
[webhook permission requirements](https://docs.github.com/en/webhooks/webhook-events-and-payloads),
[comment API permissions](https://docs.github.com/en/rest/issues/comments?apiVersion=2026-03-10).
The [accepted design](2026-09-30-design.md) and
[independent conditions](2026-09-30-independent-design-review.md) govern this slice.

## What remains for #74 / #479 (reconciled 2026-10-23)

The merged slices are #168 (bindings, verified links, signed durable deliveries), #270 (G-1a rules), #379 (manual
override, rule revision, 0068) and #388 (dormant export). Everything below is still required and is not started or is
blocked on something outside the repository. The issue text and the design document number G-1b and G-1c the other
way round; this table uses the design document's labels ([G-1 §2](2026-10-05-app-and-task-rules.md#2-what-changes)).

| Remaining outcome | Issue criterion | State |
| --- | --- | --- |
| Real least-privilege App on public HTTPS: bind, PR/CI/review/merge, duplicate and out-of-order delivery, access loss and recovery | AC-1, AC-5 | Needs a registered test App and a reachable public HTTPS origin (external). No fixture counts as this. |
| G-1c polling for instances without public HTTPS (2-minute poll of linked open PRs, conditional requests, mode shown in Settings) | AC-3, AC-5 | Not started. Needs conditional-request support in the provider (ETag per endpoint) and a poll entry in the existing API sweep, under the same credential-pin and binding-lock order as `process`. |
| G-1b one-click App setup through the manifest flow | AC-1 | Not started. Needs encrypted storage of the returned App credentials and the six variables winning when set. |
| G-1d suggested links found in PR titles, branches and bodies | AC-2 | Not started. Needs a suggestion record, a one-tap confirm and the rule that an ID alone never links across bindings. |
| #153 current-recipient bridge, causal echo suppression, eligible once-only external review | AC-3, AC-5 | Not started. `bridge()` stores internal metadata only; `github_pr` references are refused as outcomes and responses until this adapter exists. Publishing a review needs a separately scoped write grant (the App is read-only by design). |
| Portable source history import | AC-3 | Proposal only; export lists rules dormant. |

### Primary sources re-read 2026-10-23

Observed on the pages named, today; "not stated" means the page did not say it. These confirm the profile this guide
already documents and change none of it.

| Fact the integration relies on | Source page | Observed |
| --- | --- | --- |
| User tokens from a GitHub App expire (8 hours) with a 6-month refresh token; PKCE is optional but strongly recommended and only `S256` is accepted; the token is the intersection of App and user permissions | [Generating a user access token](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app) | Matches. The page calls expiring tokens "currently an optional feature and ... subject to change". |
| Signature header `X-Hub-Signature-256`, `sha256=` HMAC of the raw body, constant-time comparison; the header is absent when no secret is set | [Validating webhook deliveries](https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries) | Matches. |
| GitHub does not redeliver failed deliveries on its own; a delivery fails after 10 seconds | [Handling failed deliveries](https://docs.github.com/en/webhooks/using-webhooks/handling-failed-webhook-deliveries) | Matches the reconciliation design. Retention of deliveries: not stated. |
| Event permissions: `pull_request`, `pull_request_review`, `pull_request_review_comment` need Pull requests read; `status` needs Commit statuses read; `check_run` and `check_suite` need Checks read (re-request types need write); `issue_comment` needs Issues read; `installation`, `installation_repositories` and `github_app_authorization` are always delivered; payloads over 25 MB are not delivered | [Webhook events and payloads](https://docs.github.com/en/webhooks/webhook-events-and-payloads) | Matches. `ping`: no permission stated. |
| Endpoint permissions: pull request and its reviews need Pull requests read, check runs need Checks read, combined status needs Commit statuses read, a user's installation repositories need Metadata read | [Permissions required for GitHub Apps](https://docs.github.com/en/rest/authentication/permissions-required-for-github-apps) | Matches. `GET /user/installations`: permission not visible in the page text read. |
| API version header `X-GitHub-Api-Version: 2026-03-10` is supported, end of support not scheduled; `2022-11-28` is the default without a header | [API versions](https://docs.github.com/en/rest/about-the-rest-api/api-versions) | Matches the version the provider sends. |
| A conditional request (`If-None-Match` with the stored `etag`) answers 304; an authorized 304 does not count against the primary rate limit; GitHub prefers webhooks over polling and asks pollers to honour `x-poll-interval` | [Best practices for the REST API](https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api) | Input for G-1c; no code uses it yet. |
| Manifest flow: POST the manifest (optional `state`), exchange the temporary code at `POST /app-manifests/{code}/conversions` within one hour; the page lists `id`, `pem` and `webhook_secret` in the result | [Registering an App from a manifest](https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest) | Input for G-1b. Whether the result carries `slug`, `client_id` and `client_secret`: not stated on that page; read the REST reference before implementing. |
