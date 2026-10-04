# Guarded migration0048 reversal

This is the accepted lossless pre-feature reversal under AC-U5, not a way to discard task creation history. The schema-only down SQL remains separate; its caller owns the migration ledger. Root authorized this necessary runner follow-up, and the independent review required exact sparse manifests, migration serialization, writer exclusion and one atomic transaction. No runtime reversal is claimed yet.

The checked-in `packages/db/migrations/reverse/0048_manifest.json` pins every current migration filename/version/SQL hash and the exact prior manifest formed by removing only0048. The coherent composition includes0046 and0047; it does not infer missing reserved0042 or guess a prior version from arithmetic. The runner verifies all current files and the down SQL hash before connecting, then asserts the current database ledger matches that exact manifest.

Operators stop API/worker feature writers and pass the explicit quiesced acknowledgement. The runner takes the standard `flux-migrate` advisory serialization lock, begins one transaction, then takes `ACCESS EXCLUSIVE NOWAIT` relation locks on proposal/grant/task/notice/receipt storage before any feature-history guard. Any active relation holder refuses and rolls back. These locks prevent fresh feature writes until settlement; the quiesced acknowledgement is an operational prerequisite, not runtime proof by itself.

Inside that transaction it repeats the exact current ledger assertion, executes all schema-only guards and down DDL, verifies the DDL did not alter the ledger, deletes exactly version48 with a one-row result assertion, verifies the exact prior sparse ledger, and commits. Any unknown/later/missing version, changed file, feature provenance/use/reversion/receipt/notice or Undo operation grant refuses. Failure rolls back schema and ledger together; no foreign ledger row or task/tombstone data is deleted. The runner releases migration serialization and the SQL client in every outcome.

The prior image must be separately pinned to the identical prior manifest and successfully started after reversal. The current image intentionally refuses the reversed ledger. Post-feature recovery uses paired database/files backup and its matching image. Required evidence remains: original old-data preservation, forward/restart, guarded pre-feature reversal and matching prior-image startup, used/grant refusal with untouched schema/ledger, and actual paired restore. Source review and a down SQL file do not satisfy those runtime checks.

Run the built runner only in the owned Compose migration service after a paired backup and verified service shutdown:

```
FLUX_REVERSE_0048_QUIESCED=true node tooling/dist/reverse-task-creation-undo.js --execute
```

The default without `--execute` only prints the checked exact current/prior manifests and hash. It performs no database operation.
