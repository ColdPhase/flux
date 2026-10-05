# Supplemental source review — native reference fixture corrections

Reviewed head: `e4a79932ec61120a80ab175d24c33a4cc9234772`.
Previously reviewed backend: `a4bc9d2508c48788a41014ee440d540e0045a0ce`.
Reviewer: independent subagent `/root/bounded_state_contract_review`, source only. Date: 2026-10-03.

No material source finding in this test-only delta. Production implementation and accepted reference-row contract are unchanged; the prior backend source report remains separate.

- Found-to-absent drift still deletes an isolated zero-link native task and requires 409 before refresh produces its opaque marker. Native task-notice scope FKs cascade on deletion and remain intact.
- Cross-project found/marker drift now moves unaccepted, unreferenced decisions between two projects in the same workspace. These fixtures have no dependent task notice, park, supersession or source records requiring an illegal scoped task move. Both directions still require 409, then assert the fresh found/marker partition. The selected-identity fence applies generically to the same native kind/ID set; using decisions for permissible relocation retains the meaningful drift coverage.
- Native `createLink` always admits a `related` edge, independently of the client's supplied role. The corrected fresh observation asserts one edge and zero source-message edges, while retaining the required 409 on aggregate/source-fingerprint change. It neither grants source authority to arbitrary link input nor weakens the production predicate. This scenario proves a related-edge aggregate change; it is not newly claimed as a native source-role creation test.

Independently inspected the exact one-file delta, native link admission, task-notice/dependency constraints and relevant migrations; delta whitespace check passed. No Docker/API/test execution was performed by this reviewer. The owner reported the preceding run passed 53/55 with two fixture failures and the corrected run is pending; neither is treated here as independent current-head PASS.

Client migration, full RR1–RR4, all original #155 and eligible final evaluation remain open. This report does not overwrite the a4 source assessment or grant task/PR/runtime approval.
