# Private source effects on native work — CO-3 proposal

2026-10-01. **Proposed for independent review; no corresponding runtime is enabled.**
The independent [design assessment](evidence/2026-10-01-private-source-publication-independent-design.md)
accepts the same-task model conditionally. Its three required clarifications are
specified in the [rule, transaction and consumer amendment](2026-10-01-private-source-effects-amendment.md),
which takes precedence over any underspecified wording below and requires fresh
independent agreement before implementation of these effects.
This extends the unchanged #74 AC-3/AC-4/CW-4 contract. The accepted first slice
continues to keep private facts and its undelivered bridge separately gated.
An ordinary standing-rule click is not an organization sharing policy.

## Problem and decision proposed

Checking today's project members before copying a private GitHub fact into an
ordinary task field is insufficient. A future Flux-only member, a former GitHub
reader or an ordinary export/search/history/notification consumer could later
read that stored field without current repository authority. Even a derived
stage or an opaque refresh event can disclose private source activity.

Proposed default: preserve the native task's manual record and store each
automatic source effect with explicit provenance. A single canonical work-view
resolver combines that same task ID with effects the current reader may see.
There is no second task, backlog or provider board. No automatic effect is
copied into the broadly readable manual fields or ordinary manual history.
Broader organization-approved publication is a separate future policy; this
proposal does not introduce one or make public repositories an implicit bypass.

This deliberately means that a verified source reader can see the task's
authorized derived stage while a Flux-only member continues to see its manual
native state. The independent reviewer must explicitly assess whether this
canonical provenance projection meets AC-4's same-task movement contract. If it
does not, keep automation disabled and resolve that contract before runtime;
do not silently reinterpret AC-4 as a separate execution hint.

## Data and deterministic authority

Keep the ordinary task ID/title/owner/manual status/blocker, existing criteria,
results and native optimistic version. Add a source-effect relation to that
task, not another task row. Its immutable provenance contains workspace/project,
binding IDs, stable repository/PR IDs, all required-output link IDs, exact heads,
source observation IDs/times, rule ID/author, authorized generation, native
version checked and an effect revision. Private stage/blocker/history values
live only in that relation. An unknown or incomplete provenance record cannot
be disclosed or affect a view.

An explicit rule author needs current native task write and their own verified
App/client/GitHub identity/repository authority for every required source. The
rule snapshots the required links and selected required checks (including
producer App IDs), preserves roles and does not reassign or expand audience.
Every effect uses native-version and effect-revision compare-and-swap; changing
required links, authorization generation or any manual task edit suspends it.
Related-only links do not drive stages. New SHA invalidates old review facts.
Closed-unmerged/failed checks cannot become completion. Merge/green can only
produce a completion candidate; ordinary current task/result/device criteria
and real eligible GitHub gates still govern completion.

The public native version advances for native commands. A private effect has
its own revision; it must not leak through version increments, updated timestamps
or ETags to readers who cannot see it. Authorized command/reference packets can
carry both versions. A manual command checks its native version, suspends the
rule under the same work lock and wins over subsequent automatic effects.
Automatic effects compare the same native version before committing. A stale
provider event never blindly rewrites either manual work or a newer effect.

## One current reader gate for every consumer

Introduce a domain port that resolves current source authority for the actual
human, or a connection's owning human after its current connection grants have
passed. The binding author is never a substitute for the reader. Verify current
Flux audience, fixed host/App/client/user/generation, active selected binding
and that reader's current repository permission for **all** provenance sources.
Do not reuse a permission proof beyond its operation or treat signed events,
cached facts, reconnect or a prior subscription as a grant. An outage or unknown
proof withholds the effect and leaves manual work available.

Provider capability/credential pin precedes native work, binding and effect
locks. Recheck the selected provenance after pinning; do not fetch another
credential transaction while those locks are held. Manual native commands do
not acquire provider/binding locks: work then rule/effect suspension is enough.
Revocation changes credential/binding/effect authority without rewriting the
manual task. Server-side cancellation must drain rollback before driver timeout.

| Surface | Required behavior |
| --- | --- |
| Canonical task/project/board/detail API and MCP read | Resolve the same authorized view before returning status, blocker, timestamps, versions, source links or counts; otherwise return the manual task without a source-presence hint. |
| Lists, filters, ordering, pagination, recaps and aggregates | Use that resolver's effective fields before filtering/counting/paging. SQL adapters may receive the operation's verified binding set; never filter raw private effect fields and redact afterward. Cursors/cache keys are reader-bound and expose no hidden revisions. |
| History, result/assessment references and cached artifacts | Store private effects separately, apply current source proof to every history/reference fetch and suppress withheld rows/counts/identifiers. Preserve manual history and original provider authorship. No cached private field is returned because it was once allowed. |
| Search and snippets | Keep source indexes separate from ordinary native indexes. Join only currently permitted provenance before matching, ranking, snippets/facets/counts. The returned task uses the same canonical view. |
| Streams and replay | Source-effect events carry internal provenance and use current recipient authority before admission and each delivery/replay. Do not broadcast a generic work-refresh/version tick to Flux-only members; that would disclose activity. Manual task events remain ordinary native events. |
| Notifications, push and email | Explicit source subscription plus current recipient connection/Flux/repository gate at creation, send and later inbox/detail reads. No private fact in ordinary notification rows or unrestricted email/push payload. Withheld items leave no counts or timing hints for an ineligible recipient. |
| #153 local requests, resume packets and bridge consumption | Recheck current owner/grants/subscription and recipient source authority before every delivery/effect. Preserve causal source/request IDs and current SHA; an internal bridge row is not delivery, reviewer authority or a provider write grant. |
| Browser projections | No-store responses; clear source projections before access recheck and on known authorization loss. Inactive tabs revalidate before new source operations. Do not retain hidden source values in shared shell state or a service-worker cache. |

Native commands can still edit the manual task under ordinary authority without
GitHub access. The system never manufactures a human-authored native message
from external text or quietly copies a derived private blocker into manual work.

## Withdrawal and recovery

Project/GitHub revocation, disconnect, expiry, changed generation or unknown
provider state withdraws the corresponding effects from current views. Stop
processing/delivery and suspend its rule; preserve the manual task, manual
edits, decisions/results and history. Keep private source observations as
unavailable history, accessible only after a new current proof. Reconnection
does not resume a rule or replay old outbound writes automatically. Explicit
resume pins current native/effect versions and all required links again.

Already permitted context received by a person or their local client cannot be
unlearned. This design governs new server reads, controlled caches and effects;
it does not claim to erase downloaded files or interrupt independent local Git.

## Export and dormant import

Ordinary project export uses the manual native record and excludes private
source effects/history, credentials, active rules/grants and delivery state.
A separately requested source-history bundle requires the exporter's current
native management and repository proofs. It labels provenance/recorded versions,
never contains credentials, and does not grant its eventual importer access.
This export option itself requires independent acceptance before implementation.

Imported source records remain dormant/unverified and invisible to Flux-only
readers. Re-map existing native task IDs explicitly, retain the native manual
baseline, and verify current provider host/repository/PR identity through fresh
authorization before showing permitted source history. File checksums prove
file integrity, not GitHub authorship; imported snapshots are labeled as such.
No imported rule, credential, subscription, queued request or authority runs.
Current provider truth is fetched independently. The existing unsupported-import
product state remains truthful until this whole path is implemented and tested.

## Acceptance before enabling effects

The independent review must settle the same-task projection/version semantics,
global lock order and complete consumer inventory. Implementation must prove a
single canonical resolver is used by API/MCP/board/history/search/export/streams/
notifications/153; an unconverted consumer keeps native effects disabled.

Required regressions: two projects sharing a repo without Flux-context sharing;
all required vs related links; current head/check/review correlation; a current
reader losing repo access; a newly added Flux-only member; cached/history/search/
pagination/export/replay/inbox denials without names/counts/revision leakage;
source outage and recovery; concurrent manual override and effect CAS; withdrawal
that preserves later manual work; disconnect/restore/import without active grants
or autorun; explicit recipient subscription and causal echo suppression. Exercise
the actual reader/writer browser and local-client paths. Fixture success does not
replace real GitHub/client/device and integrated task acceptance.
