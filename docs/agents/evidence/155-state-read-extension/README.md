# Bounded open/history state read implementation — #155

2026-10-03. Actual runtime source `a47985a056fe9df9315f94b0bd7c10434097e6e4`, own branch
`claude-maurycy/155-truthful-typing`, existing draft PR170.
Contract: [accepted extension](../../../development/performance/2026-10-01-native-state-read-extension.md).

The additive summary includes open counts/first work and retained completed,
not-pursued/parked counts plus newest work/decision refs. Three extra id/kind/title
refs maximum; aggregate and LIMIT1 reads stay in the existing read-only repeatable
read observation with final exact session/current project authorization. Existing
native commands/storage constraints/all-and-mine selection remain unchanged.
The state row/overview consume bounded refs; history is quiet when current state
already supplies orientation, and native kind/id identities remain distinct.

Actual Docker `run-focused.sh`, ports18619/18620: EXIT0. Build/typecheck/lint
passed (one pre-existing WorkReadContext unnecessary-useMemo-dependencies warning,
zero errors). All63 query/key/service/client/native/architecture tests PASS, no
skips. Native HTTP/SQL cases prove open/history counts, deterministic tied-createdAt
UUID ordering, bounded ref fields, actual pivot parking followed by done and
not_pursued transitions clearing parking, illegal parked-finished storage rejection,
exact session/current denial fences and same-name owner identity. Genuine accepted
and superseded decisions are counted together. Client tests separately cover the
superseded-only display branch; **superseded-only native SQL fixture is still
unverified**, not inferred from the client fixture.

The tracked runner uses this branch's trusted Compose configuration, replacing
only its API test selection. Its remaining configured phases also passed: PWA3,
access-stream1, session/material/conversation persistence after API restart,
Push-unavailable1 and SMTP-unavailable1. This is not the full API suite or the
newer main branch's complete browser phases. Setup/all34 foundation/diff PASS.
The first run failed because the new fixture attempted parking without an earlier
superseded rule; production correctly refused PIVOT_NEEDS_EARLIER_DECISION.
Correcting the fixture to a real accepted-rule/pivot flow passed. Both raw logs are
preserved. Only disposable test stack/volumes/per-run images were cleaned; existing
user previews and original branches remain intact.

`sha256.json` pins changed runtime/test inputs and raw output files. Runtime source
was committed after the run began; those tracked bytes are identical to the tested
working snapshot. The later evidence commit changes no runtime source.

Next: integrate current main55c54735 without dropping bounded reads, genuine-agent
attribution, canonical native task mappings/command identity and reader guards;
run unchanged main test_project_state and affected API/UI/composed checks. Obtain
fresh separate rendered assessment and eligible independent peer evaluation.
Superseded-only native fixture, assistant/LinkPicker migration, full performance
matrix, typing/task/main composition and original #155 AC1–AC5/device/client/release
requirements remain open. Draft is not ready for merge or whole-task acceptance.
