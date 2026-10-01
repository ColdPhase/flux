# Bounded authenticated bootstrap and orientation — #152 proposed wire

This is a concrete delivery interface for the accepted bounded bootstrap/read
direction. #160 owns the canonical instruction bundle and real Start/Resume
activation; #153 owns active claim/checkpoint/inbox; #74 owns verified repository
references. Missing providers must remain visible required gaps, not substituted
with message/wiki content or client assertions. Peer acceptance precedes these
new wire/runtime writes. This document is not implemented capability evidence.

## Bootstrap

`flux_bootstrap({ clientSessionId, projectId, grantLimit?, grantOffset? })` uses a
client UUID only to recover/create the original server-issued runtime under its
live actual OAuth binding. It checks the exact selected project inside the same
outer transaction before reading names. Later browser selection has no input to
this context. The envelope has `contractVersion: 1`, fresh DB `observedAt`, the
authenticated runtime/owner/agent/workspace/connection/actual OAuth client/reference
and captured scope set; current selected project ID/name; a bounded current grant
manifest; actual registered tool capabilities; trusted versioned playbook/policy
references; coordination continuation; coverage/gaps and setup readiness.

Grant pages are at most 50 (default 20), with explicit total/offset/next offset.
They belong to this exact owner/connection/project and contain operation, class,
optional exact object ID, generation, maximum/used/remaining uses and expiry.
Exclude revoked/expired grants. An exhausted live grant remains visible with
zero remaining uses because an unchanged original receipt can still be observed;
this metadata never authorizes a new action. The manifest is an observation,
not an authority token. Execution rechecks canonical rows independently.

The capability catalog comes from the same server-owned registration descriptors
as actual MCP tools, including required coarse scope and exact operation/classes
where applicable. A selected action scope or existing grant does not make a
pending domain adapter available. Decision acceptance is human-reserved. Review
independence is separately validated against actual artifact authors/current
versions, never certified by a connection label or capability entry.

Trusted providers supplied by server composition return:

- playbook `{ bundleId, version, digest, toolContractVersion, retrievalReference }`;
- approved project policy `{ policyId, revision, digest, retrievalReference }`;
- coordination `{ activeClaimReference, checkpointReference, inboxContinuation }`;
- verified repository context references through the orientation provider.

Provider values derive from server-owned versioned artifacts/canonical rows under
current authorization. No MCP parameter, ACK, clientInfo, owner designation,
ordinary source text or raw URL fills these fields. The initial missing provider
returns null plus a specific required gap. `readiness.state` is `pending` while a
required provider or compatible installed adapter is unavailable. It never reports
loaded instructions/model obedience/account billing. #160's later ACK records
compatibility only and cannot grant authority or manufacture claim readiness.

## Versioned project index

`flux_project_orientation({ projectId, kind, limit?, offset? })` returns at most
50 canonical metadata references of one explicit kind: doc/material, work,
decision, result, conversation or project map. Each reference includes exact
workspace/project/kind/ID, bounded title/label, version or canonical checkpoint,
and publication/status distinction where present. No full body, private draft
provenance, DM/private map, model transcript or unverified repository URL appears.
Goals/plans remain ordinary wiki sources until their canonical classification
exists: declare the classification gap, never guess from a title. Dependency
coverage and repository verification are likewise explicit until their providers
ship. Authorized follow-up tools read full relevant sources in bounded pages.

Use a core-owned metadata/index port with DB queries constrained by exact
workspace/project and kind before selecting titles, limits or totals. Conversation
checkpoint is its canonical latest sequence, map checkpoint includes `updatedAt`
as well as row version, wiki/material checkpoint is current immutable version,
task/decision checkpoint is native version, result identity is immutable. Current
ACL/binding checks surround every projection, including continuations.

## Relevant changes since recorded versions

`flux_changes_since({ projectId, known: SourceCheckpoint[] })` accepts at most
50 distinct exact kind/ID/checkpoint references. It returns current authorized
metadata references only for changed inputs, explicit unchanged IDs and one
content-free unavailable outcome for missing/foreign/unreadable references. A
checkpoint is evidence of prior coverage, not permission to fetch its object.
The same selected-project ceiling applies before any metadata lookup.

Coverage states that this compares the supplied known references; it does not
claim discovery of every new object or deleted historical source. New-object
discovery continues through the bounded orientation index, and #153's later
authorized durable change cursor can extend this catalog. No whole-project reread,
silent body truncation, private source expansion or guessed resync is used.

## Required evidence before enabling

Test real provider-issued bearers for exact authenticated identities/scope ceilings,
idempotent original runtime recovery, current grant expiry/revoke/role/substitution,
selected-project/foreign-object/privacy ceilings, bounded manifests/index/changes,
canonical wiki/task/decision/conversation/map checkpoints and changed sources.
Unavailable providers must produce visible setup gaps, and spoofed ACK/clientInfo/
source content cannot alter trusted references or readiness. Test source rows,
actual tool discovery and transport, not only core DTO construction. Supported
Codex/Claude instruction loading and model-driven activation remain separate
mandatory acceptance evidence; missing providers are unfinished work.
