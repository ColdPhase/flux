# Concurrent OAuth resource initialization

The actual #228 two-API run at `17c0ac162ae99ec914ebfa5b48c4d1fb37f26ac9`
started both API processes simultaneously against one fresh PostgreSQL database.
One exited before the functional tests: PostgreSQL rejected the second resource
insert with `23505` / `oauth_resource_identifier_unique`. This is a reproduced
startup failure, not a latency or cross-process editing PASS.

The pinned [OAuth provider1.7.6 seed implementation](https://github.com/better-auth/better-auth/blob/v1.7.6/packages/oauth-provider/src/resources.ts#L837)
(read2026-10-04) first reads, then inserts a missing resource. Its default
`insertOnly` policy preserves existing administrative edits. It intends to treat
a competing insert as a no-op, but recognizes only the top-level error message.
The pinned [Drizzle adapter](https://github.com/better-auth/better-auth/blob/v1.7.6/packages/drizzle-adapter/src/drizzle-adapter.ts)
uses Drizzle queries; the actual error is a `DrizzleQueryError` whose public
`cause` contains the PostgreSQL code and constraint. The top-level message
describes the failed query and does not satisfy the provider's duplicate pattern.
That diagnosis follows the actual preserved error and the pinned primary source.

The bounded correction extends the existing reproducible provider patch only at
this seed catch. It traverses at most four public error/cause objects and accepts
only PostgreSQL `23505` with the exact resource-identifier constraint. It preserves
the upstream handling of direct duplicate messages, missing-table deferral,
resource seed modes, and unrelated failures. It does not change authentication,
resource scopes, current grants, refresh families, database uniqueness or startup
ordering. It requires the root's controlled Docker lock regeneration for the new
patch hash before frozen-lock execution.

`tests/app/oauth-initialization.test.ts` is a deterministic real-PostgreSQL
regression. Two independent public database pools and production identity
instances initialize together. A labelled public query-boundary barrier holds
only each completed empty resource lookup until both lookups have happened; real
inserts then race. Both initializations must succeed, a real loser must encounter
the exact identifier uniqueness constraint, and one resource row must remain.
An existing resource's explicit disabled/scopes/TTL/metadata remain unchanged on
another initialization. An unrelated actual PostgreSQL primary-key conflict must
still fail. The query interposition is restored and all contexts settle before
their pools close. This fixture does not claim two independent API processes.

Acceptance also reruns the unchanged two-process simultaneous API startup and
public cross-process editing/browser tests at the corrected candidate. Staggering
startup, generic error swallowing, retries that conceal the failure, or an
authentication bypass would not establish that outcome. Source checks and prepared
tests alone remain unverified; the four live-editing gates are unchanged.
