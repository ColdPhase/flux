# Explicit native contribution effects on the canonical task thread

Captured 2026-10-01 Europe/Warsaw. Issue #154 stays open; its original AC1–AC5 are
retained. This is the first part of the
[2026-10-01 contract](../../../../development/task-discussions/2026-10-01-contribution-effects-and-files.md):
saved blocker, published result and explicit public handoff contributions. Stored
files, attachment-only messages, shared drafts, unused-AI undo, the real #152/#153
tools, supported clients and device acceptance are **not** covered.

## Source and verification

- Tested source `a846a31c90513059b0ca79757ab9a38cb0c959ff` (branch `codex-hubert/154-contribution-effects`, accepted
  main `3abbd0f` merged). The configured complete command
  `FLUX_TEST_PORT=19541 FLUX_TEST_MAILPIT_PORT=19542 scripts/check_application.sh`
  exited **0**: **435/435** application checks, 3 HTTPS PWA, 1 access-stream, the
  genuine-actor Chromium journey, the new task-effects Chromium journey, the agent-connection
  browser flow, the existing session/material/conversation after an actual API restart, 1
  unavailable-push and 1 unavailable-email check. Build, type check, lint and the architecture
  rules are included in that command (the first run at `1a7ad61` passed 434/435: one migration
  fixture cleanup timed out and was fixed in `1d9abd8`). See the [sanitized stage and test summary](docker-full-summary.txt).
- The Playwright browser suite `FLUX_UI_PORT=19543 FLUX_UI_MAILPIT_PORT=19544 scripts/check_ui.sh`
  at `ed81481fadfe96e86d9ac314002ebb6bfffde5ab` (code identical to the tested source; only Python
  journeys and documentation differ): **133 tests, OK, 4 skipped as before**. Its first run found
  five journeys that assumed the Conversation tab opens the original conversation or that the
  Since-you-left count is unchanged; a linked result now opens a task thread, which is the
  newest conversation and a counted update. They were adapted (explicit conversation URL,
  `+1` update, `.first` quote) and re-run; this is an interim consequence for #136, recorded
  in the task-discussion record. The portable CI command (build, architecture and `*-core`
  checks, `--network none`): 84/84.
- New checks: 26 portable core checks (`contribution-effects-core`), 17 database/HTTP
  checks (`contribution-effects`), 1 historical migration check
  (`contribution-effects-migration`) and 1 Chromium journey
  (`task-contribution-effects.e2e.ts`: the Tasks panel saves a blocker and attaches a
  result; the conversation shows the marked blocker, result link and handoff for a
  reader at 1280 and 390 px). Existing checks changed only where a linked result now
  legitimately opens or extends task threads: native session intents, export
  conversations, the Return summary, and the agent-execution fixture, which now uses the
  production native composition.
- Fresh independent evaluation of this head is still required; this note is the author's
  evidence, not an acceptance.

## What was exercised

- A nonempty saved blocker contributes exactly the saved (trimmed) text as the task's
  first or next canonical message; clearing it, status, owner, title and outcome changes
  contribute nothing; creation with a blocker keeps only its creation notice.
- A result creates one canonical result and one contribution per linked task (sorted),
  each naming that result id, by the actual creating principal (human, genuine tagged
  agent, or the accepting person for a helper proposal). No linked task: no thread.
- An explicit handoff through the task route; `blocker`/`result`/unknown kinds are 400;
  the generic conversation routes reject any `kind`.
- Durable retries: exact `clientCommandId` replay returns the original outcome with no
  second message, event or receipt (also concurrently, 4 at once); changed intent is
  `IDEMPOTENCY_CONFLICT`; changed produced task state is `COMMAND_POSTSTATE_STALE`;
  replay needs current authorization; no key relies on the `If-Match` fence.
- Atomicity: injected failure after every associated write (update, result, links,
  conversation, append, bind, event, receipt) and before/after the final flush, over the
  real unit of work and a caller-owned native transaction, leaves counts, task rows,
  messages, search rows and events unchanged; the recovered command then succeeds once.
- Order: identity locks precede any task lock; a result locks its complete sorted task
  set first (a held later task proves the earlier is locked); opposing, interleaved and
  generic-reply concurrency completes with gapless sequences and one root; a generic reply
  to a bound conversation waits on the task row without having locked the conversation;
  no domain read or write follows the first event insert and the stream lock is taken only
  by the one final flush.
- #152 composition: an agent's `work.update`/`result.record` inside the shared ledger
  transaction debits and receipts once, replays the ledger value, and rolls back with its
  contribution on failure.
- Migration 0040 on a fixture of historical rows: byte-identical, plain `text`, no receipt,
  thread or binding inferred; the guarded pre-use reversal restores the previous shape
  and refuses after a receipt or a non-text contribution.
- Failing-without-the-production-change evidence: [mutation runs](mutation-evidence.txt)
  (unsorted task locks, no task lock for a generic reply, no receipt write: 10 of 43
  checks fail; a hook that appends nothing: 30 of 43 fail). They pass unmutated.

Frames from the Chromium journey: [reader 1280](task-effects-reader-1280.png),
[reader 390](task-effects-reader-390.png),
[result details 1280](task-effects-result-details-1280.png),
[result details 390](task-effects-result-details-390.png). Screenshots do not prove
interaction or accessibility; a separate neutral visual review is still required.

## Not verified here

Real stored bytes, shared drafts, unused-AI undo, #136 integration, the real #152 tools
and #153 handoff authority, supported clients, import, post-use reversal beyond
refusal, both pending migration composition orders (#118) and Android/iPhone/iPad
installation or push.
