# O-010 — public extension contracts of v0.1

**Status:** accepted 2026-10-05 by `claude-hubert`'s independent review of [#260](https://github.com/ColdPhase/flux/pull/260) (merged as `fb609ca5`); proposed 2026-10-05.
**Decision owner:** @Zamojski5 (claude-maurycy). **Evaluator:** @PelikanFix16
(claude-hubert; first planned as codex-hubert). **Task:** [#251](https://github.com/ColdPhase/flux/issues/251).
**Release matrix:** [#249](https://github.com/ColdPhase/flux/issues/249).

This decision covers foundation
[8.13](FLUX-FOUNDATION.md#813-integracje-i-otwarte-rozszerzenia) and
[F7](FLUX-FOUNDATION.md#f7-organizacja-może-rozwijać-własny-sposób-pracy). It fills in
the [O-002 agent and extension seam](application-architecture.md#agent-and-extension-seam)
for the first release. It does not change O-002, [O-005](first-agent-path.md),
[F-016](mcp-cowork.md), [F-018](cowork-workflow.md) or [F-019](decisions.md).

The guide for integrators and operators is
[docs/integrations](../integrations/README.md).

## Problem

A company should be able to connect Flux to its own process (8.13, F7) and keep
that connection working through Flux updates. It should not have to patch the core
on every update. Each public contract therefore needs four things:

- a version and a compatibility promise;
- a permission model;
- retry and idempotency rules for its effects and events;
- a failure the integrator or the person can see and recover from.

Before this decision no surface had all four, and nothing tested the promise.

## What exists (observed on `main` `fdb70955`, 2026-10-05)

- **MCP server at `/mcp`.** This is the remote MCP entry point of
  [O-005](first-agent-path.md) and [#152](https://github.com/ColdPhase/flux/issues/152).
  - 37 `flux_*` tools, the `start_work` and `resume_work` prompts, and the
    playbook resource `flux://playbook/flux.cowork/<version>`.
  - The policy resource template `flux://policy/{projectId}/{revision}`.
  - The co-work playbook `flux.cowork` 1.1.0 already reports a
    `toolContractVersion` of 1, a content digest, and an acknowledgment check
    (`mcp-playbook.test.ts`).
  - OAuth 2.1 with PKCE, owner consent, scope ceilings and per-call rechecks
    (`oauth-mcp.test.ts`).
  - Nothing pinned the tool names or input schemas, so a rename or a new required
    input would have passed every test.
- **Project export format 1 ([#123](https://github.com/ColdPhase/flux/issues/123)).**
  - `flux.project-export` with `formatVersion` 1, a draft-07 JSON Schema in
    `@flux/contracts`, and a `.tar.gz` bundle with a checksummed manifest.
  - `export.test.ts` validates real exports against the schema. It does not pin
    the schema, so the schema could change in a breaking way and the tests would
    still pass.
  - [Export compatibility](../operations/export.md#compatibility) already says
    "readers ignore unknown fields; removal needs a new `formatVersion`".
- **`/api/v1` HTTP and the WebSocket stream.** These are the web application's
  API. They have versioned paths and `*.v1` event kinds, but no published
  compatibility promise, no OpenAPI document and no tokens for integrations.
- **`@flux/sdk` and `app/examples/external-agent`.** These only wrap the
  integration fixture's sample command, which needs `FLUX_FIXTURE_TOKEN`.
- **GitHub bridge ([#74](https://github.com/ColdPhase/flux/issues/74)).** An
  inbound consumer of GitHub's own webhook and REST contracts. Flux checks
  `X-Hub-Signature-256` with HMAC, stores each delivery before it answers `202`,
  removes duplicates by `X-GitHub-Delivery`, retries per binding, and offers
  manual reconciliation. Flux does not publish this contract.
- **Outbound webhooks** do not exist.

## Options

1. **Declare the surfaces that already exist stable and pin them with contract
   tests. Defer new surfaces with a recorded condition.** (Chosen.)
2. **Add signed outbound webhooks to v0.1.** This needs several things that do
   not exist yet:
   - a public event catalogue with payload schemas;
   - a delivery store and a migration;
   - a worker retry schedule;
   - an outbound network policy against SSRF;
   - custody for subscription secrets;
   - access rechecks at delivery time;
   - a UI that shows failures and offers redelivery.

   Done properly, this is a feature of its own. Doing it in a hurry, in the same
   task that defines the contract rules, would publish a weak contract that later
   updates must preserve.
3. **Declare `/api/v1` stable.** The web application changes this API with almost
   every feature. Freezing it now would slow the product down or break the
   promise. It also has no API-token model for integrations.
4. **Publish no contract in v0.1.** This would leave F7 without a versioned
   extension, although two real contracts are ready.

## Decision

The **stable public contracts of v0.1** are **EXT-1** and **EXT-2**. Each one has
a versioned snapshot under `app/tests/app/contracts/`, which
`app/tests/app/extension-contracts.test.ts` compares with the running
application. Everything else is either a non-contract surface or deferred, as
listed below.

### EXT-1 — MCP tool contract 1

| Property | Contract |
| --- | --- |
| **Surface** | Streamable HTTP MCP at `<FLUX_PUBLIC_ORIGIN>/mcp`, protected-resource metadata at `/.well-known/oauth-protected-resource/mcp`. It includes every `flux_*` tool with its name, input JSON Schema, annotations, required scope, operation and peer-request classes. It also includes the `start_work`/`resume_work` prompts and their arguments, the playbook resource and the policy resource template. The tool error envelope `{ "code", "error" }` with `isError: true` and the listed error codes are part of it. So are the top-level keys of `flux_bootstrap`, its `trusted` block and each capability row, and bootstrap's own `contractVersion` (1), which versions that response. |
| **Version** | `toolContractVersion`, an integer. Bootstrap reports it in `trusted.playbook.toolContractVersion`, and the rendered playbook names it. The snapshot is `mcp-tools.v<N>.json`. The playbook's own version (`flux.cowork` 1.3.0) and its digest identify the instruction text. They can change without changing the tool contract. |
| **Compatibility** | Within one `toolContractVersion` only **additive** changes are allowed: a new tool, prompt or resource; a new optional input; a wider type, enum or bound; a removed pattern or format restriction; a changed title. Tool and argument descriptions are not part of the snapshot and may change freely. Anything else is **breaking** and needs `toolContractVersion` N+1 and a new snapshot. That covers removing or renaming a tool, prompt, argument or resource, removing or newly requiring an input, narrowing a type, enum, bound, pattern or format, and changing a required scope, operation, classes or annotation. It also covers changing the error envelope, removing a listed error code and removing a bootstrap key. The old snapshot stays in the repository. Tool output beyond the error envelope and the bootstrap keys is JSON text without a declared output schema in v0.1. Fields may be added to it, and clients must ignore fields they do not know. |
| **Permission** | Per [O-005](first-agent-path.md), [F-019](decisions.md) and [agent connection](../development/agent-connection.md), the connection belongs to one person. That person consents through OAuth 2.1 authorization code with PKCE S256 at the Flux authorization server. Token scopes (`flux.context.read`, `flux.proposal.write`, `flux.action.execute`, plus `offline_access`) are ceilings, not permissions. On every call, inside the transaction, the server checks the live connection, its owner, the agent, the selected project, the agent's current grant and the owner's rights. A native action also needs a live standing grant for its operation and class. Revoking the connection refuses the next request with 403. |
| **Retry and idempotency** | Reads can be retried freely. Every write tool takes a `clientCommandId` UUID per intended effect, except `flux_acknowledge_playbook`, which is idempotent per `clientSessionId`. The same ID with the same input returns the stored outcome. The same ID with a different input is refused with `IDEMPOTENCY_CONFLICT`. Versioned writes take the version that was read, and a stale one gets `VERSION_CONFLICT`. A planning intent returns the same task instead of a duplicate. MCP pushes no events; changes are pulled with `flux_changes_since` from recorded checkpoints. |
| **Visible failure** | A tool failure returns `isError: true` with a stable `code`. The documented codes are `MCP_SCOPE_REQUIRED`, `AGENT_EXECUTION_UNAVAILABLE`, `VERSION_CONFLICT`, `SOURCE_VERSION_CONFLICT`, `TASK_PREREQUISITES_UNMET`, `PLAYBOOK_VERSION_MISMATCH`, `IDEMPOTENCY_CONFLICT`, `RUNTIME_UNAVAILABLE`, `INVALID_INPUT`, the co-work `COWORK_UNIT_TAKEN`, `COWORK_CLAIM_LOST`, `COWORK_CONNECTION_BUSY`, `COWORK_TASK_CLOSED` and `COWORK_UNIT_REQUESTS_OPEN` (named by playbook 1.3.0, #153) and the generic `MCP_TOOL_UNAVAILABLE`. A missing or invalid token gets 401 with the resource metadata challenge. A revoked connection or a disabled client gets 403. In Flux, a project's **Agents** view shows each connection's state and its last action. The state is session open, offline, not signed in yet, or "Can’t act here now: check this agent’s project access". The owner revokes a connection on the **Connect agent** page. Bootstrap `gaps` name the server capabilities that are missing. |
| **Contract test** | `extension-contracts.test.ts` connects through real OAuth and reads `tools/list`, `prompts/list`, `resources/list`, `resources/templates/list`, the protected-resource metadata, bootstrap and one refused call. It compares them with `mcp-tools.v1.json`. It also checks that every listed error code is still raised in the server or core source, and that every code the playbook names is listed. |

The [#460 wire admission/authentication/feature amendment](mcp-protocol-compatibility.md)
is Proposed, with delegated pre-review at `93889087` / record `880340ab`; eligible independent acceptance is pending. Its bounded two-era
research choice has a recorded delegated pre-review; this does not change EXT-1's domain version,
permission or compatibility promises, nor declare a production legacy client
supported. Implementation must prove both wire formats against the required
domain contract before support is published.

### EXT-2 — project export format 1

| Property | Contract |
| --- | --- |
| **Surface** | `GET /api/v1/projects/{projectId}/export` returns `project.json`. Adding `?format=bundle` returns the `.tar.gz` bundle. `./flux export` produces the same bundle. The contract covers `project.json` (`format`, `formatVersion`, `$schema` id, the JSON Schema `PROJECT_EXPORT_JSON_SCHEMA`), the bundle layout (`project.json`, `manifest.json`, `README.md`, `schema/project-export.v1.schema.json`, `docs/<id>.md`, `files/<id>`), and the manifest identification `flux.project-export-bundle` 1. |
| **Version** | `formatVersion`, with the snapshot `project-export.v<N>.json`. |
| **Compatibility** | Within one `formatVersion` only **additive** changes are allowed: a new field (optional or required), a new definition, a new enum value, a tighter bound, a new bundle file, or changed descriptions. Readers must ignore unknown fields and treat an unknown enum value as unknown, not as an error. Anything else is **breaking** and needs a new `formatVersion` and snapshot. That covers removing or renaming a field, making a field optional or nullable, a wider or different type, a removed enum value, and a changed constant, pattern or format. It also covers removing or renaming a bundle file, and changing the manifest identification. Re-import is not part of format 1. |
| **Permission** | `project.manage`: workspace owners and admins, unless an explicit deny on the project applies. The operator command runs the same use case as an account. Responses carry `Cache-Control: no-store`. |
| **Retry and idempotency** | A safe GET. Each export is one consistent `REPEATABLE READ` snapshot, so a retry produces a new, complete export. No events are emitted. |
| **Visible failure** | A missing session gets 401. A project the caller cannot see gets 404. A visible project the caller may not manage gets 403. A missing or corrupt stored file aborts the archive stream instead of writing a partial manifest that claims success. In Flux, **Export the whole project** in the wiki's download menu shows the failure in place: no permission, the project is gone, or the export could not be made. The CLI exits non-zero. |
| **Contract test** | `extension-contracts.test.ts` exports a real bundle. It compares the identification, the bundle layout, the manifest identification and the full JSON Schema with `project-export.v1.json`. `export.test.ts` continues to validate real content against the schema. |

### How the contract tests decide

`app/tests/app/support/contract-compat.ts` compares a snapshot with the running
application and classifies each difference:

- **Input direction (EXT-1).** The new contract must accept everything the old
  one accepted.
- **Output direction (EXT-2).** The new output must still meet every guarantee the
  old one gave a reader who ignores unknown fields and unknown enum values.

The test fails on any difference. The message lists each change as additive or
breaking, and prints the canonical JSON of the running contract.

- **Additive difference.** Replace the current version's snapshot in the same
  PR.
- **Breaking difference.** Bump the version and add the new snapshot. The old
  snapshot stays in the repository.

The test also fails when the snapshot for the current version is missing, or when
an older version's snapshot was deleted. It cannot see whether a reviewer allowed
a breaking edit to an existing snapshot file. A diff that removes or narrows
something in an existing `*.v<N>.json` therefore needs explicit review as a
contract change.

### Not public extension contracts in v0.1

These surfaces work and are documented, but they come with no compatibility
promise. Integrations should not depend on them:

- `/api/v1` HTTP routes other than the export route, and the WebSocket stream
  with its `*.v1` event kinds. They are the web application's API and can change
  in any release.
- `@flux/sdk` and the external-agent example. They only exercise the fixture
  sample command.
- The GitHub bridge. It is an operator-configured consumer of GitHub's contract,
  with signed and stored deliveries, duplicate removal, retries per binding, a
  manual **Refresh access** and reconcile, and visible non-sensitive failures (see
  [GitHub App connection](../development/github-integration/README.md)). Its
  configuration is an operator interface, not an extension point.
- Operator interfaces (`./flux` commands, `/api/v1/health`, release assets). They
  are covered by the [operations guides](../operations/README.md) and the release
  checks, not by this decision.

### Deferred: scope record for #249

Each row is a scope decision for the v0.1.0 release matrix. Each row is not
delivered in v0.1. It returns when its condition holds.

| ID | Deferred surface | Why not in v0.1 | Condition to schedule it |
| --- | --- | --- | --- |
| EXT-D1 | Signed outbound webhooks (event subscriptions with HMAC signatures, retries with backoff, idempotency keys and a delivery-failure UI) | Needs the parts listed under option 2. None of them exists. | A public event catalogue (EXT-D3) is accepted, and a task contract covers secret custody, outbound network policy, delivery store, migration, failure UI and redelivery, with API and UI tests. |
| EXT-D2 | Stable REST read API with an OpenAPI document and integration tokens | `/api/v1` is the web application's moving API, and there is no token model for integrations. | A concrete integration needs data that MCP cannot serve, and a contract for tokens, scopes and versioning is accepted. |
| EXT-D3 | Public event vocabulary: stream event kinds and payloads as an integration contract | The kinds are internal identifiers for the web application, and their payloads have no schema. | Required by EXT-D1 or a named consumer. |
| EXT-D4 | `@flux/sdk` as a supported client | It wraps only the fixture command. A client follows EXT-D2. | EXT-D2 is accepted. |
| EXT-D5 | In-process plugins and UI extension slots | O-002 requires a sandbox and trust decision and a migration contract first. | A concrete need that MCP and export cannot meet, and an accepted sandbox decision. |
| EXT-D6 | Re-import of a project export | Format 1 states `reimportSupported: false`. | A task contract for import that does not restore provider grants (see the [GitHub bridge](../development/github-integration/README.md)). |
| EXT-D7 | Declared MCP output schemas (`outputSchema`) | Outputs are JSON text without declared schemas. Behaviour tests cover the fields they use. | A client needs typed outputs, or contract 2 is planned. |

The coordination tools in flight under
[#153](https://github.com/ColdPhase/flux/issues/153) are not deferred. When they
merge they join contract 1 as additive tools, with an updated snapshot.

## Costs and limitations

- Every MCP tool change now touches the snapshot. That is intended: the snapshot
  diff is the review surface for the public contract.
- Open PRs that add tools need a rebase and a snapshot update.
- In v0.1, integrations must pull. Without outbound webhooks, an integration
  reacts by polling `flux_changes_since` from its checkpoints, or through an
  agent's Start/Resume. It is not notified by Flux.
- The tests pin schemas, names and envelopes. They do not prove that a real
  third-party client works against them. Real-client evidence remains with
  [#152](https://github.com/ColdPhase/flux/issues/152) and
  [#160](https://github.com/ColdPhase/flux/issues/160).
- The snapshot check cannot see repository history. A breaking edit of an
  existing snapshot is caught by review, not by the test.

## Reconsider when

- A deferred row's condition holds.
- A contract version must break before v0.1.0 ships. Until the release, version 1
  can still be replaced by a reviewed decision.
- Independent evidence shows that a promise here cannot be kept.
