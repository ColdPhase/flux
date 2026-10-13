# MCP provider sign-in: populated main90 upgrade

Date: 2026-10-11. Owner: PelikanFix16. PR #384, parent #310; remaining original
S1 AC-9/AC-10 are preserved in #483.

The [functional report](report.md) and [pinned proof](verification-proof.json)
record an actual ordinary CLI installation at protected main
`c866c0db3fd3d7d91279d1bbfdcd14bbd2fd0fb2`, followed by an ordinary upgrade
to `f7327db3de6d05be3a30ae2396ff6690fd0d2c4a` using the same checkout,
environment, Compose project and volumes. Exactly0066/0083/0086 arrive after
the retained schema90: ledger56 becomes59. All30 phase exit assertions pass;
the maintained API cohort passes22/22 and1129 application inputs match its
actual test image. The evidence covers17 identified native/auth/ledger/file
groups for the seeded owner/project, rather than every application table.

Original ledger timestamps, saved native rows and physical/API file bytes survive.
Older families keep explicit unknown provenance; later and abandoned grants do
not replace their facts. Real refresh, selected-project MCP reads, deleted-session
refresh, process/migrator restart and ordinary `restore --migrate` pass.
The guarded pre86 controls use a separately labelled stopped SQL clone, not a
real provider login or a forged original baseline.

Plain ordinary restore stops at the real source-commit mismatch before replacing
data; the complete scoped checkpoint remains unchanged. The [separate image
migration-gate](direct-ledger-gate.json) uses the56 actual rows from the original
unmodified archive and refuses the three missing files. These are different
checks; neither is represented as the other.

The original driver exited2 because its cleanup omitted the test profile after
all functional phases passed. [Exact cleanup recovery](cleanup-recovery.json)
exited0 and removed only confirmed owned resources. The root independently
rechecked zero owned containers, networks, volumes, marker and run tags, and all27
public evidence hashes. The original driver is not relabelled as exit0. Four
earlier scratch failures retain their original records and zero cleanup results.

Current code checkpoint `161ce469a38c03bb816c52b8b13028204469701b` normally
composes the later protected main `bb63d0f87a75e38e333e21b8aa1972b1334324b1`.
Its [source compatibility audit](bb63-source-compatibility.json) establishes that
the35 changed paths are exactly accepted #482 and that identity, migration,
selected-test, dependency and runner inputs are unchanged. The actual audit
and Docker observations above keep the f732 pin; this is not a new image audit
of161ce469. Current-head lightweight checks pass at161ce469; any later
documentation-only commit requires its own current-head checks and independent
review while retaining these original behavior pins.

Bulk evidence and immutable phase logs remain in
`/tmp/flux384-main90-verification/run-1791731770-1006716/evidence/`.
Raw rows, cookies, tokens and backups remain private; the whole run directory
must not be published. Harness reproduction uses
`/tmp/flux384-main90-verification/run.py --baseline <pin> --candidate <pin>
--execute --lease-granted`, only after an explicit shared-host heavy-test lease
and fresh resource/source preflight. Its future cleanup correction is a later
scratch revision, distinct from the executed frozen script.

These checks support this partial S1 composition. They do not establish the
remaining real Keycloak boot-outage/CIMD/custody cases, real Claude Code/Codex
versioned integration, complete #310, PWA/visual/native or final release
acceptance. The parent and #483 remain open; an eligible independent current-head
review and protected merge are still required.
