# Semantic migration footprint gate (#279 / #153)

Accepted bounded contract, 2026-10-08. This implements the mandatory refusal
choice in the [namespace decision](https://github.com/ColdPhase/flux/issues/153#issuecomment-6051196285).
The current #279 image owns `0057_agent_runtime_sign_in.sql` and
`0058_agent_runtime_auth_operations.sql`. Focus is reserved for 59 and the Undo
grant for 60 in future independently reviewed composed images; their original
57 artifacts and databases must remain untouched.

A recorded number, filename or new checksum does not establish the meaning of
an old applied migration. Before the migrator executes any migration SQL or
starts pg-boss, and before API/worker queue startup, read the actual PostgreSQL
catalog and require the footprint declared by this image's exact migration
manifest and applied ledger. The check is read-only: no bootstrap table,
normalization, ledger repair, data rewrite or paired conversion is allowed.

## Required outcomes

- **SEM-1:** distinguish a fresh/known pre-56 database from canonical 56 by
  actual runtime tables, columns, PostgreSQL types, nullability and relevant
  validated checks. Untracked runtime objects on a pre-56/empty ledger refuse
  before migration 0001 can write anything.
- **SEM-2:** canonical 56 may apply 57/58; canonical sign-in 57 may apply 58.
  Complete canonical 58 may restart. The five sign-in columns and their privacy,
  notice and sign-out checks must agree with the ledger. The 58 auth tables,
  checks/keys, release-reason widening and lifecycle fence must agree too.
- **SEM-3:** refuse focus-57, Undo-57 with its facts-48, and every relevant
  partial, mixed, untracked or altered-type/check footprint. A correct maximum
  version or `ADD COLUMN IF NOT EXISTS` is insufficient. Refusal names the
  mismatch and directs the operator to the matching image/database backup;
  never suggest editing the ledger.
- **SEM-4:** negative controls compare the catalog, ledger, seeded native data,
  sequences and queue objects before/after the real migrator, and separately
  require API/worker to refuse a numerically complete but semantically partial
  catalog before pg-boss. No negative may be relabeled a successful upgrade.
- **SEM-5:** isolated PostgreSQL controls retain canonical populated 56,
  canonical 57→58, focus-57, Undo-57 plus facts-48, partial/mixed/untracked states,
  fresh target, and a canonical restart. Backup/restore and integrated operator
  upgrade acceptance remain required at the reviewed composed candidate.

## Scope and future composition

The descriptor registry is the composition point: each supported migration name
declares the catalog objects it owns, expected types/nullability, required
validated constraints and lifecycle fence. A present object whose owner is absent
from this image, or whose applied ledger does not justify it, is refused. For
this 57/58 image, the focus pause and Undo facts/grant are unsupported footprints.
That is not a permanent prohibition: the future 48/59/60 owners must add explicit
reviewed descriptors, preserve the entire feature/migration unit and provide
their corresponding upgrade controls. Merely adding or renumbering SQL files
does not admit an old footprint.

This is a bounded catalog compatibility gate, not validation of every application
table, vendor sign-in behavior, or permission contract. No runtime PASS follows
from source inspection. Application build/type/lint, actual refused no-write
controls, allowed upgrades/restart and backup/restore execute through Docker in
an explicitly assigned verification window.
