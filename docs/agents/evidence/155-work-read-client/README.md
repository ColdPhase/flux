# Bounded work read client foundation — #155

2026-10-01. Owner-run evidence at `5776fc48531c2b0b0241a6c5ff51ded26cc6a857`.
Configured Docker build, typecheck and lint passed; final prepare and focused
client test invocations both exited 0. **21/21 tests passed**, with no failures,
cancellations or skips, 377.364709 ms: 13 client state/protocol tests and 8
architecture checks. The first prepare exited 1 on a NodeNext relative-import
extension error; corrected source uses the explicit client.js import. That failed
log remains separate and is not reported as a successful check.

The five client adapters return the accepted distinct summary/view/association/
relation/detail projections through one cookie-bearing GET each. Query builders
preserve all typed choices, literal trimmed search, independent opaque object/
edge/source continuations and normalized bounded reference sets. Raw input count
is checked before deduplication. No page is adapted to complete ProjectWork, no
continuation is concatenated, and required failures do not become empty arrays.

ScopedReadStore keeps one current observation, captures account/project/selector
before awaiting, and checks independent generation ownership even when a
transport ignores abort. Render-time scope masking hides old account data before
React effect cancellation. The React hook delegates to this store; private editor
state remains outside it. ProjectWorkFacetStore gives a page one scope-bound
lease; held/new standalone summaries cannot replace the active combined
page+summary. Replaced and wrong-account/project leases cannot read or release
its successor. Releasing/clearing invalidates held reads and drops retained data.

Independent read-only review found synchronous abort reentrancy: abort listeners
could start a newer read before the older outer call retired its ownership.
The fix captures and installs the replacement controller/generation before
aborting, rechecks ownership before dispatch and retires clear state before
callbacks. Two actual synchronous abort-listener tests cover replacement/clear
callbacks starting a newer read and callbacks clearing an obsolete replacement.
Delayed-promise tests cover account/project/selector changes, same-selector
refresh, late errors, unmount/clear, mutable caller scope and unavailable states.
Subscribers see combined page+summary as one value. These are deterministic
client protocol tests, not native HTTP authority or browser evidence.

Final bounded independent source review found no remaining substantive issue
in these four files. The reviewer did not execute checks, mount React, exercise
a browser, approve the whole task or provide eligible GitHub approval.

## Reproduction and provenance

At the tested source, copy this evidence folder from the later evidence commit.
Run `sh docs/agents/evidence/155-work-read-client/reproduce.sh prepare`, then
`read-client`. Defaults isolate flux155clientrepro on 22581/22585; override
Compose project and FLUX_TEST_PORT/FLUX_TEST_MAILPIT_PORT for concurrent work.
Run `cleanup` only for that chosen project when its stack is no longer needed.
Owner used flux155browser on 18581/18585; only that stack was rebuilt. All build
and test handles are terminal. Original owner wrapper and image IDs are saved.

inputs.json binds immutable source inputs and saved outputs. Three terminal logs
have exact gzip/raw hashes; readable copies only trim trailing ASCII whitespace
and blank EOF lines. Test transport mocks establish request count, selector
encoding and error propagation; they do not establish native server DTOs or
current authority. Render masking is checked through its pure helper, not a
mounted hook. No screenshot or browser pass is claimed.

## Remaining application work

Consumers still use the legacy complete lists. Migrate EVERY consumer to these
explicit bounded reads, connect the shared page facet, and verify actual React/
browser behavior, per-view page/reading continuity, native sources/deep choices,
account changes and private drafts. The new infrastructure alone does not fix
the historical unbounded fetch/render failures. Keep the original public-command
1000-work fixture and all eight 30-warm-up/200-action/60-second distributions.
Backend native proof remains separately pinned at ef15f28 in 155-work-read-api.
Whole #155 AC1–AC5, canonical Task, real-agent/motion, physical phone/tablet
PWA/Web Push and integrated release gates remain open. PR170 remains draft;
no merge, issue closure, bypass or whole-product completion is claimed.
