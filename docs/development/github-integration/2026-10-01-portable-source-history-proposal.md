# Portable GitHub source history and dormant import

2026-10-01. **Proposed bounded contract; no corresponding API/import/runtime is
implemented or enabled.** Required continuation of #74 AC-3/AC-5 and the
[CO-3 publication proposal](2026-10-01-private-source-publication-proposal.md).
Ordinary `flux.project-export` v1 remains manual-only with
`reimportSupported: false`; operator DB/files restore remains separate and
revokes GitHub authorization before writers resume. No migration is reserved by
this document. Obtain independent format/authority review and explicit shared
migration allocation before implementation.

## Separate explicit export

A signed-in human with current `project.manage` may explicitly request
`GET /api/v1/projects/:projectId/github-history-export`. The request specifies
the exact nonempty selected binding IDs; omitted IDs never mean all repositories.
The person must prove their own current Flux/App/client/GitHub identity and
repository access for every selected binding before any private fact is returned.
One unavailable/revoked/mismatched source rejects the selected export without
partial names/counts. No owner impersonation or automatic operator account
fallback is added. This first version has no unauthenticated/public download or
agent tool and no long-lived download link. Response is an attachment with
no-store/referrer restrictions.

The operation discovers only the selected binding/link/task IDs, completes
external preflight before held domain locks, then pins current credential and
binding identity/configuration/generation in the same export transaction. Read
all selected records in one consistent database snapshot; recheck pinned scope
before building the response. No separate credential transaction after binding
locks. The operation never changes work, emits project/source events, enqueues
requests or makes a provider write.

JSON format `flux.github-source-history`, `formatVersion: 1`, maximum10MiB and
1000 linked PR snapshots per file. Unknown top-level fields and unsupported
versions are rejected on import. This is a separate source-history format and
does not change the existing ordinary project-export schema or claim full
project reimport.

| Field | Portable meaning |
| --- | --- |
| `format`, `formatVersion`, `exportedAt` | Format identity and export recording time |
| `origin` | Origin instance/project/workspace IDs for explicit mapping; historical identifiers convey no authority on the destination |
| `repositories` | Fixed host `github.com`, lossless stable repository ID, recorded owner/name/privacy/URL; no installation or active binding grant |
| `tasks` | Original native task ID only, for explicit destination mapping; no task creation, owner/status/criteria changes or copied private title |
| `links` | Original link identity, repository/task/PR stable IDs, positive PR number and `required_output`/`related` role |
| `snapshots` | Allowlisted `GithubPullFacts`, recorded source author/IDs/timestamps, exact head/check/review identities and original verification time/state; labelled exporter-recorded observations |
| `excluded` | Credentials, OAuth/client/session/flow state, authorization generations, active bindings/rules/subscriptions/requests, webhooks/raw comment bodies, execution grants, receipt/outbox/lease/provider-write state |
| `provenance` | Exporter account ID for historical attribution, database/format version and `sourceHistoryImportSupported` reflecting actual destination capability; no eligible GitHub approval or authenticity attestation |

Current0036 stores the latest verified link snapshot, not an append-only archive
of every provider change. Export must truthfully identify that scope; do not
manufacture historical observations from delivery timestamps or call a latest
snapshot a complete provider audit log. Separately retained unavailable facts
can be included only when the exporting reader has fresh current repository
proof. Import/export preserves their original recorded state/time and labels;
fresh verification does not rewrite original authorship or time.

URLs are validated against the fixed GitHub origin and exact repository/object
identity; they are never fetched from bundle content. Checks/reviews are bounded
to the same existing provider limits and flagged truncated when appropriate.
Lossless provider IDs remain strings. Filenames, raw objects, arbitrary keys and
unknown nested properties cannot smuggle credentials or executable content.

## Private dormant ingestion and explicit mapping

`POST /api/v1/projects/:projectId/github-history-import` accepts the bounded JSON
and a stable client command UUID under current human `project.manage`. This
initial ingestion performs no provider fetch. It creates only uploader-private
dormant source-history rows, after strict schema/size/identity validation and
explicit task mapping. It creates no native tasks, bindings, ordinary source
links, grants, events, rules, requests, notifications or active processing.
Imported private text is never copied into an ordinary task/comment/result.
The manager's ability to upload supplied bytes is not repository reader authority.

The task map pairs each imported native task ID with one existing destination
task ID in the exact managed project/workspace, verified through the central
policy and supplied current native-version precondition at commit. Every imported
link must have an explicit map; no title, repo number,
existing UUID resemblance or global-current-project heuristic is used. A single
destination task may have several source snapshots, preserving roles. A source
repository is identified by fixed host and stable repo ID; source installation,
binding IDs, accounts and workspaces are never adopted as destination authority.

Durable ingestion identity is `(destinationProject, importingHuman,
clientCommandId)` with a fingerprint over canonical bundle content and complete
mapping. Exact retries return the original dormant batch after current native
authority, exact destination task scope/postcondition and uploader checks.
Changed content/mapping conflicts; a stale mapping returns a conflict without
creating another batch or changing work. A bundle hash
helps integrity and deduplication; it never proves GitHub authorship or permission.
Its raw digest, filenames, imported facts, counts and source IDs stay uploader-
private, including list/history/search/export/cursor paths. Ingestion receipts
do not release source facts to a manager who lacks current repository proof.

## Explicit verification and permitted history reads

The importer explicitly authorizes their own configured GitHub App and selects
fresh destination project bindings through the existing supported flow. A
separate `verify imported history` command maps each imported repository to one
active selected destination binding with the same fixed host/stable repo ID,
proves the importer's current native management and own repository authority,
and fetches each bounded PR by number from the fixed provider path. Stable
repository/PR IDs must match. Unknown/deleted/wrong-host/wrong-repo/object
records remain dormant unavailable; no metadata is published because the bundle
asserted a matching number. Provider transport uncertainty is retriable without
creating another batch or normal source link.

This verifies **current object identity/access**, not old snapshot contents.
Imported snapshots remain labelled `imported recorded snapshot`, with original
export provenance and unverified historical assertions. Separately fetched
current facts retain actual provider original author/source timestamps. Never
mark an imported check/review/body/author/date as provider-attested solely because
its file checksum or current object ID matches. Imported facts cannot drive
automation, completion, assessments, eligible approval or provider writes.

Only after explicit verification may a verified batch participate in separately
gated source-history reads for that project. Every reader needs their own current
Flux and repository proof for every returned snapshot; current importer/binding-
author proof is not the reader's grant. Flux-only readers receive the unchanged
manual task without an imported-history name/count/presence/version/time hint.
Read responses are no-store. Source links/history, search/recaps/helper/153 and
export adapters must either use this gate or deliberately omit imported history;
ordinary consumers remain manual-only. Grant loss/expiry/configuration change/
binding disconnect or restore immediately withholds new reads and stops pending
verification. Reconnect never verifies or resumes the batch automatically.

No active rule, subscription, provider-write intent or #153 request is recovered
from a bundle. To make a new live task/PR link, use the existing explicit link
command after fresh verification; it receives a new local identity and fresh
current provider facts. To create a future rule/subscription, use that separately
accepted explicit command under current authority; imported history supplies no
standing-policy default. The destination's manual task/history/author remains
unchanged.

## Persistence, UI and required proof

Add isolated source-history batch/link/snapshot tables with exact destination
workspace/project/task composite FKs, uploader ownership, source identities,
import provenance and dormant/verified/unavailable states; no credential or
grant FK creates authority. Preserve immutable recorded snapshot values. Reuse
the core source-authority ports and operation capability order; never acquire
credential refresh under import/task/binding locks. Migration number/manifest
and both peer composition orders must be reserved and verified before writing.

Provide a reachable manager settings action to export an exact selection,
choose/validate a source-history JSON file, explicitly map existing tasks and
show private dormant state plus the fresh-authentication/verification action.
Authorized reader history discloses imported-recording provenance separately
from fresh provider facts. Failed parsing/mapping/provider access keeps native
work available and preserves valid private dormant rows for correction/retry.
No invented general project import UI or active restore state is shown.

Acceptance requires actual Docker/API/SQL/browser evidence for strict schema and
limit errors; exact byte/identity/author/time/role round-trip; altered/fake snapshot
labels; no credential/raw webhook/active grant fields; export by a current repo
reader vs a Flux-only manager; two projects sharing a repository; wrong task/
repo/PR mapping and foreign uploader denial; exact/changed retry and rollback;
access loss during export/verification/read; restore/disconnect with dormant
history and zero active grants/autoruns/requests; source-history consumers and
ordinary export/search/events/notifications negative leak checks; phone/tablet/
desktop interaction and neutral visual review. Real App evidence remains its
separate acceptance requirement. A metadata-only file or fixture-only import is
not completion.
