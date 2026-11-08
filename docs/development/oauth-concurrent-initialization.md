# Concurrent OAuth resource initialization

Two API processes start together against one database and both need the MCP resource row
(`<origin>/mcp`, table `oauth_resource`). This page records what makes that safe today, what
Flux's own part is, and which test pins each piece. It replaces the #228 and #316 write-up,
which described a Better Auth 1.7.6 failure and a patch that no longer exist.

## History

The #228 two-API run at `17c0ac162ae99ec914ebfa5b48c4d1fb37f26ac9` started both processes
simultaneously on a fresh PostgreSQL database. One exited before the functional tests:
PostgreSQL rejected the second resource insert with `23505` /
`oauth_resource_identifier_unique`. Better Auth 1.7.6 meant to treat a competing insert as a
no-op but recognised only the top-level error message, while the Drizzle adapter wraps the
PostgreSQL error in a `DrizzleQueryError` whose `cause` holds the code. A patch of the seed
catch fixed it (#228), and `ensureOauthResource` inserted the row first (#316).

## Today (Better Auth 1.7.18)

Read from the installed `@better-auth/oauth-provider@1.7.18` package on 2026-11-08
(`seedResources` and `seedResourcesOnce` in `dist/authorize-*.mjs`); this is an observation of
the pinned version, not a documented guarantee, so a Better Auth upgrade re-runs the tests below.

- **The race is handled upstream.** After a failed insert the seed re-reads the row and, if it
  is there, treats the insert as lost to a competitor and carries on. Flux no longer patches
  the seed; the patches in `app/patches/` are about refresh families (#152, #310) and the
  Drizzle pool, not resources. The default `insertOnly` mode never overwrites an existing
  resource, so an administrator's edits (disabled, scopes, TTL, metadata) survive a restart.
- **A failed seed does not stop Better Auth.** If the re-read finds nothing (the insert failed
  for another reason), the startup seed logs `could not seed resources at startup; retrying on
  first resource access` and initialization succeeds. The retry happens on the first resource
  lookup, so a server whose database cannot take the row would start and fail later.
- **Flux makes startup fail fast.** `startIdentity` calls `ensureOauthResource` before it
  registers anything: `INSERT ... ON CONFLICT DO NOTHING` of the one row. A database that cannot
  take the row stops the server at startup with the PostgreSQL error. A second start, or a
  second process, leaves the one row. This call is kept for fail-fast, not for the race; do not
  remove it.

## Tests

`tests/app/oauth-initialization.test.ts`, real PostgreSQL, no Better Auth internals mocked:

1. Two independent database pools and production identity instances initialise together. A
   labelled query-boundary barrier holds each completed empty resource lookup until both have
   happened, so the real inserts race. Both initialisations succeed, one insert really loses on
   the identifier constraint, one row remains and the discovery document is served by both. An
   existing resource's explicit policy is unchanged by another initialisation.
2. An unrelated primary-key conflict in the insert seeds nothing and does not stop Better Auth
   (the 1.7.18 behaviour above), which is why test 3 is needed.
3. `startIdentity` stops with the PostgreSQL `23505` when the same unrelated conflict is forced,
   where `createAuth` alone carries on without a resource. With the database able to take the
   row, `startIdentity` seeds it once, serves the discovery document, and a second start leaves
   one row. Removing `ensureOauthResource` fails this test.

This fixture does not claim two independent API processes: the two-process simultaneous startup
is the `api` and `api2` pair of `check_application.sh`, and the live editing and cross-process
browser tests run on it.

Refresh-token rotation, the other place two requests meet in Better Auth's tables, is pinned by
`tests/app/oauth-refresh-rotation.test.ts` (#916). Better Auth rotates with a guarded update
(`revoked IS NULL`) and creates the successor only after the guard passes. Eight concurrent refreshes with
one token make one successor: a request that read the token after its rotation gets that pair again (the
30-second retry window of `docs/product/mcp-identity.md`), one that lost the guard gets `invalid_grant`,
and the rows are the original and one successor. A reuse after the window ends the whole connection
family.
