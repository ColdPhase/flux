# Authorized accounting context refinement

The 2026-09-30 independent planning assessment accepts optional current
`context: { projectTitle, resultTitle } | null` for the newest 50 owner usage rows.
Core obtains unchanged owner accounting first, then authorizes sorted distinct
project IDs sequentially in the existing unit of work. Only successful central
policy decisions permit a separate metadata lookup; the policy's internal project
read is not claimed to be title-free. Exact project/result/workspace matching
prevents the noncomposite legacy result FK from disclosing a misbound title.
Pair lookups are request-local and deduplicated. Denied/missing context yields
null without dropping rows or totals; unexpected policy/storage errors propagate.
UI/API use this one projection. No global title cache or historical source names
may replace redacted metadata. This bounded refinement does not complete the
remaining runtime/provider, review and integrated acceptance gates of #58.

## Proactive comparison rule (#58, first implementation slice)

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
adapter rechecks current owner/agent access, result authorship, the selected source
snapshot and budget before reserving; production scheduling is not registered. An explicitly
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
After the Messages adapter has been entered, cancellation keeps the conservative
possible-charge reservation as `unknown`, without automatic retry. Before that
point, a preparation/token-count refusal or cancellation records `not_run` with
zero usage, releases its unspent reservation and leaves the candidate terminal.
The provider's [token-count documentation](https://platform.claude.com/docs/en/build-with-claude/token-counting#pricing-and-rate-limits),
checked 2026-09-30, describes token counting as free with separate rate limits;
this is vendor billing documentation, not observation of a Flux invoice.
Docker regressions exercise these changes through the running API while a local
provider fixture is pending; they do not prove live-provider cancellation or billing.
It records token-derived usage estimates separately from the conservative
reservation. Lost responses or invalid usage stay `unknown` and are never
retried automatically. A declared insufficient response, or a truncated or
invalid comparison with valid observed usage, can instead become a quiet
insufficient-evidence item after final current authorization checks. Validation
failures use fixed safe text rather than provider output. The project-read API
exposes proposals and insufficient items to current readers without a
notification. The adapter for
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
dismisses them. It also follows work/thought citations and the Work/Results
section jumps in separate desktop, touch phone and touch tablet browser contexts
at 1440×900, 390×844 and 1024×768. Touch source links and jumps have at least
44 px height, and source labels remain inside the visible column. Browser touch
emulation is not real-device installation or notification evidence. It verifies the
stored versions and resulting work through the API after reload. A person also
creates work manually after both proposals are gone, so the continuing project
workflow does not depend on an available model connection.
When a saved Tasks status or Only mine view hides ordinary work/results, the
outcome section's Work/Results links restore All before scrolling to the real
destination. Quiet outcomes remain a separate project section above Task views.

The adapter shape was checked on 2026-09-28 against the provider's
[token-count endpoint](https://platform.claude.com/docs/en/api/http/messages/count_tokens),
[Messages endpoint](https://platform.claude.com/docs/en/api/http/messages) and
[structured-output guide](https://platform.claude.com/docs/en/build-with-claude/structured-outputs).
Those pages describe the request fields; the local HTTP fixture proves only
Flux's serialization and parsing, not acceptance by the live provider.

## Deterministic human context snapshot

The [accepted source amendment](../product/background-compute.md#source-and-outcome-amendment-accepted-2026-09-29)
now has a controlled selection implementation. The result transaction checks the
standing rule owner's and personal agent's current project-write access through
the shared policy before selecting metadata. Reservation, content collection,
the cancellation watcher and final publication repeat that policy/source check.
Reservation and cancellation read source metadata, not content or decrypted keys.

Keep the triggering human negative result and all explicit admitted references.
An immutable published human material/doc version explicitly cited by that result
stays pinned beside a separately selected current version. Validate both exact
versions without relabeling; later unpublication/deletion refuses before paid
dispatch. Work/thought references still require current versions. An unsupported
or inadmissible mandatory reference fails closed. Add up to
six current human material/published-doc versions, twelve recent human project
messages, eight human work items, four positive human benchmark results and eight
human project-scope thoughts. Additional negative results enter only when
explicitly referenced, rather than automatically combining independent failures.
Each category orders by most recent update/creation and stable ascending id.
Mandatory explicit sources survive the category limits; duplicates are removed.
Do not read draft/private/DM/other-project content, placements, agent-created
sources, work made from a previous comparison proposal, or work/thoughts with an
agent content-change event. Published material/doc authors and message authors
must be current human identity records.

Fingerprint the sorted selected references, explicit-reference set, rule id/version
and owner id. Work uses its actual version. Thoughts use their actual id/version
and sketch id; changing thought text changes the fingerprint even when the sketch
title/version stays the same. Recheck current scope, authorship, no placement and
version before reading or committing. Each provider source is bounded to 2,000
characters with an explicit excerpt marker and original character count; the
8,000-input-token preflight remains an independent gate, without a paid fallback.
The full snapshot fingerprint is immutable on a candidate; completed proposals
and dismissals keep their earlier fingerprints. Pending candidates from an older
snapshot implementation fail the current fingerprint gate instead of silently
reusing their earlier authorization.

Only supplied ids/versions can be cited. The server attaches message conversation
ids and thought sketch ids from its selected sources, rather than trusting model
navigation data. Compact citation labels use the first 100 characters of the
selected revision's title or first line, ignoring any model-supplied label.
Work/thought links display their cited version and open the current
object, since those objects have no historical content API. Creating work from a
proposal preserves those project relationships and does not add that generated
work back into comparison evidence.

The controlled dispatch path saves the complete inspected metadata vector
before sending source content to compute; cited references remain a distinct
subset. Outcome reads apply current source access per reader, returning only
the count of unavailable references. Legacy candidates keep a null inspected
vector rather than reconstructing it from citations. The paged outcome API
keeps insufficient items separate from actionable proposals; dismiss requires
current project write access and the expected version.

Terminal pre-paid credential, access, scope and allowance failures persist a
private `not_run` reason with zero usage and reservation. Busy-owner candidates
remain queued. The owner-only accounting API exposes local started-request,
observed, conservative, unknown and in-flight amounts, current connection limits
and at most 50 own candidate summaries; it never returns source content or
another owner's rows. These estimates are not provider invoices. Docker
build/typecheck/lint and 35 targeted core/API/provider-fixture/persistence tests
passed for this backend checkpoint, including access loss, source deletion,
insufficient responses and terminal no-retry failures.

The project Tasks surface loads every advertised outcome page. Comparisons show
cited references and a separate expandable checked-source list; insufficient
items expose their full reason and checked references with Dismiss only for
current project writers. Legacy proposals explain that their full inspected
list was not recorded. Source versions, excerpts and unavailable-reference
counts remain visible without revealing hidden titles. The owner's connection
settings show private local usage and recent request states, including zero-cost
not-run outcomes and uncertain charges; disconnection keeps that history.

The [outcome and owner-usage evidence](../design/proactive-comparison/outcomes-2026-09-30/)
records six passing Docker browser journeys, measured settled-theme search
contrast, independent touch phone/tablet contexts and a separate neutral visual
review. Screenshots and fixture-provider checks do not establish live-provider
billing, cancellation, physical devices or whole-task acceptance.

## Controlled source-change scheduling

The internal `comparisonSchedulingTick` consumes committed metadata events with
its own durable cursor. Cursor advance and project reconsideration rows commit
together. Human admitted project evidence changes extend a two-minute quiet
window, capped at fifteen minutes after its first change. Draft doc saves,
private/DM sketches, layout-only changes, agent and proposal-origin evidence do
not qualify. The cursor's recovery path reconsiders every enabled project after
retention or a rebuilt log, paging through projects and reporting the recovery.

Due projects recheck the owner's and personal agent's current project rights
before selecting snapshots, page through all qualifying human negative results,
and insert only new rule/result/fingerprint candidates. Existing dismissals and
paid/unknown charges remain history; unchanged fingerprints never retry. Obsolete
queued candidates end at zero cost. Dispatch checks candidate due time, the
project's pending quiet window and whether all committed events were collected;
a previously selected candidate id cannot bypass those checks.

Docker build/typecheck/lint and 49 targeted core/API/persistence/provider-fixture
tests passed for this controlled scheduler and outcome checkpoint. Coverage
includes committed-versus-uncommitted events, edit bursts and the maximum wait,
restart and two consumers, more than 100 results/projects, cursor recovery,
draft/provenance exclusions, access loss and retained dismissal/unknown charges.
The historical-source regression supplies explicit published v1 beside current
v2, then stops before any paid fixture call after a mid-count v3 edit or later
unpublication/deletion. Tests use an isolated database and run serially because
cursor-recovery fixtures deliberately own its global cursor. Existing dispatch
fixtures make only their own candidate due and explicitly advance that fixture
cursor; they do not prove scheduling.

The scheduler selects candidate ids without a provider/key port. It and the
provider adapter remain unregistered in production; rule activation still fails
closed. The real-provider acceptance gates remain verification work.

## Controlled interrupted-reservation recovery

The accepted `comparisonRecoveryTick` has only metadata ports. In each transaction
it locks at most 100 reserved rows with no update for 20 minutes, skipping active
row locks and rechecking state/time. Before a persisted dispatch intent it records
private `not_run` with zero usage; after intent it records private `unknown` and
retains the reservation, observed usage and connection history. No source, key,
provider, output or notification port is available. Late dispatch cannot overwrite
the terminal row, publish an outcome or release uncertain spending. Unchanged
fingerprints remain suppressed. The tick is not registered in production.

Docker build/typecheck/lint and 56 targeted tests passed on 2026-09-30 for the
recovery, scheduler, context, dispatch and outcome sources. Recovery covers a
reopened database pool, pre/post-intent states, fresh-row exclusion, held row locks,
two concurrent sweepers, 123 distinct owner reservations, repeated ticks, retained
usage after connection replacement and delayed fixture responses. This is persisted
controlled recovery evidence, not an actual killed worker or provider billing test.
The dispatch timestamp/count is an intent/attempt, not proof of sending or charging.
Owner history explains uncertain attempts and legacy earlier reservations.

Local request references and generic triggering-result links passed keyboard and
phone/tablet touch checks. After explicit owner denial, usage/amounts remain
available privately but the result route returns 404 without its title/body.
The [earlier independent visual checkpoint](../design/proactive-comparison/main-integration-2026-09-30/)
found those opaque references insufficient for recognizing past work. The later
independently assessed current-access metadata contract below is implemented:
authorized result/project names lead each row, while denied context alone is
redacted. Its current screenshots and live checks are recorded separately; the
earlier checkpoint retains its original scope. A compact header action opens and
focuses recent requests directly, retaining the full connection/accounting
disclosures for people inspecting setup and estimates.

Actual protected main `3cd91d798a8767ba8a87ceecde98b49f76aed15a` is integrated.
Its SQL 1–25 remains unchanged; only unmerged comparison migrations use 26–32.
Before recovery and usage wording changes, clean application head
`c991068ca20d7925dff909e4bcaa1fb7796094fd` passed the full Docker application check:
369 application tests, three PWA checks, access-stream, six comparison/setup/outcome
browser journeys, restart persistence and unavailable push/email checks. The
subsequent usage wording passed Docker build/typecheck/lint and three outcome/owner
browser journeys in independent desktop/phone/tablet contexts. Those touch flags
do not establish physical-device operation. Independent full-head functional
acceptance remains a separate check.

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

Migrations `0026`–`0032` include the standing rule, encrypted connection,
candidate/reservation ledger, separate project proposal and fresh paused-rule
renewal after permanent revocation, inspected/outcome accounting and source-change
scheduling. The outbox retains
reserved possible charges when a rule or result would otherwise be deleted, so
removal cannot reset the owner's
allowance. The migrator applies individual files in numeric order and the #118
strict guard rejects any gap or unknown version in the application ledger.
These unmerged files were renumbered after protected main reached schema 25
at `973f35cf00e624efecf5763e111e7511481bac44`; all applied main SQL stays unchanged. The earlier
same-volume evidence below applies to the numbering at its stated commit.
Later integrations and the final release candidate still need their own
upgrade acceptance.

### Same-volume rehearsal

Run `./scripts/check_proactive_upgrade.sh` from this branch. It archives an
immutable baseline (`origin/main`, or `FLUX_UPGRADE_FROM`) and the committed
candidate into an isolated checkout, starts/seeds the baseline, then replaces
only its source and starts the candidate on the same PostgreSQL/files volumes.
`FLUX_PROACTIVE_UPGRADE_PORT` selects the base port; use a separate port for
concurrent runs. Application execution and builds stay in Docker.

Observed 2026-09-29: baseline `9d27e994ce2b770e98139a14bedc51fd687cb76b`
to rehearsal commit `4fb57c6ea6d0dc099834b51c6dbe980085739a7d` passed.
The exact ledger changed from `1`–`20` to `1`–`24`, with all four real
comparison migrations applied. Before/after full-row count/hash snapshots
matched for 16 existing content/grant tables, including nonempty human work,
decision, negative result and six object links. The original browser session,
two material revisions, historical message citation and private draft remained
usable through the API. The new paused rule and encrypted connection were
usable; enabling still failed with `BACKGROUND_RUNTIME_UNAVAILABLE`, and manual
work creation succeeded. A second migration/start left the exact ledger intact.
The rehearsal removed its project, volumes and image tags. This is local
candidate evidence; independent #58 evaluation and the final integrated
release candidate still require their own acceptance pass, including any later
migrations from other branches.

Observed 2026-09-30: protected baseline
`4d9179b57b82172e7bc1c08a0a459128cc7b76f7` to
`06d07f6cbdea4d0a569b719929ec82594332406a` passed the same rehearsal
with ledger `1`–`20` → `1`–`25`. All five comparison files were applied to
the original volume, the 16 full-row snapshots matched, original sessions and
historical sources remained usable, the new paused rule/key worked without a
provider invocation, and the repeat migration/start kept the ledger exact.
This is a local branch rehearsal, not independent or integrated #118 acceptance.

Observed 2026-09-30: protected baseline
`01cb89a5edae783f02f66013ea4df30248c1dc76` to
`e596868cef576cc79f465d7e05fe5b9a662708cc` passed with ledger `1`–`21` →
`1`–`26`. The original main migration 21 was unchanged; the five comparison
files applied as 22–26 on the original volume. All 16 full-row snapshots matched,
the original session and historical sources remained usable, and paused-rule/key
setup and manual work creation worked without a provider call. A repeat
migration/start retained the exact ledger. The isolated stack, volumes and tags
were removed. This proves that particular integration locally; subsequent
renumbering or migrations require another rehearsal and independent acceptance.

Observed 2026-09-30: actual protected baseline
`3cd91d798a8767ba8a87ceecde98b49f76aed15a` to
`44b9cd774bafb12cc2963cc8db87ae9d7cfdc3b4` passed with exact ledger
`1`–`25` → `1`–`32` on the same original PostgreSQL volume. Only comparison
migrations 26–32 applied. All 16 full-row snapshots matched, and the original
session, published historical material/source versions, private draft and object
links remained usable. New paused rule/key setup and manual work creation passed
without a provider call; rerunning migrations and restarting preserved the exact
ledger. The isolated stack, volumes and images were removed. The subsequent
capture-only test changes do not alter those application or migration sources.
This is local candidate evidence, not independent #118 or release acceptance.

### Owner setup and rule controls

The owner opens **Background suggestions** from the account menu. Its private
settings route saves explicit payer, provider workspace, disclosure and local
allowance consent; the password field is cleared after every API attempt.
Saved metadata exposes only the key suffix, never the key/ciphertext. Replace
has cancellation beside its heading and at the bottom of the form; failed
replacement keeps the saved connection. Disconnect removes the key from Flux;
provider revocation remains a separate action explained beside the button.

A person can create their own named agent, grant it access to the selected
project and save a **paused** comparison rule. An earlier revoked rule remains
unchanged: renewal creates a new paused identity/version with fresh scope and
allowance confirmation. Concurrent renewal allows one creation; unknown possible
charges remain counted across connections and renewed rules. Enable truthfully
stays unavailable until the accepted runtime is registered and verified.

The [owner-setup evidence](../design/proactive-comparison/owner-setup-2026-09-30/)
separately records rendered states, independent visual findings and their
remediation, running Docker/API/browser checks and the remaining gaps. It does
not establish real provider spending or whole-task completion.

The [Claude Sonnet 5 model page](https://platform.claude.com/docs/en/models/sonnet-5/whats-new-sonnet-5),
checked 2026-09-28, lists API model ID `claude-sonnet-5`, standard $2/M input
tokens and $10/M output tokens, and notes that its tokenizer differs from Sonnet
4.6. This is provider documentation, not an observation of a Flux bill; the
worker records `usage_estimated_cents` using these dated standard rates and
continues to hold at least the original reservation in the local budget.

Remaining #58 work: an authorized real-provider test call and actual billing
observation including live-provider cancellation, independent full-context quality
evaluation, real crash/provider reconciliation, registered production scheduling and activation,
plus independent/current integrated migration and release acceptance. Controlled
changed-evidence reopening, insufficient-evidence outcomes and private usage
accounting now have the separate fixture evidence above. This file describes a
controlled integration slice, not completion of #58.
