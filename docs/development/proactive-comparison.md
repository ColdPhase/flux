# Proactive comparison rule (#58, first implementation slice)

A person can configure one standing low-light comparison rule for a named project
and their own agent. The saved authorization is separate from a committed human
result. `POST /api/v1/projects/:projectId/proactive-comparison-rules` requires the
fixed `human_negative_result` trigger, `camera_sensor_comparison` purpose,
`current_project_published` data scope and `quiet_project_proposal` permitted
effect, plus a current contributor grant for the person's own agent. The caller
must currently be able to write the project. One rule per owner and project is
allowed. `GET` returns only the caller's rules and requires current project read
access; `PATCH /api/v1/proactive-comparison-rules/:ruleId` changes status with an
expected version and current project write access. Revocation is permanent.

The rule starts paused. The owner alone may create or replace a background compute
connection through `POST /api/v1/background-compute-connections`, inspect safe
metadata through `GET /api/v1/background-compute-connections/current`, and revoke
it through `DELETE /api/v1/background-compute-connections/:connectionId`. This is
separate from the external MCP/OAuth connection. The request includes the
Claude Platform key, its payer organization and dedicated provider workspace,
affirmation of spending authority and single-workspace scope, acknowledgement
that project-published excerpts may leave the instance, and a **consented 30-day
local budget**, per-run ceiling and maximum daily runs. An internal reservation
gate now counts possible charges across the owner's connections in a rolling
30-day window and UTC day; it reserves at least 5 cents atomically, keeps
unknown charges counted, and allows one in-flight reservation per owner. It does
not call the provider. The provider organization
owning the key pays Anthropic; Flux cannot verify the caller's spending authority
or guarantee the provider invoice. Metadata returns only the last four key
characters and a short SHA-256 fingerprint. It never returns plaintext or
ciphertext. Replacing/revoking clears the earlier ciphertext in the database.

Enabling returns `BACKGROUND_CONNECTION_REQUIRED` without a current owner
connection, `BACKGROUND_BUDGET_TOO_LOW` if the rule exceeds that owner's
consented budget, and `BACKGROUND_RUNTIME_UNAVAILABLE` after those checks because
the complete worker/provider path is not implemented yet. The stored rule remains
paused. A configured key does not start a provider call or emit a proposal. A
negative result authored by any currently authorized human contributor creates a
deduplicated outbox candidate for each opted-in owner of that named project in the
result transaction **only for an enabled rule**; production activation is
still disabled, so current production rules do not create candidates. The worker
adapter can recheck current owner/agent access, result authorship, explicit source
links and budget before reserving; there is no scheduled dispatch yet. An explicitly
invoked dispatch path in the worker decrypts only the owner's active
key, token-counts up to 8,000 inputs, makes at most one 1,200-output-token call,
validates cited output and persists a separate quiet proposal. It checks current
owner/agent project write access and pinned project-audience sources before the
call and again within the commit transaction. Provider calls hold no SQL locks:
short transactions collect authorized input and publish the result, while a
250 ms metadata check aborts a pending request after rule pause/revocation,
connection replacement/revocation, owner/agent access loss or source revision.
It rechecks before starting a paid Messages request after token counting. A newer
rule version cannot revive an earlier call. Cancellation returns even if an
adapter ignores its AbortSignal; a late answer cannot enter the proposal commit.
An already accepted provider request may still incur a charge, so cancellation
keeps the conservative reservation as `unknown`, without automatic retry.
Docker regressions exercise these changes through the running API while a local
provider fixture is pending; they do not prove live-provider cancellation or billing.
It records usage estimates
separately from the conservative reservation; failed or lost responses stay
`unknown` and are never retried automatically. The project-read API exposes a
proposal to current project readers without a notification. The adapter for
Claude Platform uses fixed token-count and Messages requests, a structured
answer schema, no tools and no automatic retry. Local HTTP fixtures exercise
the wire format; the adapter is not registered in the running worker and no
real Claude Platform call has been observed. Project contributors can inspect,
edit or dismiss a proposal, or explicitly use it to create work in one database
transaction. Citations retain source versions and project-message conversation
links. These controls are available only after a proposal has been created by
the still-disabled background rule.
Another project member may author a qualifying result under the owner's standing
rule, but cannot read or revoke that owner's connection or directly command it.
The API has no route to change the rule's owner, audience, scope or purpose.
The Docker browser journey in `tests/app/e2e/proactive-comparison.e2e.ts` seeds
one human work item and two proposals for a restricted project, renders their
compact review rows alongside ordinary work and results at 1440×900, opens one
by keyboard, follows an exact project-message citation, then edits, uses and
dismisses them. It verifies the
stored versions and resulting work through the API after reload. A person also
creates work manually after both proposals are gone, so the continuing project
workflow does not depend on an available model connection.

The adapter shape was checked on 2026-09-28 against the provider's
[token-count endpoint](https://platform.claude.com/docs/en/api/http/messages/count_tokens),
[Messages endpoint](https://platform.claude.com/docs/en/api/http/messages) and
[structured-output guide](https://platform.claude.com/docs/en/build-with-claude/structured-outputs).
Those pages describe the request fields; the local HTTP fixture proves only
Flux's serialization and parsing, not acceptance by the live provider.

## Key file, restore and rotation

Set `FLUX_BACKGROUND_KEY_HOST_FILE` to an absolute host path containing **exactly
32 raw random bytes**, generated for this deployment, and restart API and worker.
Compose mounts it read-only at `/run/secrets/flux_background_key`; with no file
configured it mounts an empty tracked placeholder and connection creation fails closed. Keep the
host file outside the checkout, PostgreSQL volume and database backup, and make
the containing directory private. The API only seals a submitted key with
AES-256-GCM, a fresh nonce, and authenticated data binding the Flux owner and
connection IDs. The worker's controlled dispatch path is the only application path
that should open it. API responses, events and jobs contain no key. Database
backups need this same instance secret to recover stored connections; after a
lost secret, revoke and reconnect each owner rather than treating ciphertext
as a usable connection. An instance operator with host access remains trusted.

For planned rotation, stop API and worker, back up the database and old secret,
create a different 32-byte secret file, then run the offline transaction in the
same Compose project with the new file mounted as
`/run/secrets/flux_background_key_next`. Set `FLUX_PROJECT` to that instance's
Compose project name and `NEW_BACKGROUND_KEY_FILE` to the absolute new file path:

```sh
docker compose -p "$FLUX_PROJECT" -f infra/compose.yaml stop api worker
docker compose -p "$FLUX_PROJECT" -f infra/compose.yaml run --rm --no-deps \
  -v "$NEW_BACKGROUND_KEY_FILE:/run/secrets/flux_background_key_next:ro,z" \
  worker node infra/dist/rotate-background-key.js
```

The command re-encrypts all active connections in one database transaction and
prints only a count. On failure it rolls back; keep the old file. On success,
replace the host file at `FLUX_BACKGROUND_KEY_HOST_FILE` with the new bytes before
restarting API and worker. If that final file switch fails, **do not restart**:
finish the switch or restore the paired database and old secret backup. Rotate
the provider keys separately if compromise is suspected.

Migrations `0021`–`0024` include the standing rule, encrypted connection,
candidate/reservation ledger and separate project proposal. The outbox retains
reserved possible charges when a rule or result would otherwise be deleted, so
removal cannot reset the owner's
allowance. The migrator applies individual files in numeric order and the #118
strict guard rejects any gap or unknown version in the application ledger.
Same-volume upgrade proof through `0021`–`0024` remains required before release.

The [Claude Sonnet 5 model page](https://platform.claude.com/docs/en/models/sonnet-5/whats-new-sonnet-5),
checked 2026-09-28, lists API model ID `claude-sonnet-5`, standard $2/M input
tokens and $10/M output tokens, and notes that its tokenizer differs from Sonnet
4.6. This is provider documentation, not an observation of a Flux bill; the
worker records `usage_estimated_cents` using these dated standard rates and
continues to hold at least the original reservation in the local budget.

Remaining #58 work: an authorized real-provider test call and actual billing
observation including live-provider cancellation, broader versioned
project source selection, reopening dismissed suggestions only after relevant
evidence changes, insufficient-evidence state, rendered UI/interaction
and independent visual evidence, plus #118 migration-upgrade proof. This file
describes a controlled integration slice, not completion of #58.
