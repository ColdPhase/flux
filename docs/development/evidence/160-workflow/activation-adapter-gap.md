# Native activation and live adapter gap, 2026-10-18

Static preparation for #152/#160 and Draft #616, not an accepted amendment or
new implementation. Whole criteria remain those in the issue contracts and
`docs/product/cowork-workflow.md`. The existing proposed managed-control document
is not accepted by this note. No new public authentication/control protocol,
OAuth client keys, credential export, DCR, or permission bypass is proposed.

## Exact production first-login control (prepared, unrun)

Select `FLUX_TEST_MCP_LIVE_WORKFLOW=1`, `FLUX_TEST_MCP_LIVE_CLIENT=codex`,
`FLUX_TEST_MCP_OAUTH_ONLY=1`, `FLUX_TEST_MCP_OAUTH_PRODUCTION_FIRST=1` through
`scripts/check_mcp_clients.sh`. The selector rejects comparison/default-callback
modes, uses the credential-free overlay, a fresh HOME with no native config,
and calls exactly the supplied command:

```
codex -c 'mcp_servers.flux.url=<bound URL as JSON>' -c 'mcp_servers.flux.required=true' mcp login flux
```

No seeded OAuth client, native `mcp add`, client ID, callback URL/port, file-store
or registration override is supplied. The native authorize URL is retained only
in process memory. Its `redirect_uri` must be an HTTP loopback callback; the
browser uses that private target/port internally. Output stays fixed-label
phase/code/HTTP/target-class/native-exit diagnostics; no URL, port value, suffix,
code/state/issuer value or native stderr is emitted. Login-only returns before
any model execution and asserts no task was created. No account credentials are
mounted. No execution of this control has been authorized or performed yet.

The persisted-bound test remains a separate native cache/config compatibility
control, not clean Connect→Start proof. Both use test-side command composition;
whole supplied launcher acceptance still requires the actual outer entrypoint
or an explicitly faithful complete integration, beyond earlier shell stubs plus
compiled-helper verification. Do not force a cache backend or remove
`--ignore-user-config` to obtain a pass.

## Existing CIMD policy

`app/apps/server/src/identity/auth.ts` uses `cimd({
fetchClientMetadataResource, metadataProfile: 'mcp-2026-07-28' })` from
`@better-auth/cimd` **1.7.6**, including its hardened Node transport. Flux does
not supply `isMetadataDocumentUrlAllowed` or a vendor-host allowlist. Source of
the locked package was read, not installed/executed, from the public npm
[1.7.6 archive](https://registry.npmjs.org/@better-auth/cimd/-/cimd-1.7.6.tgz).
It validates HTTPS/public-routable host and DNS addresses, pins an allowed DNS
address for TLS, and forbids redirects. Thus `chatgpt.com` is not excluded by
an explicit host list; actual DNS, response/profile compatibility and connectivity
remain runtime gates. DCR and browser client-management remain disabled.

Current [official OpenAI MCP documentation](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)
retrieved 2026-10-18 describes automatic CIMD selection with the advertised
metadata capability, public authentication and loopback redirect. It describes
ChatGPT-hosted metadata and stable issuer-bound callbacks. These vendor claims
support testing the normal path; they do not establish behavior of pinned0.160.1
or explain earlier preregistered controls. Offline add-generated callback shape
is not the successful online add's callback shape.

## Pinned native interface observation

[Public schema extract](codex-0.160.1-app-server-extract.json) records the separate
root-authorized network-none metadata micro. Pinned0.160.1 successfully generated
schemas; it did not start app-server, initialize OAuth, call a tool or run a model.
`thread/start`, `thread/resume`, `turn/start`, `turn/steer`, `turn/interrupt`,
`mcpServer/resource/read`, `mcpServer/tool/call`, and `mcpServerStatus/list` are
present. Tool-call requires `threadId`, `server`, `tool`; status supports a
`threadId` filter. Resource-read points to `McpResourceReadParams`, but the small
extractor omitted that definition, so its exact required fields remain a narrow
metadata gap. No additional probe was made to fill it.

Current [official app-server documentation](https://learn.chatgpt.com/docs/app-server),
retrieved 2026-10-18, describes persistent private stdio sessions, thread/turn
control and configured MCP access. Existing `docs/development/evidence/460/
codex-interrupt-probe.ts` exercises a private scripted-model interruption
primitive only. Neither proves current Flux setup, safe checkpoint delivery,
idle wake, native MCP authentication, or production cancellation.

## Smallest adapter proposal before implementation

Keep one private official app-server child owned by `./flux cowork`, immutable
connection/project/cwd and exact adapter-created thread. Browser cannot launch a
closed native program. Native OAuth stays inside that official process; reuse
existing Flux grants, task/unit/checkpoint/inbox and replay fences. No companion
bearer/token extraction or parallel task store. Store only private IDs/outcomes;
RPC context is ephemeral, not saved transcripts or credentials.

| Gap in current finite `exec` launcher | Proposed bounded behavior using existing domain |
| --- | --- |
| Clean setup and current guidance | First prove the exact login-only path above. Start/resume own thread, require named MCP status, read current server resource and bootstrap through native MCP before a model turn; fail closed on native/auth/resource/schema gaps. Refresh current playbook/policy and source changes on Resume. No model solely to discover/read the authoritative bundle. |
| Busy recipient | Read only the bounded addressed inbox without a model. Receipt does not claim/delete work. Hold incoming requests while busy; handle only after current owned turn finishes and canonical checkpoint/unit state establishes a safe boundary. `item/completed` alone is not proof of a safe checkpoint; do not steer arbitrary peer text into unrelated active work. Preserve existing target/version/defer/priority/budget rules. |
| Idle wake | A single non-LLM bounded-inbox/status waiter may back off under CW-3, with no repeated global scan. Only actual eligible change plus current grants/control/lease checks may schedule a bounded turn; re-read canonical state after reconnect. Proposed polling bounds/latency and turn/owner limits need explicit decision and measured acceptance. Native tool calls, network requests and model turns counted separately. |
| Pause | Current launcher has no browser-pause observer or safe-boundary ACK. Need an owner-authorized durable pause intent on existing unit/control state, with expected version, no new-work admission, checkpoint/release at the safe boundary, and requested versus acknowledged projection in the same Agents/tasks. Exact existing operation reuse or the minimum contract addition must be decided before code. |
| Stop/revocation/lease loss | Existing stop releases the native Flux task and stops units immediately. The child must observe that canonical state, block further scheduled turns, and cancel only its own active thread/turn using native interrupt where available. Observe terminal acknowledgement; never kill arbitrary user CLI or label server hold release as local cancellation. On unavailable local ACK show that truth. |
| Restart/retry/capability/policy changes | Resume own explicit thread only. Re-read canonical units/checkpoints/inbox/current capabilities and playbook; never reuse stale claim or replay authority. Missing/changed source, policy, auth or lease stays visibly pending/blocked, with no alternate account/payer. |

The smallest remaining native question is whether these pinned thread-bound MCP
RPCs work with the exact clean native OAuth setup without a model, including
resource-read parameter shape, required-server failure and per-thread instruction
refresh. Schema presence alone is insufficient. Parent chooses the contract
amendment before implementation; one scoped model-free transport gate should
precede genuine one-Start/one-Resume acceptance. Busy/defer/wake/controls and the
full original matrix remain required even if that bounded pair succeeds.
