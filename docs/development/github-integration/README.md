# GitHub App connection

**2026-10-05:** [G-1](2026-10-05-app-and-task-rules.md) (proposed, #266 item 12) keeps the
read-only App and adds rules by which linked PRs move the same Flux task, one-click App setup,
polling for instances without public HTTPS, and suggested links found in PRs.

This is the first implementation slice of [#74](https://github.com/ColdPhase/flux/issues/74).
Repository bindings and verified task/PR references are implemented under each
reader's own GitHub authorization. G-1a task rules ("Let linked PRs move this task") are implemented as recorded in
[G-1 §2a](2026-10-05-app-and-task-rules.md#2a-g-1a-as-implemented). Local-agent delivery, external review publication,
polling without public HTTPS, manifest setup and portable import recovery remain pending (the project export already lists bindings and rules dormant, see `docs/operations/export.md`). Fixture checks do not
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
