# Bounded human typing core checkpoint — #155

2026-10-01. Actual runtime/test source:
`1da05eb78a5439ca1dc203a68309eef321282594`, based on accepted main
`7af78f29c7da3799a57bf204b343b5647516afc5`. This checkpoint changes only
wire types, the closed-command parser and injected internal ephemeral lifecycle.
No typing endpoint, public snapshot, SQL adapter, browser hook or visible typing
has been delivered yet. Issue #155 and every whole application criterion stay open.

## Actual commands and outcomes

```sh
docker build --target test -t flux-typing-core:155-d8cc -f docker/Dockerfile app
docker run --rm flux-typing-core:155-d8cc pnpm exec tsx --test tests/app/typing-core.test.ts tests/app/architecture.test.ts
python3 scripts/check_agent_setup.py
git diff --check
```

Docker build, type check and lint passed. **21/21 core + architecture checks
passed**, no skips,895.044417ms. [Build log](build.log), [test log](tests.log)
and [input/image/log hashes](inputs.json.gz) retain the actual tested pin. These
readable logs remove trailing spaces only. Original terminal bytes are preserved
in the [raw build log](build.log.gz) and [raw test log](tests.log.gz), with compressed
and decompressed hashes in the manifest; source and results are unchanged. These
are pure injected metadata/clock fixtures, not PostgreSQL or two-user API/browser
proof. No database/services were started; the test container was automatically
removed. The dedicated image tag belongs to this checkpoint only.

## Meaningful cases and independent findings

Closed input rejects forged author/session/name/text/expiry and recursive extra
fields without echoing private input. Lifecycle fixtures cover stop/late activity,
coalesced A→unwatched B withdrawal, unknown B before older A, listener generations,
expiry, immutable configuration, bounded context/global saturation, discarded
active/stop quarantine, defensive copies and clock reversal before/after pruning.
Anonymous sequence watermarks retain no foreign actor/session/context metadata.
Positive monotonic expiry does not remove still-needed negative DB-time fences;
the observed DB-time floor never lets expired metadata become valid again.

Earlier15/16/20-check passes were insufficient: separate read-only source review
found and the author corrected stop rejection after clock reversal, pruning/
saturation revival, caller-mutated limits and expired-after-clock-reversal revival.
The final independent reviewer gave bounded source/design agreement at the
current tested source with no remaining material parser/lifecycle finding.
That reviewer ran no runtime tests and provided no whole-task approval.

## Required next composition and acceptance

Follow the [current typing contract](../../../development/typing/2026-10-01-contract.md).
DB-time observations must be ordered/fenced: an older query completing late
cannot be treated as an actual clock reversal. Implement exact current sender
session↔human↔expiry proof, central current sender/receiver native policy and open-DM
write parity, strict internal broker decoding, ordered bounded publication,
listener clean-end/error/reconnect and in-flight generation fences, socket
admission/backpressure and authorized deduplicated current names. This store's
candidates are internal references, never public authorized snapshots.

Main lacks #154 canonical Task-discussion composition. Integrate its actual
accepted mapping; never invent a parallel chat or create a root on a typing read.
Then run actual Docker two-user SQL/network/browser no-durable-effect, withdrawal,
listener/restart, draft/focus/source/scroll and measured stress proof. No performance
budget, real typing, physical device, motion, actual-agent or full #155 acceptance
is claimed by this checkpoint. No endpoint has been registered.
