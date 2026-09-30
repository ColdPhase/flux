# GitHub App connection

This is the first implementation slice of [#74](https://github.com/ColdPhase/flux/issues/74).
Repository bindings and verified task/PR references are implemented under each
reader's own GitHub authorization. Native task rules, local-agent delivery,
external review publication and portable export/import recovery
remain pending. Fixture checks do not complete the whole issue.

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

## Project settings and recovery

A manager opens **Details → GitHub repositories**, authorizes their own GitHub
account, installs the App if needed and explicitly selects an installation and
repository. These are distinct steps. Newly installed repositories never expand
Flux bindings. Each reader authorizes their own GitHub account. A Flux-only
member cannot read even cached private repository names or PR facts.

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
facts enter ordinary tasks, discussions, notifications, events or exports.

Run source and SQL/API checks in Docker with `./scripts/check_application.sh`.
`app/tests/app/github.test.ts` injects typed provider transport fixtures; these are
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
