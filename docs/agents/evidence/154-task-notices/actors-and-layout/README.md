# Genuine task actors, deferred events and accepted application layout

Captured 2026-10-01 Europe/Warsaw. Issue #154 / draft PR #164 remains incomplete;
the original AC1–AC5 are retained. This checkpoint supplies the shared primitive
needed by #152/#153, with actual author identity and no fabricated opening message.

## Exact sources and verification

- `40732b4383ae9e31bc1cc455bde137c4087ddb6e` integrates accepted main
  `7af78f29c7da3799a57bf204b343b5647516afc5`: application sources/tooling/tests in
  `app/`, Docker inputs in `docker/`, accepted test-file concurrency4. The complete
  configured Docker command exited0: **346/346** application checks,3 HTTPS PWA,
  1 access-stream,1 genuine-actor Chromium, existing session/material/linked
  conversation after an actual API restart,1 unavailable-push and1 unavailable-email.
  Build/type/lint/architecture are included. See [sanitized full run](docker-full-40732b4-summary.txt).
- `72d743dfc662473ff8446bde6e3d69e3db362148` changes audience wording and the
  read-only composer, its styles and browser regression. Fresh Docker build/type/lint
  and **39/39** task/conversation/search/export/historical-migration/architecture
  checks,1 access-stream and1 actor Chromium pass, exit0. The real reader has no
  reply/send controls; keyboard-operated Sources opens and closes, and a real
  reader POST is403. The owner audience includes the agent without an exclusive
  two-person claim. See [current focused run](docker-focused-72d743d-summary.txt).
  The full346 run is attributed to40732b4, not claimed as repeated at72d743d.
- The independent [functional report](independent-functional-review.md) passes99
  affected integrations at `8f4a7892e0dcb1cc42ada6bd3ecad8918b9fcb9f`, plus actual
  browser/restart/worker/rights checks at
  `2093a8ca69a5eb3523c80ef9eb466fce75324051`. Their difference is4 browser
  response-wait lines. The actor/contribution code maps byte-identically into the
  accepted layout. [Mapped source comparison](layout-source-equivalence.json)
  records426 identical inputs and3 changed layout helpers; it does not claim all
  layout/config inputs unchanged. The later full run verifies that integration.

Actual actor storage uses migration0037 after frozen0033; old human rows, times,
source/version, sequence, fingerprint and search provenance are compared without
backfill. Human wire fields remain unchanged. Agent authors use an explicit tagged
variant throughout current conversation/list/root, helper context, Search, export,
notifications, Return/digest and UI. Independent identical human/agent display-name
cases distinguish the real identities; current rights are required for new writes
and exact replay, while restrictive history retains revoked authors.

`taskDiscussionInTransaction(tx)` prepares canonical IDs and frozen event intents
inside the caller's open transaction. After all grant debit/coordination/receipt/
outgoing writes, the caller must await final `flushEvents()`. All audiences are
resolved before the first stream event insert. Premature flush and later actions
are rejected; repeats reuse the same promise; replay emits no event. Actual outer
failure before or after final flush rolls back content/binding/sequence/search/
events/outbox. This is not a claim of actual #153 claim/receipt/client integration.

## Visual evidence and remaining acceptance

The subsequent independent [current UI assessment](independent-current-ui-review.md)
at704042d (production identical to72d743d) passed39 affected checks, access/actor
Chromium and fresh typecheck/lint. Its actual same-name owner/reader1280/390
states confirm keyboard Sources, no reader reply controls, actual POST403 and
persisted owner replies. The [manifest](independent-current-ui-manifest.json)
separately pins those runs and four `independent-704042d` frames. Its pixel opinion
is still LIMITED; no fresh visual certification is inferred.

The [limited independent visual report](independent-visual-limited.md), at2093a8c,
identified ambiguous audience wording and a reply-shaped reader composer. Both
are corrected and exercised at72d743d. Current frames are
[owner1280](current-72d743d-agent-root-desktop.png),
[reader1280](current-72d743d-mixed-authors-reader-1280.png) and
[reader390](current-72d743d-mixed-authors-reader-390.png).
Independent same-name frames remain separately prefixed `independent-2093`.
The evaluator had prior implementation context; a **fresh external neutral visual
assessment remains required**. The [neutral brief](neutral-visual-brief.md) supplies
the current hashed inputs, without implementation rationale. Screenshots do not
certify interaction, permissions, accessibility or physical device installation.

Real stored-byte/attachment-only contributions, blocker/result/public-handoff
adapters, safe unused-AI undo, integrated #136 Conversation/Tasks/Map/Agents shared
draft/root identity, real authenticated #152/#153 grants and supported clients,
guarded pre-use reversal/post-use refusal/paired recovery and both pending migration
composition orders remain required. No whole-PR approval, release, provider or
Android/iPhone/iPad installation/push acceptance is inferred.

[Manifest](manifest.json) pins tested source, input/artifact hashes, raw private
log identities and exact run scopes. Only sanitized test/stage summaries are
published; failed earlier attempts retain their original status in the independent
report. Run-owned containers, volumes and image tags were cleaned without touching
peer resources. Current foundation/Python/whitespace checks are recorded after this
evidence-only change, separately from the application runs.

## Later shared native work/result event composition

Before implementation, the bounded [composition proposal](../../../../development/task-discussions/2026-10-01-native-event-composition.md)
received an [independent acceptance](../../../../development/task-discussions/2026-10-01-native-event-composition-review.md)
at exact proposal SHA633ad72 and existing704042d source. Runtime source
`daa66f06ef81a31e42357adde5555f0318bbfb84` adds one shared guarded event session.
`nativeWorkInTransaction(tx)` exposes existing work/result/decision plus genuine
discussion on the caller's same transaction and event collector, with one final
audience flush. Ordinary work HTTP awaits that flush; helper proposal acceptance
prepares the actual accepting human's result and proposal decision together,
hydrates the response and then flushes once. Nested independent native commits
and early inline result events are removed from that composition.

Fresh complete configured Docker build/type/lint/application atdaa66f0 exited0:
**349/349**,3 PWA,1 access-stream,1 actor Chromium, actual API restart with original
session/material/linked conversation and unavailable push/email checks. The
[sanitized native full run](docker-native-full-daa66f0-summary.txt) and manifest
retain its source and private raw-log SHA. Three new actual SQL cases prove
native task/result plus genuine agent root with no pre-flush stream lock,
final-state audience changes, no domain reads/writes after first event insertion,
before/after-flush full rollback and immutable nested intents/lifecycle. Existing
helper proposal acceptance now also proves rollback after the actual proposal
decision and success through an instrumented real transaction without a nested
native savepoint or late response/domain queries. Production deadlines are unchanged.

Fresh independent **runtime** review of this new composition remains pending;
the independently accepted design and prior704 UI review are not its acceptance.
No #152/#153 actual authority/receipt/outgoing/claim integration is inferred.
Blocker/result/public-handoff messages, files, undo, shared drafts and all other
remaining original criteria above remain open.
