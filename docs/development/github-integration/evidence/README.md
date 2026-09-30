# Independent first-slice reviews

The original [functional report](2026-10-01-independent-functional-review.md)
and [SHA manifest](2026-10-01-independent-functional-manifest.json) are preserved
byte-for-byte from the independent evaluator. The reviewed production pin is
`93d3ecbd89050e96dd2681b07b54c3e4465bc719`; observations at `da3da03` used identical
production code. Verdict: changes required, with a credential/binding lock cycle,
missing current-client envelope binding and an authorized-reader UI omission.

The manifest preserves original local artifact hashes/paths. Private raw logs,
environment files and test credentials are not copied into the repository.
The fresh [fix report](2026-10-01-independent-fixed-functional-review.md) and
[35-artifact manifest](2026-10-01-independent-fixed-functional-manifest.json) are
also preserved byte-for-byte. The independent evaluator passed all three fixes
at `b30da68816b15b0c2f1a9ff99993d34e6eca4b05`: revocation lock/rollback drainage,
configured-client envelope binding and the authorized-reader UI. It includes
actual HTTP and signed-HMAC revocation races, successful refresh/generation
replacement, and different manager/reader GitHub identities. The production
source at `db156227655fd4d33af9feb92a88b299dfd2e26a` is identical; its changed
installation-callback browser-fixture line was author-tested separately.

This is bounded acceptance of the corrected first slice, not whole-issue or
merge approval. The [publication design assessment](2026-10-01-private-source-publication-independent-design.md)
conditionally accepts the same-task provenance model and requires concrete
rule/version, lock/event-order and consumer-inventory clarifications before
affected runtime. Native private effects and the undelivered #153 bridge remain
disabled. Real provider/client/device acceptance, native automation, recipient
delivery and portable dormant source export/import remain open.
