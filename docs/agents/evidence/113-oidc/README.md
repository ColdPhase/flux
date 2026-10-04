# Operator OIDC single sign-on and one message per mailbox: partial #113 evidence

Tested source: `3a482040e14200c8d6d3081072aeaa685032b049` (branch
`claude-maurycy/113-oidc-login`, PR [#240](https://github.com/ColdPhase/flux/pull/240), with
`origin/main` `24f49522` merged in). Run on 2026-10-04 on the author's host (Docker Desktop,
macOS). Owner: Zamojski5. These are the author's raw logs for the independent reviewer, not an
approval. [Binding amendment](https://github.com/ColdPhase/flux/issues/113#issuecomment-5975870796),
[operations guide](../../../operations/single-sign-on.md).

The only commits after the tested one add this folder (documentation, no code).

## Executed checks

| Command | Result | Raw log |
| --- | --- | --- |
| `FLUX_OIDC_TEST_PORT=19000 ./scripts/check_oidc.sh` | exit 0. `oidc.e2e.ts` 10/10, `oidc-bad-token.e2e.ts` 6/6, `api-mock refused 8 ID tokens in its verifier`, restart prepare 1/1, API restart, verify 1/1. No skips or cancellations. | [check-oidc.txt](check-oidc.txt) |
| `targeted.sh` with `FLUX_TEST_PORT=19002 FLUX_TEST_MAILPIT_PORT=19003` on `tests/app/{identity-config,identity,notifications,notifications-core,notification-inbox,architecture,oauth-flow}.test.ts` | exit 0, 75/75 tests in 13 suites (the image build runs `pnpm build && pnpm typecheck && pnpm lint`; one existing lint warning in `ProjectTasks.tsx`, from `main`). | [targeted-identity-notifications.txt](targeted-identity-notifications.txt) |
| `python3 scripts/check_agent_setup.py`, `python3 -m unittest discover -s tests -p 'test_*.py'`, `git diff --check origin/main...HEAD` | exit 0; 67/67 standard-library tests. | [foundation.txt](foundation.txt) |
| `docker ps -a`, `docker volume ls`, `docker network ls`, `docker images` filtered on both run projects (named in the logs: oidc run 1791114824-93108, test run 1791114985-94045) | nothing left. Each script also prints its own `down -v` and "Removed N per-run image(s)". | [cleanup.txt](cleanup.txt) |

`targeted.sh` is a local reviewer helper, not in the repository. It sets the same environment as
`scripts/check_application.sh` (per-run secrets, VAPID keys, `FLUX_TEST_FAILURE_INJECTION=true`,
`FLUX_AUTH_RATE_LIMIT=false`, `FLUX_STREAM_HEARTBEAT_MS=1000`), builds and starts the
`docker/compose.source.yaml` + `docker/compose.test.yaml` `--profile test` stack, runs
`files-init`, then `run --rm test node_modules/.bin/tsx --test --test-concurrency=1` with the
seven files above, and finally `down -v` and removes the run's images. Both runs used their own Compose project, volumes and loopback ports.

Pinned images: Keycloak `quay.io/keycloak/keycloak:26.7.5@sha256:37dbaf6f0722c9ec246335f36e1ef8b2e6cb960f7c27e0d8c615121a3d475a85`, Mailpit
`axllent/mailpit:v1.31.2@sha256:74d609a42ec279aa63c6b4622a6fa9b5408d1ad5b1d76a1c4be40a265ce0863d`, Playwright
`mcr.microsoft.com/playwright:v1.63.0-noble@sha256:eff16c30e6f3f4af0a03fa4b706120d5e9b0891c344a27d64559aff5900a4a27`, Node and PostgreSQL by digest
in `docker/Dockerfile` and `docker/compose.source.yaml`. The mock provider adds no image: it runs
`tests/app/support/oidc-mock.ts` from the run's own e2e test image. Better Auth is the pinned
1.7.6 of the lockfile.

## What the new tests prove

**Bad ID tokens on the genuine callback** (`app/tests/app/e2e/oidc-bad-token.e2e.ts`). A
deterministic mock provider (discovery, JWKS, `/authorize` checking PKCE S256, state, nonce and
the registered redirect URI, `/token` checking client authentication and the PKCE verifier) and a
second API replica (`api-mock`, same database, provider = the mock) are started by
`check_oidc.sh`. Every case is the real browser flow through the sign-in button, the provider and
`/api/auth/callback/<provider id>`; the test also checks that the browser hit the callback with a
code and state, and that the API exchanged the code at the token endpoint and sent a nonce.

- Control: a valid token signs Erin in, keyed by the mock's provider id and her `sub`; she
  creates a workspace and verifies a private notification address.
- For a wrong nonce, a signature by another key under the published key id, another issuer and
  another audience, two attempts each: Erin's existing subject with a changed email, and a new
  subject claiming Erin's verified private address as its email. Each ends on
  `/sign-in?sso=failed` with "Single sign-on didn’t complete", `/me` and `/workspaces` 401, and a
  before/after snapshot of `auth_users`, `auth_accounts`, `auth_sessions`, `workspace_members`,
  `project_grants` and `notification_addresses` is identical (no session, no linking or changed
  account, no grants, no address transfer). The token claims show only the one property is
  wrong. The script then requires 8 `id_token failed verification` lines in the replica's log.
- Afterwards a valid token still signs in the same Erin with her grant and verified address, and
  the provider's issue log is exactly `valid`, 2 × each bad mode, `valid`.

**Real-SSO journeys with Keycloak** (`app/tests/app/e2e/oidc.e2e.ts`, new tests 3–5; the earlier
seven are unchanged):

- Mail choices: after Alice's BOTH, three phases give Alice account only, extra only and none
  (in-app only), and Bob extra only, both and account only. Each phase checks the in-app record
  for both people and the exact count in all four mailboxes (Alice's and Bob's account and
  private addresses), so neither private address receives the other person's mail. The notices
  are the generic subject addressed to the mailbox that received them.
- Cross-person isolation: Bob adds Alice's verified private address as his own. It stays
  unverified for Bob, the verification link goes to that mailbox, Alice's session cannot verify
  it (400), Alice's address stays verified, and Bob's notifications with destination "extra"
  never reach it. Flux has no rule refusing an address another person verified; the test proves
  the isolation the design provides (proof of mailbox control, scoped to the account that added
  it).
- Sessions and links: a second Alice SSO session is revoked from the first (`DELETE
  /api/v1/sessions/:id`) and gets 401 on `/me`, inbox, preferences and workspaces at once. The
  `/inbox/<id>` link from a real Mailpit message opens the message for Alice, shows "This is not
  available to you" to Bob (API 404), sends the revoked and a cookieless browser to
  `/sign-in?next=/inbox/<id>`, where SSO leads back to the message, and stops opening once Bob
  removes Alice from his workspace (API 404). After sign-out Alice's mail reaches only her own
  private address, once, and a new SSO sign-in is the same person with her grants and verified
  address.

**One mailbox after enqueue** (`app/tests/app/notifications.test.ts`, two new tests; the earlier
"retries never send an email twice", including the uncertain `sending` case, is unchanged):

- Both copies are queued by the real generator and held by quiet hours (both pg-boss jobs exist
  with a later start), then the account email is changed to the upper-cased private address.
  A real SMTP refusal (a catcher that requires STARTTLS) puts the account copy back to queued;
  its retry and the extra copy then run concurrently: one `sent`, one skipped as "this mailbox
  already gets this notification", later redeliveries are `already sent/skipped`, exactly one
  SMTP acceptance is counted, and Mailpit holds exactly one message for that mailbox (counted
  case-insensitively).
- With the account copy at the SMTP server, the extra copy is claimed and skipped; the server
  then refuses, the account copy is queued again and its retry sends the one message. An
  uncertain send (SMTP accepted, then the worker died before recording it) leaves the copy
  `sending`: neither its sibling nor its own retry sends again. One acceptance per notification.

## Not covered

SAML, SCIM, several providers, a production provider's own policies, real devices. If a copy
that took over a shared mailbox later fails for good or stops being chosen before its retry, its
sibling, already skipped, does not send instead: no duplicate, but that notice is not emailed.
#113 stays open for its remaining criteria.

## Hashes

| File | SHA-256 |
| --- | --- |
| check-oidc.txt | `17d82ddadcd7948bd763aa57b84b9870d0b675db0fcaa46bdf099124398752bb` |
| targeted-identity-notifications.txt | `759538e3ccf3cbbc39bbb0ab56580be0be02f9cae35bf0e311929a3aa52d760f` |
| foundation.txt | `8062de2d3a0a168f098b674ec32efad34be32df802b45374fd7ed4478f42747e` |
| cleanup.txt | `c05ac444289e7ca800019609b1763d4eb61d5ed3be808a6c6b4ac474b3072d2a` |
