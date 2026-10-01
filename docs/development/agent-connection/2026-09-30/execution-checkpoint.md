# Grant and command execution checkpoint

Verified 2026-10-01 at source
`606c97c66d6077625d8472b2c1f8e16edc9390de`, branch
`codex-hubert/152-multi-connections`, draft PR #167. This records a partial #152
implementation and a concrete interface for #153, not whole-issue acceptance.

The owner grant API now creates, lists and revokes exact project/operation/class/
optional object ceilings under current management rights. Creation has durable
command identity, so retries do not create extra ceilings. Metadata history is
owner-only and bounded; it reads no project/result names. The runtime port binds a
server-issued session to the actual OAuth client and durable binding generation.
The shared execution port prepares and completes inside a caller-owned transaction,
rechecks current authority/source/produced-state and stores one connection-command
receipt plus one debit. It recomputes normalized fingerprints itself. Exhausted
last-use retries retain the original effect; expired/revoked authority still denies.

The explicit third OAuth scope is retained in signed flow selection, provider
issuance/refresh, bearer checks and runtime identity. Old read/propose selections
and requests are not upgraded. Consent explains **Run approved project actions**
and the separate current owner grant condition. The canonical postcondition registry
matches #153's `cowork.claim_state` shape and fails closed on unknown/malformed,
missing, duplicate, cross-operation or context/role-mismatched conditions.

## Executed checks

- Docker build, TypeScript checks and lint passed. Logs:
  `/tmp/flux152-final-ledger-build.log` and the full script log below.
- 32 focused Docker checks passed, including owner API management/idempotency/
  bounds/history, same-client two-owner/three-connection provider flows and refresh
  isolation, signed scope substitution, native reads/private ceilings, legacy schema
  preservation, ledger/architecture, exact payload hash normalization, one effect/
  debit/receipt under concurrent retries, last-use retry, changed sources and produced
  task, forged/reused scopes, rollback before and after debit/receipt, expired/revoked
  runtimes/grants and real PostgreSQL lock waits. Log:
  `/tmp/flux152-final-ledger-targeted.log`.
- Fresh Chromium third-scope signed-out sign-in/two-tab consent passed. The test
  creates two connections under the same actual OAuth application and verifies
  each returned connection identity. Log: `/tmp/flux152-third-scope-browser.log`.
- The trusted `scripts/check_application.sh` passed all **347** application tests,
  existing browser/service-worker/access checks, the third-scope consent browser
  check, API restart persistence and unavailable push/email phases. It ran with
  independent ports 18352/19352 and removed only its own disposable stack. Log:
  `/tmp/flux152-final-ledger-full.log`.

The focused test and browser image source hashes were compared against repository
bytes before recording these results. The full script rebuilt its isolated images.
The architecture allowlist did not grow. The fixture using a canonical agent task
queues its one event and flushes it only after receipt/debit; production multi-domain
tools await the independently verified shared collector.

## Rendered evidence and limits

Current screenshots at this source pin are
`evidence/agent-consent-desktop.png` (1280px viewport, SHA256
`9b425ba42959f884f51bc3b3f4e544872063aaf95ee8de12dc00364de31179d3`)
and `evidence/agent-consent-phone.png` (390px viewport, SHA256
`5b9ecafbadc5fa45367e1083cea92040c5a0ef5ce86140807ff4c12fa991b9b3`).
Fresh independent visual assessment is requested. The previous independent
two-action assessment is historical and does not certify these changed states.
Screenshots do not establish accessibility, interaction or actual client support.

Native action MCP tools remain unavailable: the ledger and grant API do not by
themselves enable task/result/decision/map/wiki/conversation writes. Verified #154
actor/deferred discussion consumption, shared native event composition, task
criteria/dependencies/plan intent, bounded bootstrap/orientation/changes-since,
#153 coordination and actual pinned Codex/Claude model-driven activation remain
required. Trusted bearer/provider/browser fixtures are not real model activation.
The PR and #152 remain open; final eligible evaluation must be independent.
