# #153 slice plan: live request admission and recipient ordering

Owner: Zamojski5. Independent evaluator: PelikanFix16. Branch
`claude-maurycy/153-request-admission`, from protected main `d94f70e4`.
This is one partial slice. Original AC1–AC5 stay open.

## Why this slice

PR #166's open list included two peer findings from the
[parent participation evidence](../153-parent-participation/README.md):

- **F3:** live sender-unit request admission, exact sender grants and the
  request post-state hook.
- **F2:** holding the recipient's slot from request timestamp through commit,
  so recovery cannot skip a request that commits late.

Both depend only on code already on main: #152's `cowork.request` operation
(0038), the `cowork.request_state` post-state and its unused hook, #166's
request storage, and #171's graph lock primitives. No migration or peer branch
is needed. Checkpoint production, resolution and supersession depend on
design work that has not been accepted yet: a checkpoint producer and schema,
and #154's final-flush consumer.

## Contract change (separate commit, flag for peer review)

`docs/development/cowork-coordination.md` → "Live request admission". It
records payload identity, lock order, admission rules, refusals that debit
nothing, replay, and recipient-slot ordering. The product contracts CO-1–CO-5
and CW-1–CW-5 are unchanged.

## Acceptance criteria

- **A1 (AC-2, AC-1):** with a current `cowork.request` grant whose class is the
  sender unit's role, a sender holding a live claim creates one request and one
  delivery intent. In the same transaction, #152 debits one use and writes one
  receipt. The receipt's `cowork.request_state` post-state is checked by the
  canonical hook.
- **A2 (AC-1):** the admission is refused, with no request, delivery,
  lineage count, grant use or receipt, when the sender has:
  - no claim, or a paused claim;
  - an expired lease;
  - the wrong generation or lease ID;
  - another runtime session;
  - a grant class that differs from the role.
- **A3 (AC-2/3/4):** the admission is refused, with no effects, for:
  - self-addressing;
  - a recipient unit in another lineage;
  - a revoked or unknown recipient;
  - a parent request whose sender is not a party to it;
  - an unreadable or changed source;
  - a GitHub reference;
  - an exhausted budget;
  - a `distinct_owner` review sent to the same owner.

  A foreign recipient gets queued intent only, never a claim or grant.
- **A4 (AC-2):** replaying the exact command returns the original effect without
  a new debit. A changed payload conflicts. A recipient deferral makes the old
  receipt stale. Re-issuing the intent under a new command ID returns the
  existing request and adds no delivery. An outer failure rolls back everything.
- **A5 (AC-2/5, F2):** consider two admissions in distinct lineages for one
  recipient. The second blocks on the recipient slot until the first commits.
  A recovery continuation taken meanwhile still reaches both requests.

  Negative control: the same interleaving through raw storage without the
  slot reproduces the gap.
- **A6:** the shared graph lock provider takes the project graph advisory locks
  and adds direct prerequisites to the task lock set. Admission uses it, and so
  does the claim path when it uses this provider.
- Docker image build, typecheck and lint pass. The affected co-work, agent
  execution and grant tests pass, and the full `./scripts/check_application.sh`
  passes.

## Stays out

- Request claim, resolution and supersession; scheduling.
- Checkpoint producer and schema; reviewer and checkpoint claim eligibility.
- Native publication and the final event flush.
- The #238 lifecycle/use fence (PelikanFix16 provides the port).
- MCP tool exposure and #160 client wiring.
- The #74 GitHub recipient adapter.
- UI (#136), real two-owner/three-connection clients, device and release
  evidence.
