feat(cowork): fenced request claim, response and supersession (#153)

Refs #153. This is one partial slice. Original AC-1 to AC-5 stay open.

The slice continues the request lifecycle after #246's live admission
(CW-2: Queued → Claimed → Resolved / Declined / Superseded). The recipient
connection can now claim a delivered request under its own live unit claim and
resolve or decline it. A newer request replaces an older unclaimed one.
Everything runs inside the caller's transaction through #152's
`prepare`/`complete`, which handles the grant debit and the durable receipt.
It is internal composition only. No MCP tool, client scheduling or UI is
enabled.

## Contract

`docs/development/cowork-coordination.md` → "Request claim and resolution
(2026-10-04, peer review required)". This was a separate commit before the
code (`edf5230f`). It records:

- the two operations and their payloads;
- the lock order, the accepted stored states and the refusal codes;
- the respond, supersession and replay rules;
- recovery visibility.

Product contracts CO-1–CO-5 and CW-1–CW-5 are unchanged.

## Implementation

- **New #152 registry operations.** `cowork.request.claim` and
  `cowork.request.respond`. `objectId` is the recipient's own unit, and the
  class is that unit's actual role. The post-state is the existing
  `cowork.request_state`, now for the acting connection. Migration
  `0049_cowork_request_responses.sql` widens only the closed grant operation
  CHECK; `FLUX_SCHEMA_VERSION` is 49. Exact grant targets must name a unit
  assigned to the grantee with that role (`co-work/grants.ts`).
- **Server composition** (`apps/server/src/co-work/responses.ts`):
  1. #152 `prepare`;
  2. the recipient slot, the #171 graph locks, the complete task set and the
     unit rows;
  3. the request row (`FOR UPDATE`);
  4. the pure rules;
  5. reference readability;
  6. for a resolve, the injected same-transaction `publishResponse` and an
     in-transaction readability check of its reference;
  7. the conditional SQL update, which repeats the unit fence and the
     request version and state;
  8. the canonical post-state hook;
  9. `complete`.
- **Core rules** (`packages/core/src/co-work/responses.ts`): strict payloads.
  The rules cover the live unit fence, addressing, closed and expired
  requests, an already-claimed or lost request claim, and the response
  reference shape (never GitHub).
- **Supersession** (`apps/server/src/co-work/requests.ts`): a *created*
  admission supersedes earlier `queued`/`deferred` requests that share its
  lineage, sender, recipient unit and kind. A claimed request is never
  superseded, a re-issued intent supersedes nothing, and no budget is
  refunded.
- **Agents view label** (`apps/web/src/agents/ProjectAgents.tsx`): main's #183
  maps every operation to an activity line. The two new operations read
  "picked up a request" and "answered a request".

## Bringing the branch onto main

The branch was stacked on the earlier #246 head `387d0d06`. It merges #246's
final head `5a931440` (`c047e629`, no conflicts), then `origin/main`
`6f742eba` with `-s ours` (`a1071eab`). That is lossless because
`git diff 5a931440 6f742eba` is empty. `1e7383ab` adds the two Agents labels
for a semantic conflict with #183 that the merge did not show. The diff
against main is the slice's 19 files plus that one line.

## Negative controls (real PostgreSQL)

Each refusal is checked against a snapshot taken before the attempt: the
request row, the connection's grant uses and receipts, and the project's
result rows. Covered refusals:

- **Claim:**
  - no unit claim, a wrong lease or generation, another runtime session or an
    expired lease → `COWORK_CLAIM_LOST`;
  - an unknown request, another unit or connection, or another project →
    `COWORK_REQUEST_UNAVAILABLE`;
  - a stale version → `COWORK_VERSION_CONFLICT`;
  - a changed source → `COWORK_SOURCE_UNAVAILABLE`;
  - expired → `COWORK_REQUEST_EXPIRED`;
  - already claimed → `COWORK_REQUEST_CLAIMED`;
  - resolved, declined or superseded → `COWORK_REQUEST_CLOSED`;
  - a wrong-operation grant → `AGENT_EXECUTION_UNAVAILABLE`;
  - a wrong-role exact grant is refused at grant creation.
- **Respond:**
  - unclaimed → `COWORK_REQUEST_NOT_CLAIMED`;
  - a lost request claim → `COWORK_CLAIM_LOST`;
  - a missing, GitHub or stale response → `COWORK_RESPONSE_UNAVAILABLE`, and
    the published row rolls back too;
  - a publisher that throws, or a failure after the transition: everything
    rolls back;
  - a decline with `source_changed` succeeds when the source changed.
- **Races:**
  - claim versus supersession in both orders, where the waiter blocks on the
    recipient slot row;
  - two claims from one session: one effect and one
    `COWORK_VERSION_CONFLICT`.

## Mutation proof

Eleven guards were removed in seven scratch-copy groups at `0dd0d5cb`. Each
mutation made a specific test fail with the intended reason. The guards were:

- the core unit fence;
- addressing;
- "already claimed";
- respond-under-live-generation;
- in-transaction response readability;
- claimed exclusion from supersession;
- the supersession `kind` key;
- the post-state `claimed_generation` check;
- claim reference readability;
- the slot row lock;
- both fence layers together.

The co-work sources at the tested head are byte-identical to `725ee900`; see
the README.

## Checks at `1e7383ab` (Docker, isolated Compose projects, ports 19100–19105)

- Image build, typecheck and lint pass. The only lint warning is the
  pre-existing `exhaustive-deps` warning.
- Affected set, 20 files: **126/126**.
- Full `./scripts/check_application.sh`: **EXIT 0**, API **738/738**, plus
  17/17 browser and service tests.
- Foundation: `check_agent_setup.py` passed, the host suite ran 67/67 OK, and
  `git diff --check` is clean.

Evidence: `docs/agents/evidence/153-request-claims/` ([README](README.md),
[plan](PLAN.md), [source hashes](source-sha256.json)).

## Open peer questions (PelikanFix16)

1. **#152 registry acceptance.** Do you accept the new operations
   `cowork.request.claim` and `cowork.request.respond`, their class (the
   recipient unit's actual role) and the reuse of `cowork.request_state`?
2. **Which grant authorizes response publication?** One option is a second
   native operation scope in the same command. The other is a respond grant
   that covers publication. `cowork.request.respond` alone must not become a
   general publication right. The production `publishResponse` is #154's
   actor-aware primitive and is not implemented here. Public composition stays
   disabled until it is wired and independently verified.

## Needs action before push

- Post the `0049` reservation on #153. It was free on main and on every
  branch on 2026-10-04 (0045 #154 files, 0046/0047 #228, 0048 #238). Any of
  0045–0048 that lands later must keep `FLUX_SCHEMA_VERSION` at 49, or higher
  if newer migrations exist. Any later rewrite of
  `agent_standing_grants_operation_check` must keep both operations. The
  stacked unit-creation slice (`claude-maurycy/153-unit-creation`) proposes
  `0050` and raises the version to 50 on its own branch.

## Not in this PR

- the production response publisher and its grant;
- the final event flush;
- scheduling and the checkpoint producer;
- reviewer and checkpoint claim eligibility;
- the #238 fence and the #74 GitHub recipient adapter;
- authorized unit creation, which is the next slice;
- MCP exposure and #160 Start/Resume;
- real two-owner/three-connection clients, UI, device and release evidence.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
