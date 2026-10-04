# Current authorized pending recovery — partial #153

Verified 2026-10-01 on `claude-maurycy/153-cowork`, draft PR166.
Exact full-tested runtime and tests:
`664ce62e6181463e54e51cc57e85297d83e6dcdf`.
Predecessor canonical claim/execution evidence remains separately pinned to
07bd in [execution evidence](../153-cowork-execution/README.md).
No original AC1–AC5 or full application acceptance is declared complete.

## Executed verification

Complete configured `FLUX_TEST_PORT=19051 FLUX_TEST_MAILPIT_PORT=19052
./scripts/check_application.sh` PASS, terminal41354 exit0:

- Docker build/typecheck/lint.
- **424/424** application tests,59.763s, no skips.
- 3 PWA;1 access/stream browser;1 genuine human/agent actor browser;
  1 signed scope/connection consent browser.
- Stored session/material/linked conversation after API restart.
- 1 Push-unavailable;1 SMTP-unavailable.

Exact log: `/tmp/flux153-recovery-application.log`.
Setup/local links,34 Python tests and whitespace PASS.
Independent read-only source review found no actionable flaw; the reviewer ran
no tests. It does not count as eligible whole-task approval.

The preliminary `/tmp/flux153-recovery-build.log` also passed build/type/lint,
but preceded two final test assertions about another valid binding and an anchor
leaving pending state. Only the complete configured run above verifies the exact
committed source and all assertions; no older image is used as acceptance proof.
All dependencies ran in Docker on isolated task ports, with no host services.
The configured script removed its own stack/images after completion.

## Seven added actual SQL/current-policy checks

Fixtures create two real human owners and native API records, current central
human/agent project grants, named connections and trusted OAuth bindings.
Enqueue and binding admission remain explicit trusted fixtures: this is not a
public MCP or real supported-client/model activation claim.

1. Fifty-five inaccessible packets before two visible requests are filtered
   before pagination. A one-item page returns the first visible request and its
   encrypted continuation reaches the second without repeats. No hidden IDs,
   labels, body, owners, fingerprints, total/scanned count or authority appears.
   Repeated reads and a transport ACK retain the57 durable requests without
   creating runtime sessions, standing grants, claims or command receipts.
2. Actual native message/result/doc/project thought references recover together.
   Every source, criterion, dependency and response is checked; a missing
   dependency/response or changed thought version excludes the whole packet
   without rewriting its original references or resolving it.
3. Private map thoughts and GitHub references stay unavailable and cannot
   suppress an authorized page or create a misleading continuation.
4. Three request timestamps one microsecond apart paginate exactly once. AES-GCM
   cursors preserve those positions and their original deadline. Cold reconnect
   with the same server secret/context succeeds; another connection, another
   currently valid OAuth binding on the same connection, a different secret,
   tampering and an expired authenticated token require a content-free resync.
   An unselected project remains unauthorized before cursor recovery.
5. Wrong actual client or missing scope denies; a current central agent deny
   blocks continuation, restoring current reader authority permits it, and
   connection revoke denies even a malformed cursor before queue projection.
6. A resolved but retained anchor remains a valid continuation. Deleting that
   anchor requires an explicit new snapshot; source edits exclude affected
   packets but leave their queued state/version unchanged. Oversized/invalid
   page inputs are rejected.
7. A lost claimed request is observed as recoverable queued metadata without
   altering its persisted state/version or inventing a new lease.

## Scope and remaining outcomes

`coWorkRecovery` reauthorizes the current verified connection/binding and central
selected-project policy before decoding a cursor. The SQL visibility predicate
covers exact current native references before limit+1. Projection contains only
bounded control state and original pointers. A15-minute cursor binds workspace,
project, connection, owner, client and OAuth binding; it cannot extend its first
deadline or disclose a raw keyset/global position. There is no claim, ACK,
completion, debit, content, notification or model effect from recovery.

Changed/unavailable requests remain durable and unresolved. A fresh snapshot
is needed after a gap or to discover older packets whose sources later become
valid. Coverage is explicitly current authorized native pending references;
GitHub delivery still requires the receiving owner's own verified repository
access and current-reader provenance policy. Exclusion is not successful work.

Public tool/bootstrap/client wiring, complete production graph/reviewer/source
policy, checkpoint production and fenced native publication, request admission/
claim/resolution/supersession, fair safe-checkpoint scheduling, actual two-owner/
three-connection model-driven Start/Resume and loaded instructions, integrated UI,
physical device and release acceptance remain required. The current cursor and
server policy tests do not prove those client/end-to-end outcomes.

[Exact source/input/log manifest](source-sha256.json).
