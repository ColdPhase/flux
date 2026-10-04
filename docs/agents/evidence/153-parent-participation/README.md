# Parent participation and accepted-main integration (#153)

Runtime: `e79336dc41007061313025d37271b28244181d8c`. The evidence commit changes documentation only.
Owner: Zamojski5, existing branch `claude-maurycy/153-cowork`, draft PR #166.
Original AC1–AC5 remain open. No public MCP action or client scheduling is enabled.

The branch integrates accepted main `3abbd0f4` (native actors/roots, connection
operation mapping, protected #136 partial UI and independent theme choices).
It preserves #153's exact coordination-target adapter. Migration-arrival tests
now exercise 0038 as well as the existing 33/34/35/37 orders; no frozen migration
was edited. The actual sender `cowork.request` operation and request-postcondition
hook are inherited from accepted main, but #153 admission is still unfinished.

A parent request can be extended only by its recorded sender or addressed
recipient connection. Sharing an owner and root/run gives no third connection
that privilege. Denial has the same unavailable result as an absent parent;
requests, outbox and lineage budget remain unchanged. Both an original-sender
follow-up and a recipient's response preserve the canonical lineage.

## Executed checks and retained failures

- The new real-PostgreSQL regression against pre-fix runtime `d8d4ad58` fails:
  third connection returns `created`, expected `unavailable` (1 test, 1 failure).
  `/tmp/flux153-parent-party-baseline.log` is retained; the test source was newly
  added to that runtime and is not claimed to be part of its committed tree.
- First integrated full run at `ea48915c`: **442 pass / 8 fail**. The merge
  preserved the grant adapter but omitted its route wiring, so every actual
  co-work grant fixture answered content-free 404 `OBJECT_NOT_FOUND` instead of
  201. `/tmp/flux153-main-parent-party-full.log` is retained. Restoring the
  explicit server-owned route adapter fixes this integration error without
  widening exact target/role authority or changing assertions.
- Corrected current `scripts/check_application.sh` through Docker: **EXIT0,
  450/450 application tests, no skips**, build/typecheck/lint; HTTPS PWA3,
  access-stream1, genuine-actors1, request-bound consent1, session restart,
  unavailable Push1/SMTP1. The new parent regression and all claim/receipt/
  recovery/migration cases pass. Log: `/tmp/flux153-main-parent-party-final-full.log`;
  browser evidence: `/tmp/flux153-main-parent-party-final-browser`.
- Foundation/setup/local-link checks, 34 host foundation tests and whitespace
  pass. App tests/toolchain/services use Docker, with disposable ports18861/18865;
  own resources cleaned. Existing preview18581 is preserved.

Source/log byte pins are in [manifest.json](manifest.json); raw logs remain local
and are not claimed published. No fresh UI design is introduced by the parent
storage guard. The integrated UI's earlier independent proofs retain their own pins.

## Remaining scope

Peer F1 backup fixture is fixed in accepted #167/main; the previous failure is
not relabeled as an executed #153 backup success. Peer F4 parent participation
is repaired pending fresh independent evaluation of this head. F2 late-commit
scan ordering remains required before #160 consumes recovery: the future
admission must retain the complete sorted recipient/sender slots through commit;
an exhausted continuation does not certify completeness. F3 live sender-unit
admission, exact sender grants and request postcondition wiring remain unfinished.

#171 graph primitives are independently reviewed but not merged at this checkpoint.
Production graph/reviewer/checkpoint policy, checkpoint creation, native fenced
publication/final flush, request admission/claim/resolution/supersession, scheduler,
real two-owner/three-connection supported-client flows, UI and device/release
acceptance remain open. Trusted storage fixtures are not provider/client proof.
