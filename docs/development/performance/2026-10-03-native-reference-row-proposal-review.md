# Independent contract review — selected native reference rows

Reviewed proposed contract pin: `56ddf989ef1240aa4ce47dfd6800ff32694d5a0a`.
Document: `docs/development/performance/2026-10-03-native-reference-row-extension.md`.
Reviewer: independent subagent `/root/bounded_state_contract_review`; technical source/contract assessment only, no implementation edits. Date: 2026-10-03.

## Decision

**Necessary correction before acceptance:** the proposed atomic missing/foreign-object failure at lines 14–26 conflicts with preservation of legitimate historical citations and proposal controls. The bounded API shape, native projection reuse and read ownership direction are otherwise suitable. This report does not admit the unchanged proposal as accepted, execute runtime tests, or approve all #155/GitHub/release gates.

## [P2] Isolate unavailable historical references without suppressing unrelated native metadata

The existing assistant `SourceLink` in `ConversationParts.tsx` handles an absent work citation individually with a generic current-project label and preserves its destination. `ProjectConversation.tsx` can still resolve other native task owners from the same collection. Under the proposed request, one missing or foreign historical citation makes the entire visible-reference batch unavailable. Otherwise valid proposal titles/owners disappear and their controls can remain unavailable indefinitely; retrying the identical batch cannot repair the absent citation. RR2's preservation promise does not specify a bounded recovery policy for this valid mixed set.

The existing native proposal use case (`personal-runs/proposals.ts`) also distinguishes target absence from command authority: acceptance rejects a missing target with `PROPOSAL_TARGET_GONE`, while dismissal can remain valid for a writer, including a manager, with final central authorization. An undifferentiated unknown-owner guard must not turn such existing proposals into permanently undecidable UI. A known unowned row is also different from failed/missing metadata; genuine agent ownership must retain its native kind/ID semantics.

The suggested opaque per-reference unavailable outcome is a sound correction to this *new proposed* endpoint, provided the contract states all of the following:

- Each normalized requested identity has exactly one outcome: its existing same-project `NativeWorkRow`, or a content-free unavailable marker containing only the submitted native kind/ID. Nonexistent and foreign identities produce the identical marker; no reason, owner, title, body, actual project or foreign-existence fact is returned. Canonical ordering/partition accounting is explicit; total rows plus markers is at most 100 and equals the normalized input size.
- Raw 1..100 bounds, closed query validation, malformed UUID/kind rejection and unsupported/duplicate query-key rejection remain whole-request failures before normalization. A marker is not a substitute for malformed input handling.
- Missing/foreign selected objects alone may yield markers. Session/project denial, DB/hydration/name/aggregate failure and policy-check failure still fail the complete request; none becomes a fabricated marker or partial successful read. The same project audience and exact-session final policy remain authoritative.
- Found/unavailable membership is observed within one repeatable-read transaction and fenced against current selected-scope drift before serialization. Specify a non-disclosing changed-observation response and refresh rather than releasing metadata for a selected identity that has since moved/disappeared or ignoring a changed marker set. The existing `required.objects` check cannot simply be applied to every marker: it currently rejects absent references. The extension needs an explicit bounded selected-availability requirement/fence, with the existing relation/source-visibility fence retained for row aggregates.
- Client rendering isolates each unavailable reference, retains all citation text/links and permits valid rows to label/check their own proposals. Distinguish transport/loading unknown ownership from an opaque unavailable target and from a successfully observed `owner:null`. Preserve safe accept guards and existing native dismissal behavior separately; never infer missing means unowned, grant extra authority to an assistant owner, or bypass final command authorization.
- API/browser criteria include a mixed batch with valid work plus nonexistent and foreign historic citations, identical opaque outcomes, valid-row labels/owner guards still usable, current-policy drift, and an old legitimate proposal with a missing target: accept remains rejected and authorized dismissal remains reachable. Include human owner/manager/viewer and genuine-agent ownership fixtures.

A documented bounded client isolation/recovery design could alternatively satisfy preservation while retaining an atomic endpoint, but the current proposal has no such design. The marker correction avoids serial per-reference detail requests and preserves one bounded observation.

## Other assessed aspects

The raw bound before deduplication, selected native kind/ID syntax, no arbitrary search/private-source input, and one global <=100 outcome window are coherent with the accepted work-read contract. Reusing native row hydration preserves task prerequisite scalars, owner identity, work/decision versions and existing native predicates without rationale/outcome/evidence or implicit links. Fixed-scalar DB aggregates do not constitute an object collection returned to the client. Core-owned ports, DB adapters, contracts wire types and server composition fit the recorded architecture; no second authorization path is needed.

RR1's owner/generation/render fences, revalidation pause and preservation of private composer, command UUID and reading position are appropriate. RR2 explicitly retains all citations and native destinations beyond the metadata window; focused/interacted references must displace lower-priority metadata within that same bound. RR4's >100 distinct-source browser scenario should demonstrate reaching early/middle/late references and their actual native destinations, not merely existence of all text or a total count.

Keep cited `AssistantSourceRef.revision` distinct from the current native row version; current title/owner metadata must not rewrite committed citation provenance or invent an immutable historical work reader. Add explicit version-change/provenance assertions alongside the already requested title/owner change evidence. `ResultRowProjection` has no mutable version field, so reuse its actual existing contract rather than inventing one.

RR3 correctly conditions removal of `ProjectShell.work` on migration of every former consumer and separately requires network evidence. Original assistant/native state/task-plan/typing/scale/device/provider/MCP/release gates remain required. Generic placeholders outside the current metadata window are only a loading/fallback state, not evidence that original native title/owner/version requirements have passed.

## Evidence scope

Read the proposed extension, accepted native work-read and task-plan contracts, architecture guidance, native row/visibility hydration, core service/ports, final server fence, assistant source/proposal presenters, and native proposal authority implementation. Prior foundation context is retained. Delta whitespace checks passed. No endpoint implementation exists for this proposal and no runtime test was executed by this reviewer. Final task/PR/release evaluation remains separate and eligible independent review is still required.
