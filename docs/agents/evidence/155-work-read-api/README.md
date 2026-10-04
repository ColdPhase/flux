# Native bounded work read API — #155

2026-10-01. Owner-run evidence at `ef15f280343683d8d848cf0d5c4e14464381d7d4`.
Configured Docker build, typecheck and lint passed. Final prepare/test invocations
both exited0. All **45 tests passed**, with no failures, cancellations or skips,
5.842035836 seconds: 8 architecture, 9 query/cursor, 10 core protocol,
5 PostgreSQL key-selection and 13 native HTTP/session/policy/projection tests.

All five accepted bounded GET routes are registered. Closed raw URL selectors
retain duplicate-key rejection. Central native project.read precedes data;
counts, key windows, bounded rows/names/context and full own detail fields share
one native read-only REPEATABLE READ transaction. Thin rows do not contain links,
outcome/rationale/evidence or persistence columns; results have no invented
version. Summary has exact all/mine counts and at most three native kind/ID
owners with their exact total, preserving identical human/agent names.

Native relations filter both endpoints before counts/labels. Material versions
remain distinct. Association objects span work/decision/result in one requested
window; source counts independently page100 messages including zero-link ones;
matching edges share one requested bound. Ascending message/edge keys preserve
raw microseconds and direct previous pages. Continuations bind account/project/
selector/limit and actual object windows. No legacy whole-list presenter is used.

Outside the snapshot, the actual Better Auth resolver requires the same exact
native SID, central current project.read and all required native selectors.
Missing/foreign/deleted detail, relation, selected work, parked decision and
source selectors return404 before source drift comparison. SQL aggregate source
fingerprints cover all linked endpoints and the complete selected conversation,
including a counted zero-link101st message outside the returned100-message
window. Drift suppresses the observation with409 work_read_changed. The last
native policy query is followed by another exact SID check; both real deleted
and expired SID transitions during that policy query return401. This is a final
session observation, not an atomic lock through serialization. A different live
SID never substitutes. Contributor→viewer downgrade returns final viewer access.

Fixtures use actual native public registration/commands/grants/cookies; held
source privacy/deletion/session expiry transitions explicitly use PostgreSQL,
not an invented public delete operation. Actual held SQL verifies caller
mutation cannot change relation batch cardinality or message count selection.
Native transaction settings confirm read-only REPEATABLE READ; the five reads
leave the project work/decision/result/link/message rows and project-scoped
events unchanged. This digest does not certify every database table.

## Review and earlier results

Independent read-only source agreement at ef15f280343683d8d848cf0d5c4e14464381d7d4
found no material issue or weakened criteria after selector/SID corrections.
The reviewer did not run the build/tests or grant eligible whole-task approval.
The previous655d350 source passed42 tests; added final-policy SID/downgrade/
read-purity checks yield45 at the final source. Source review found and corrected
an unqualified outer SQL id, missing current required selectors, mutable count
selection and the session interval after the last policy read.

The first c12b380 prepare failed on two TypeScript errors. A later ceca8d6
prepare completed configured build/type/lint and readiness but exited127 because
the owner edited a running wrapper; it is explicitly a failed invocation.
The wrapper was stabilized before the successful0a6825f prepare. Its first test
run had38 passes and4 failures: a viewer cursor was wrongly used as owner, and
raw native edge timestamps were treated as Dates. Current tests keep the native
account binding; production edge SQL now emits explicit UTC text. Material
version assertions compare version/title pairs independently of random tied
edge IDs; ascending key/previous-page ordering remains checked. No DB constraint,
acceptance criterion or production cursor authority was weakened.

## Reproduction and provenance

Use the tested source and saved reproduce.sh (copy from this evidence head when
checking out the prior tested commit). Run prepare, bounded and cleanup. Defaults
are an isolated flux155apirepro project on21581/21585; override project/ports for
concurrent work. The owner used flux155browser on18581/18585 and retains only
that stack for client integration. All owner build/test handles are terminal.
The original final owner wrapper is also saved, separately from portable repro.

inputs.json.gz binds immutable tracked build/config/contract files at the tested
source and saved outputs. Eight original logs have exact gzip/raw hashes;
readable copies only trim trailing ASCII whitespace and blank EOF lines.
Environment/image IDs and intermediate failed/successful pins are recorded.

## Remaining required work

Migrate EVERY complete-list consumer to explicit summary/page/association/detail/
choice reads with account/project/selector/generation fencing and atomic active
page+summary adoption. Then rerun the original public-command1000-work fixture
with all eight30-warm-up/200-action/60-second distributions. The historicald536
baseline remains failed for unbounded fetching/rendering. This evidence covers
backend behavior only; no client, performance, canonical Task, real-agent/motion,
physical Android/iPhone/iPad PWA/WebPush or integrated release acceptance pass.
Whole#155 AC1–AC5 remains open. PR170 stays draft; no merge/closure/bypass.
