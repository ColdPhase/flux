# Integrating with Flux

This guide is for two readers:

- **integrators**, who build an agent, a script or a pipeline against a Flux
  instance;
- **operators**, who run the instance those integrations connect to.

The decision behind it is
[O-010, public extension contracts of v0.1](../product/extension-contracts.md),
proposed on 2026-10-05.

## What you can rely on in v0.1

Flux 0.1 has two public extension contracts. Each one has a version number, a
compatibility promise and a snapshot that the test suite compares with the
running application.

| Contract | Use it for | Version to check | Pinned snapshot |
| --- | --- | --- | --- |
| **EXT-1** MCP tool contract 1 | Agents and scripts that read a project and act in it on behalf of one person | `trusted.playbook.toolContractVersion` returned by `flux_bootstrap` | [`mcp-tools.v1.json`](../../app/tests/app/contracts/mcp-tools.v1.json) |
| **EXT-2** project export format 1 | Archives, reports and moving a project's work to other tools | `formatVersion` in `project.json`, and in `manifest.json` of a bundle | [`project-export.v1.json`](../../app/tests/app/contracts/project-export.v1.json) |

The rest of Flux carries no compatibility promise in v0.1 and can change in any
release:

- the `/api/v1` HTTP routes other than export;
- the WebSocket stream and its event kinds;
- `@flux/sdk`;
- the GitHub bridge's internals.

Flux 0.1 has **no outbound webhooks**. It also has no general REST API for
integrations beyond the export route, no supported SDK, no plugins and no export
re-import. These are deferred, each
with a condition, in [the deferral table](../product/extension-contracts.md#deferred-scope-record-for-249).

## Compatibility rules

A version number changes only when a change is **breaking**. Within one version,
a later release may make **additive** changes:

| | Additive: same version | Breaking: new version |
| --- | --- | --- |
| **MCP tools (inputs you send)** | A new tool, prompt or resource. A new optional argument. A wider type, enum or bound. A removed pattern or format restriction. New wording. | A removed or renamed tool, prompt, argument or resource. A removed or newly required argument. A narrower type, enum, bound, pattern or format. A changed required scope, operation, peer-request classes or annotation. A changed error envelope. A removed listed error code or bootstrap key. |
| **Export (documents you read)** | A new field, even a required one. A new enum value. A tighter bound. A new bundle file. New wording. | A removed or renamed field. A field that becomes optional or nullable. A changed type, constant, pattern or format. A removed enum value. A removed or renamed bundle file. A changed manifest identification. |

To keep working across additive changes, an integration must:

- ignore fields, tools, prompts and resources it does not know;
- treat an enum value it does not know as "unknown", not as an error;
- treat an error code it does not know as a general failure, and report it;
- not depend on tool descriptions or other wording;
- stop and report when the version it reads is higher than the one it was built
  for.

A Flux server serves **one** tool contract version and writes **one** export
format version. When a release moves a contract to a new version, the
[changelog](../../CHANGELOG.md) says so. Clients built for the old version must
then be updated.

## EXT-1: connect an MCP client

### Connect and sign in

1. In Flux, the person who will own the integration creates a **personal agent**
   and a **connection**. The connection selects the projects the agent may use
   and the scopes it may hold. See [agent connection](../development/agent-connection.md).
   The connection always belongs to that one person ([F-019](../product/decisions.md)).
   A workspace admin cannot create one on someone else's behalf.
2. The client adds the server `<FLUX_PUBLIC_ORIGIN>/mcp`, using Streamable HTTP,
   and signs in with OAuth 2.1 authorization code and PKCE S256. The client finds
   the authorization server through
   `/.well-known/oauth-protected-resource/mcp`. For example:
   - `claude mcp add --transport http --scope user flux https://flux.example.org/mcp`
   - `codex mcp add flux --url https://flux.example.org/mcp`

   The Flux test suite connects with a plain HTTP client. Evidence from real
   Claude Code and Codex installations is tracked in
   [#152](https://github.com/ColdPhase/flux/issues/152) and
   [#160](https://github.com/ColdPhase/flux/issues/160).

### Start a session

3. Call `flux_bootstrap` with the project ID and a `clientSessionId`. The
   `clientSessionId` is a UUID that you create once per client session.
   - Check that `trusted.playbook.toolContractVersion` is the version you built
     for. The response's own `contractVersion` (1) versions the bootstrap response
     shape.
   - Use only the tools whose capability row says `available: true`.
   - Bootstrap `gaps` name the server providers that this server lacks.
4. Agents follow the built-in co-work playbook, which the `start_work` and
   `resume_work` prompts deliver. Scripts can call the tools directly.

### Permissions

- **Scopes are ceilings.** `flux.context.read` covers reads,
  `flux.proposal.write` covers proposals and `flux.action.execute` covers native
  actions. On every call the server checks again that the connection is live,
  and checks its owner, the agent's grant on the project and the owner's own
  rights.
- **Actions need a standing grant.** Creating a task, writing a doc, moving a map
  and other native actions also need a live standing grant. A grant has an
  operation, a class, a number of remaining uses and an expiry.
- **Revocation is immediate.** When the owner revokes the connection, the next
  request is refused with 403.

### Retries and change detection

- **Reads can be retried freely.**
- **Writes take a `clientCommandId` per intended effect.** The exception is
  `flux_acknowledge_playbook`, which is idempotent per `clientSessionId`. Send a new UUID for
  each effect, and reuse it only to retry that same effect after an uncertain
  response. A retry returns the stored outcome. The same ID with a different
  input is refused with `IDEMPOTENCY_CONFLICT`.
- **Versioned writes take the version you read.** After a `VERSION_CONFLICT`,
  read the object again and reapply your own change only.
- **Flux pushes nothing to you.** To find out what changed, call
  `flux_changes_since` with the checkpoints you recorded. Do this at your own
  safe points, not in a tight loop.

### Errors

A failed tool call returns `isError: true` with `{ "code", "error" }` as JSON
text. The codes in the contract are:

| Code | Meaning | What to do |
| --- | --- | --- |
| `MCP_SCOPE_REQUIRED` | The token lacks the scope the tool needs. | Ask the owner to reconnect with that scope. |
| `AGENT_EXECUTION_UNAVAILABLE` | No live standing grant, or no current access, covers this action. | Ask the owner for a grant, or propose instead. |
| `VERSION_CONFLICT` | The object changed since you read it. | Read it again and reapply only your change. |
| `SOURCE_VERSION_CONFLICT` | The source you cited is no longer current. | Read the current version and cite that. |
| `TASK_PREREQUISITES_UNMET` | A prerequisite task is not done. | Finish or report the prerequisite first. |
| `PLAYBOOK_VERSION_MISMATCH` | You acknowledged a playbook this server does not serve. | Load the current playbook resource. |
| `IDEMPOTENCY_CONFLICT` | The `clientCommandId` was used for a different input. | Use a new ID for a new effect. |
| `RUNTIME_UNAVAILABLE` | The client session expired, or the connection's binding or scopes changed. | Bootstrap with a new `clientSessionId`. |
| `INVALID_INPUT` | An input breaks a tool rule, for example a malformed ID. | Fix the input. Do not retry it unchanged. |
| `MCP_TOOL_UNAVAILABLE` | An unexpected server failure. | Retry later with the same `clientCommandId`, then report it. |

HTTP-level failures:

- **401:** the token is missing or invalid. The response carries a
  `WWW-Authenticate` challenge that points to the resource metadata.
- **403:** the connection was revoked, or the OAuth client was disabled.

In Flux, a project's **Agents** view shows each connection's state and its last
action. A connection that cannot act in the project says "Can’t act here now".
The owner revokes a connection on the **Connect agent** page.

## EXT-2: read a project export

- **Get it.** Call `GET /api/v1/projects/{projectId}/export`, adding
  `?format=bundle` for the `.tar.gz` bundle, or run `./flux export <project>`.
  Exporting needs `project.manage`, which workspace owners and admins have.
  See [project export](../operations/export.md) for what is included and what
  never is.
- **Check it.**
  - Verify every file against the SHA-256 checksums in `manifest.json`.
  - Validate `project.json` against `schema/project-export.v1.schema.json` from
    the same bundle.
  - Check `format` (`flux.project-export`) and `formatVersion` before reading
    further.
- **Read it with the rules above.** Ignore unknown fields, and treat unknown enum
  values as unknown. Format 1 has no re-import
  (`provenance.reimportSupported: false`).
- **Failures.** A missing session gets 401. A project you cannot see gets 404. A
  project you cannot manage gets 403. A missing or corrupt stored file aborts the
  download instead of producing a partial bundle. Retrying produces a new,
  complete export.

## For operators

- **Public origin.** Set `FLUX_PUBLIC_ORIGIN` to the public HTTPS origin. The MCP
  resource is `<FLUX_PUBLIC_ORIGIN>/mcp`, and OAuth tokens are bound to it.
- **Proxy paths.** A reverse proxy must pass `/mcp`, `/api/auth/*` and the
  `/.well-known/oauth-*` and `/.well-known/openid-configuration/*` paths
  unchanged.
- **Access.** Only the owner of a connection can use it. Connections need nothing
  configured by the operator. Restoring a backup on another machine can revoke
  every connection: `./flux restore --revoke-agent-connections`
  ([backup and restore](../operations/backup-restore.md)).
- **Upgrades.** Read the changelog before an upgrade. A new contract version is
  always listed there. After an upgrade, a client can confirm the version it
  receives from `flux_bootstrap`.
- **Failures.** Unexpected MCP transport errors are logged by the API as
  `MCP request failed`.
  For the GitHub bridge, a separate operator-configured integration, see
  [GitHub App connection](../development/github-integration/README.md). That
  page covers its signed and stored deliveries, retries, **Refresh access** and
  reconcile.

## For Flux maintainers: changing a contract

`app/tests/app/extension-contracts.test.ts` compares the running application with
`app/tests/app/contracts/<contract>.v<N>.json`. On any difference it fails and
lists each change as additive or breaking. The comparison rules are in
`app/tests/app/support/contract-compat.ts`. The failure ends with a line
`CONTRACT-SNAPSHOT <file> <json>` that holds the running contract.

1. **Additive change.** Replace the snapshot of the current version in the same
   PR. Save the JSON from that line in canonical form, for example:

   ```sh
   grep -o 'CONTRACT-SNAPSHOT mcp-tools.v1.json .*' test.log | cut -d' ' -f3- \
     | python3 -c 'import json,sys; print(json.dumps(json.load(sys.stdin), indent=2, sort_keys=True, ensure_ascii=False))' \
     > app/tests/app/contracts/mcp-tools.v1.json
   ```

2. **Breaking change.** Do not edit the existing snapshot.
   - Bump the version: `toolContractVersion` in
     `app/packages/core/src/agent-connection/playbook.ts`, or
     `PROJECT_EXPORT_FORMAT_VERSION` together with the schema id in
     `app/packages/contracts/src/export.ts`.
   - Add the new snapshot and keep the old one. The test fails if an older
     snapshot is missing.
   - Update the [decision](../product/extension-contracts.md), this guide and the
     changelog.
3. **Review.** A reviewer treats any edit that removes or narrows something in an
   existing `*.v<N>.json` as a contract change that needs a new version. The test
   cannot see repository history.

Tool descriptions and `description` keywords are left out of the snapshot. They
guide models and may change freely. Titles, names, schemas, scopes and
annotations are included.
