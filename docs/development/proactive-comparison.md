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
local budget**, per-run ceiling and maximum daily runs. Dispatch accounting is
not implemented yet. The provider organization
owning the key pays Anthropic; Flux cannot verify the caller's spending authority
or guarantee the provider invoice. Metadata returns only the last four key
characters and a short SHA-256 fingerprint. It never returns plaintext or
ciphertext. Replacing/revoking clears the earlier ciphertext in the database.

Enabling returns `BACKGROUND_CONNECTION_REQUIRED` without a current owner
connection, `BACKGROUND_BUDGET_TOO_LOW` if the rule exceeds that owner's
consented budget, and `BACKGROUND_RUNTIME_UNAVAILABLE` after those checks because
the budgeted worker/trigger path is not implemented yet. The stored rule remains
paused. A configured key does not start a provider call, enqueue a job or emit a
proposal. Peers cannot read, revoke or spend another person's connection. The
API has no route to change the rule's owner, audience, scope or purpose.

## Key file, restore and rotation

Set `FLUX_BACKGROUND_KEY_HOST_FILE` to an absolute host path containing **exactly
32 raw random bytes**, generated for this deployment, and restart API and worker.
Compose mounts it read-only at `/run/secrets/flux_background_key`; with no file
configured it mounts an empty tracked placeholder and connection creation fails closed. Keep the
host file outside the checkout, PostgreSQL volume and database backup, and make
the containing directory private. The API only seals a submitted key with
AES-256-GCM, a fresh nonce, and authenticated data binding the Flux owner and
connection IDs. The worker's future dispatch path is the only application path
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

Migration `0021_proactive_rules.sql` uses 21 because 14–20 are reserved by the
parallel search, notifications and live-session branches. The migrator applies
individual files in numeric order; #118 will add a strict migration ledger and
same-volume upgrade proof before these branches can be integrated as a release.

Remaining #58 work: trigger capture and deduplication from committed human negative results; budgeted worker
execution and cancellation; source/audience rechecks; quiet proposal and UI;
real provider, privacy and no-AI continuation evidence. This file describes a
working configuration slice, not completion of #58.
