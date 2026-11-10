# Integrating with Flux

This guide is for two readers:

- **integrators**, who build an agent, a script or a pipeline against a Flux
  instance;
- **operators**, who run the instance those integrations connect to.

The decision behind it is
[O-010, public extension contracts](../product/extension-contracts.md),
proposed on 2026-10-05. This guide describes Flux v0.2.

## What you can rely on in v0.2

A person's own Claude Code, Codex or other MCP client signs in with Flux OAuth in one step and acts as that
person: it has the person's rights, in the spaces where AI is on, and one **What it may do** setting
([local Claude Code and Codex](../product/mcp-cowork.md)). v0.2 has no scopes to choose, no capability switches and no
per-project grants.
The [single-provider F-024 amendment](../product/mcp-identity.md) keeps one
operator-configured IdP with SSO-only ordinary login when active (otherwise
password-only), safe account migration and required offboarding. No recent-authentication or secondary
password/SSO challenge; the owner's current rights and OAuth consent still bound every request. #317's additional opaque
MCP-key surface is canceled, not implemented or promised. Retain tested
SSH/paste-back/callback guidance under #310/#152; a fully unattended CI or
header-only consumer that cannot complete supported OAuth is not advertised.
Revisit one through an admitted bounded authority/compatibility contract.

Flux has two public extension contracts. Each one has a version number and one
current snapshot that the test suite compares with the running application.
**Until the first public release nothing is kept compatible:** a change edits the
contract in place, so an integration is built against the Flux release it runs
against ([the rule](../product/extension-contracts.md#no-compatibility-before-the-first-public-release)).

| Contract | Use it for | Version to check | Pinned snapshot |
| --- | --- | --- | --- |
| **EXT-1** MCP tool contract | Agents and scripts that read a space and act in it on behalf of one person | `trusted.playbook.toolContractVersion` returned by `flux_bootstrap` | [`mcp-tools.json`](../../app/tests/app/contracts/mcp-tools.json) |
| **EXT-2** project export format | Archives, reports and moving a space's work to other tools | `formatVersion` in `project.json`, and in `manifest.json` of a bundle | [`project-export.json`](../../app/tests/app/contracts/project-export.json) |

The rest of Flux carries no contract and can change in any release:

- the `/api/v1` HTTP routes other than export;
- the WebSocket stream and its event kinds;
- `@flux/sdk`;
- the GitHub bridge's internals.

Flux 0.2 has **no outbound webhooks**. It also has no general REST API for
integrations beyond the export route, no supported SDK, no plugins and no export
re-import. These are deferred, each
with a condition, in [the deferral table](../product/extension-contracts.md#deferred-scope-record-for-249).

## Reading the contracts

Nothing is kept compatible before the first public release, so a release can change
either contract. The [changelog](../../CHANGELOG.md) lists the changes. To keep an
integration robust, it should:

- ignore fields, tools, prompts and resources it does not know;
- treat an enum value it does not know as "unknown", not as an error;
- treat an error code it does not know as a general failure, and report it;
- not depend on tool descriptions or other wording;
- stop and report when the version it reads is not the one it was built for.

A Flux server serves **one** tool contract version and writes **one** export
format version.

## EXT-1: connect an MCP client

### Connect and sign in

1. Nothing is set up in Flux first. The person who will own the integration signs in to Flux in their browser
   when the client asks, and chooses **Allow** on the one consent page; Flux then makes the client's agent and
   its connection. The connection always belongs to that one person ([F-019](../product/decisions.md)); a
   company admin cannot make one on someone else's behalf. See
   [agent connection](../development/agent-connection.md).
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

3. Call `flux_bootstrap` with the space's ID (the API and the tools call a space a project) and a `clientSessionId`. The
   `clientSessionId` is a UUID that you create once per client session.
   - Check that `trusted.playbook.toolContractVersion` is the version you built
     for. The response's own `contractVersion` (2) versions the bootstrap response
     shape.
   - Use only the tools whose capability row says `available: true`.
   - Bootstrap `gaps` name the server providers that this server lacks.
4. Agents follow the built-in co-work playbook, which the `start_work` and
   `resume_work` prompts deliver. Scripts can call the tools directly.

### Permissions

- **The client is its owner.** The only scope is `offline_access`: a client asks for no read, propose or execute
  scope, and the person chooses no project and no capability. On every call the server checks again that the
  connection is live, then checks the owner's own rights, in the spaces where AI is on. A client never sees or
  changes more than its owner can.
- **"What it may do" is the owner's.** The connection starts at **Do it and tell me**; the owner sets **Only read**
  or **Ask me first** in Settings → AI. Deleting and other people's things always wait for the owner's OK, in the
  owner's signed-in session; a client's token cannot approve its own waiting change.
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
| `AGENT_EXECUTION_UNAVAILABLE` | The owner has no current access that covers this action. | Tell the owner; do not look for another path. |
| `AGENT_ONLY_READS` | The owner set "What it may do" to Only read. | Change nothing and say what you would change. |
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

In Flux, the owner sees each connection under **Settings › AI › Local co-work on this computer**, with its **What it may
do** setting, and **Disconnect** there revokes it at once. A change a client made shows its change line ("Ada · via Claude Code") with Undo where it was made.

## EXT-2: read a project export

- **Get it.** Call `GET /api/v1/projects/{projectId}/export`, adding
  `?format=bundle` for the `.tar.gz` bundle, or run `./flux export <space>`.
  Exporting needs `project.manage`, which a space's admins and the company's owners and admins have.
  See [project export](../operations/export.md) for what is included and what
  never is.
- **Check it.**
  - Verify every file against the SHA-256 checksums in `manifest.json`.
  - Validate `project.json` against `schema/project-export.v1.schema.json` from
    the same bundle.
  - Check `format` (`flux.project-export`) and `formatVersion` before reading
    further.
- **Read it with the rules above.** Ignore unknown fields, and treat unknown enum
  values as unknown. The format has no re-import
  (`provenance.reimportSupported: false`).
- **Failures.** A missing session gets 401. A space you cannot see gets 404. A
  space you cannot manage gets 403. A missing or corrupt stored file aborts the
  download instead of producing a partial bundle. Retrying produces a new,
  complete export.

## For operators

- **Public origin.** Set `FLUX_PUBLIC_ORIGIN` to the public HTTPS origin. The MCP
  resource is `<FLUX_PUBLIC_ORIGIN>/mcp`, and OAuth tokens are bound to it.
- **Proxy paths.** A reverse proxy must pass `/mcp`, `/api/auth/*` and the
  `/.well-known/oauth-*` and `/.well-known/openid-configuration/*` paths
  unchanged.
- **Single sign-on.** When people sign in through an OIDC provider, MCP clients
  still use Flux's own OAuth; the provider only signs the person in. Offboarding,
  provider settings and the proposed variables are in [F-024](../product/mcp-identity.md#mcpid-6--operator-configuration).
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
the one current snapshot, `app/tests/app/contracts/<contract>.json`. On any difference
it fails and lists every changed path
(`app/tests/app/support/contract-snapshot.ts`). The failure ends with a line
`CONTRACT-SNAPSHOT <file> <json>` that holds the running contract.

1. **Change the contract.** Edit the snapshot in place in the same PR. Save the JSON
   from that line in canonical form, for example:

   ```sh
   grep -o 'CONTRACT-SNAPSHOT mcp-tools.json .*' test.log | cut -d' ' -f3- \
     | python3 -c 'import json,sys; print(json.dumps(json.load(sys.stdin), indent=2, sort_keys=True, ensure_ascii=False))' \
     > app/tests/app/contracts/mcp-tools.json
   ```

2. **No version bump, no older snapshot.** Nothing is kept compatible before the
   first public release. `toolContractVersion` (in
   `app/packages/core/src/agent-connection/playbook.ts`) and
   `PROJECT_EXPORT_FORMAT_VERSION` (in `app/packages/contracts/src/export.ts`) stay
   as they are.
3. **Review.** The snapshot diff is the review surface. Add a changelog entry in
   `changes/` for what people or operators see.

Tool descriptions and `description` keywords are left out of the snapshot. They
guide models and may change freely. Titles, names, schemas, scopes and
annotations are included.
