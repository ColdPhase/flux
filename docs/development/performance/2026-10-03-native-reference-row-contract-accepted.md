# Independent acceptance — selected native reference-row contract

Accepted contract pin: `ffd11b619d18734773e076eab48989a98ec0ed3f`.
Reviewed document: `docs/development/performance/2026-10-03-native-reference-row-extension.md`.
Previous reviewed proposal: `56ddf989ef1240aa4ce47dfd6800ff32694d5a0a`.
Reviewer: independent subagent `/root/bounded_state_contract_review`. Date: 2026-10-03.

## Decision

**Accepted for implementation within the existing #155 scope.** No remaining material contract gap was found in this bounded technical review. This accepts the revised read/client/evidence contract only; no endpoint implementation exists yet, no runtime was executed, and no whole-#155, eligible GitHub, device/provider or release approval is granted.

## Resolved correction

The revised contract gives each normalized selected native identity exactly one outcome: its same-project row or an opaque submitted-kind/ID marker. Rows plus markers exactly cover the normalized input and remain globally <=100. Nonexistent and foreign references have identical markers with no foreign metadata or existence reason. Raw bounds and malformed/closed-query failures remain enforced before normalization; project/session denial and required DB/name/hydration/aggregate/policy failures still reject the whole request.

Selected found/marker membership is observed within the repeatable-read transaction and checked again by a bounded final membership fence, alongside exact current session/project policy and the existing source-visibility digest. Drift causes a non-disclosing changed observation and refresh. This expressly requires an extension of the current strict required-object fence rather than treating missing records as successful native rows.

Client behavior now isolates unavailable historical citations from valid metadata. It distinguishes transport unknown ownership, an observed unavailable target, and an actual `owner:null`; accepts remain guarded, while native authorized dismissal of a missing-target proposal stays separately reachable under final command authority. Human owner/manager/viewer and genuine agent semantics remain intact. Current row versions cannot rewrite committed citation revisions.

RR4 now explicitly requires mixed valid/missing/foreign sets, found-marker drift, rejected accept plus legitimate dismissal, cited/current version distinction, and early/middle/late native destination reachability beyond 100 sources. These address the prior preservation finding without weakening boundedness or exposing foreign content.

## Remaining scope and evidence

The closed native selector API, reuse of exact existing row projection/hydration, global bound, current visible/focused metadata window, scoped read ownership, private composer/UUID/reader preservation, and conditional removal of every former full-collection consumer remain coherent with the accepted work-read/task-plan contracts and recorded architecture. All actual source/citation destinations remain reachable outside the metadata window; fallback labels are not a substitute for proving required native title/owner/version behavior.

Independently reread the full revised document and its delta against the previous proposal, retaining the prior source review of service/ports, row hydration/visibility, final fence, assistant presenters and proposal authorization. Exact HEAD and clean worktree were checked; delta whitespace check passed. No application/API/UI tests were run by this reviewer.

Implementation must still satisfy RR1–RR4 with pinned Docker/browser and affected rendered evidence. Original #155 criteria, full parent/assistant migration, native state/task-plan/typing/scale matrix, superseded-only fixture and applicable real device/provider/MCP/install/release gates remain unchanged and open. Final eligible independent evaluation remains separate.
