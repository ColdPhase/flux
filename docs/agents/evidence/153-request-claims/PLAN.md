# #153 slice plan: request claim, resolution and supersession

Owner: Zamojski5. Independent evaluator: PelikanFix16. Branch
`claude-maurycy/153-request-claims`, stacked on `claude-maurycy/153-request-admission`
(PR #246, `387d0d06`, not yet merged). This is one partial slice. Original
AC1–AC5 stay open.

## Why this slice

The admission slice left request claim, resolution and supersession as the
next open part of the request lifecycle (CW-2's Queued → Claimed → Resolved /
Declined / Superseded). The storage columns for these states already exist in
`0035` (`claimed_generation`, `response_ref`, `reason`). What is missing is the
authorized, fenced composition that moves a request through them, and the rule
that a newer request replaces an unclaimed older one.

## Contract change (separate commit, flag for peer review)

`docs/development/cowork-coordination.md` → "Request claim and resolution
(2026-10-04, peer review required)". It records:

- two new #152 registry operations, `cowork.request.claim` and
  `cowork.request.respond`, with migration `0049` widening the closed grant
  operation list;
- payloads, lock order, accepted stored states and refusals;
- the supersession key;
- replay and stale post-state rules;
- recovery visibility.

Product contracts CO-1–CO-5 and CW-1–CW-5 are unchanged.

**Needs PelikanFix16 acceptance:** the operation names and classes are #152's
registry surface (the precedent is #167 reserving `cowork.request` for #153).
The `cowork.request_state` post-state is reused unchanged for the recipient's
commands. **Migration number:** `0049` was free on main and on every remote
branch on 2026-10-04 (0045 #154 files, 0046/0047 #228, 0048 #238). The
reservation must be posted on #153 before this branch is pushed; this worker
does not comment on GitHub.

## Acceptance criteria

- **C1 (AC-2):** with a current `cowork.request.claim` grant whose class is the
  recipient unit's actual role, the recipient connection, holding a live claim
  on the addressed unit in this runtime session, moves a queued or deferred
  request to `claimed` with `claimed_generation` equal to the unit's live
  generation. In the same transaction #152 debits one use and writes one
  receipt whose `cowork.request_state` post-state is checked by the canonical
  hook.
- **C2 (AC-1):** request claim is refused, with no request change, grant use or
  receipt, for each of:
  - no unit claim, a wrong lease or generation, another runtime session, an
    expired lease;
  - a request addressed to another connection or another unit;
  - an unknown request, or one in another project;
  - a changed request version;
  - a request already claimed under the live generation;
  - a terminal request (resolved, declined, superseded);
  - an expired request;
  - an unreadable or changed reference;
  - a grant class that differs from the unit role.
- **C3 (AC-2/4):** `cowork.request.respond` resolves a request claimed under
  the live generation with exactly one response reference. The response is
  produced by the injected same-transaction publication step and must be
  readable at its exact version in that transaction. Alternatively it declines
  the request with a bounded reason. Refusals for C2's fence and addressing
  cases, an unclaimed request, a lost claim (stale `claimed_generation`), a
  changed version, an unreadable or GitHub response, an unknown decline reason
  or extra fields leave the request unchanged and debit nothing. A publication
  or later failure rolls back the response as well.
- **C4 (AC-2/5):** a newly created request supersedes earlier `queued` or
  `deferred` requests with the same lineage, sender connection, recipient unit
  and kind, in the same transaction, with reason `newer_request`. A `claimed`
  request is never superseded. Other senders, units or kinds are untouched.
  Re-issuing the same intent (`existing`) supersedes nothing. No budget is
  refunded.
- **C5 (AC-2):** exact replay observes the original effect without a new debit
  and rechecks current readability. A later transition makes the old receipt
  `COMMAND_POSTSTATE_STALE`; a changed payload conflicts.
- **C6 (AC-5):** after a lease loss the recovery page shows the claimed request
  as `queued` with `claim_lost`; re-claiming under the new unit generation
  shows it `claimed` again. Resolved, declined and superseded requests leave the
  pending recovery page.
- **C7 (races, real PostgreSQL):**
  - claim versus supersede in both orders: exactly one outcome, and the loser
    persists nothing;
  - two concurrent claims from one session with different command IDs: one
    effect and one `COWORK_VERSION_CONFLICT`;
  - a second runtime session of the recipient, and another connection, cannot
    claim.
- **C8:** a mutation proof: removing each named guard in a scratch copy makes
  the intended test fail.
- Docker image build, typecheck and lint pass. The affected co-work, agent
  execution, grant and migration tests pass, and the full
  `./scripts/check_application.sh` passes.

## Stays out

- The production response publisher: the #154 actor-aware primitive under the
  caller's own native grant, and the final event flush. It is an injected
  provider here, as `requireEligible` is for claims. Which grant authorizes the
  publication is an open question for peer review.
- Scheduling, the checkpoint producer, and reviewer/checkpoint claim
  eligibility.
- The #238 lifecycle/use fence, the #74 GitHub recipient adapter, and
  authorized unit creation (units are still fixture rows).
- MCP tool exposure, #160 Start/Resume, UI (#136), real
  two-owner/three-connection clients, device and release evidence.
