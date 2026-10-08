# #356 visible author capture delta — independent review

2026-10-08. Read-only independent peer_reviews review of clean HEAD **3e2bb854d8d787356501260b7c51cc29edb8a8a1**, delta from **0c195c973c03c7ab1ad305da7d369984d48a4eb6** in `/home/hubert/.codex/worktrees/339-kreska-fixes/flux`. Only `app/tests/app/e2e/task-discussion-actors.e2e.ts` changes, SHA256 **f2c07fadce7e0a956f371c5379deaf68deb12571b43d663610ed3c1ab8e939e2**. Production app/apps+packages/docker/scripts/flux matchD85 exactly.

## Findings

1. Actual current maintained2-case run `/tmp/flux356-visible-authors.log` **fails** case1 at captureVisibleAuthor: `locator.evaluate: ReferenceError: __name is not defined` (helper line154). Nested assigned named function `bounds` is transformed by the TS runner with a helper outside the serialized browser function. The visibility inspection never completes; no fresh phone captures are accepted. Case2 passes; whole result1pass/1fail,0cancel/skip. Fix browser-safe inlined element bounding expressions or equivalent anonymous serialization without external helper dependency, retaining all assertions.
2. The helper verifies positive hit/visible non-inert ancestor state only for the selected label. Face is a sibling, so opacity0 or a covering element over face can coexist with an uncovered visible label; prior assertAuthorColumn checks32px/display but not face opacity/hit visibility. The stated actualface/meta/label protection requires visibility/hit checks for each element (and positive bounds), not just label. This is a source coverage gap, not a reproduced product defect.
3. Three samples are collected, but only sample2==sample0 is asserted. A different middle rendered frame can pass. Compare1==0 and2==1 to substantiate identical3-frame geometry. All current samples must retain actual positive fully-in-viewport/visible/uncovered checks.

Closing Replies by the real named button and awaiting #thread detached is correct. Existing authentic core writes, stored receipt equality/idempotent replay, human DM link, real DELETE/revoke/read-only denies, account/guest/privacy assertions and bounded route/cleanup safeguards remain unchanged. No criteria/source change or application fix is recommended from these fixture findings alone.

**Current verdict: changes required in test helper, current phone visual evidence unverified.** Earlier0c2/2 runtime proof remains valid for its own exact file; it cannot certify this new capture helper. No GitHub mutation or application test started by reviewer. Re-review exact corrected test head and successful actual2-case capture run before accepting the new screenshot set.


Guard clarification: both `ui/Avatar.tsx` and unlabeled `ui/Kreska.tsx` deliberately put aria-hidden=true on the decorative face, while its adjacent name remains readable. Do not reject the face solely for that valid attribute. Face still needs real visual display/visibility/opacity, nonhidden/noninert ancestors, positive bounds and covering-element check; label/meta protection against aria-hidden ancestor remains. This review adds no new accessibility contract to decorative faces. Full delta whitespace check passes.


b63c5d1a128ba3f12dcd8ecb364a5460719c4ee6 source re-review: browser-side named helper removed, actual positive face/meta/label guards and both adjacent frame equalities now present; decorative face-own ariaHidden exception is narrow. These three helper findings are source-resolved; fresh exact-current runtime remains pending. See `/tmp/flux356-public-callback-drain-review.md` for the independent accepted public callback-drain plan and primary-source limitations.


## Final exact-head re-review and actual evidence

**87204070bc431cee5302a6bc4ec37b8604c12cdd**, clean, actor-test-only sinceD85. Test file SHA256 **b742b5f11f18e9c6e6bee215453f3ad65ac6194206a3c2d67445d420cebdd1c6**. Production app/apps+packages/docker/scripts/flux remain byte-identical toD85; full delta whitespace passes. Reviewer did not edit author files.

The previous three helper findings are resolved: no serialized named bounds helper, real positive fully-in-viewport/uncovered display/visibility/opacity/nonhidden/noninert guards for eachface/meta/label, narrow decorative-face-own ariaHidden exception, frame1==0 and2==1, identical afterPNG sample. The real Close replies action and detached#thread are required before named phone/event captures. Existing source/privacy writes, persisted receipt equality/idempotent replay, actual revoke/deny, read-only/guest boundaries and same-document account transition assertions remain. No product behavior/contract was weakened.

The callback-drain implementation follows independently accepted public-only plan. Every callback Promise is registered synchronously before awaiting; every unexpected settled failure remains in handlerFailures. Current read must be actualHTTP200, agent-absent and successfully fulfilled before currentRead acknowledgment. Real held authorized response is released and handler finishes before only the namedpeopleHandler is removed with bounded publicpage.unroute(endpoint,handler). Pending callbacks drain via boundedallSettled; unexpected failures AggregateError, including failures settled before snapshot. No ignoreErrors/private patch/removal-before-release/synthetic acknowledgment. Finally still releases hold; context cleanup attempts all contexts, retries failures and aggregate-fails. This proves actual fixture callbacks, not all framework-private latches. Prior98c named-drainFAIL and instrumented diagnostic success remain distinct.

Actual `/tmp/flux356-callbacks-final.log`: **2/2PASS,0fail/0cancel/0skip**, cases4368.467ms and5409.598ms, total10652.604ms. Author reports complete commandEXIT0; independent log read confirms both actual cases and complete cleanup. Independent project inventory `flux356-d85-current-barriers-1791423260-4030274` shows no remaining container/network/volume. Log SHA256 **b2ca8e285cd700c17bfba0f810913274ccfa8fb73f3da75e041596540ed28946**.

Independent mechanical inspection of all four fresh visibilityJSON under `/tmp/flux356-callbacks-final-e2e`: positive threepart bounds, viewport/hit/ancestor guards and before==after allPASS. Relevant rawPNG hashes:

- agent-owner-reader-390-text200.png andtask-event-reader-390-text200.png: **e99e1dc765a21be0e69400f5a49165ad9c9bf89e7c0f4f660176bcd9923941b9**. These are intentionally identical captured pixels because both measured states share that viewport; two names do not count as two visual contexts.
- workspace-agent-event-390-dark-text200.png: **17285a9955ffd5e371e91a5e508de247cbe07b3c61d79af80da81b1d956b37e3**.
- workspace-agent-author-390-dark-text200.png: **a4bf8c0e402406cace3199ef9c07d9aceaf9e9d5b2a071c2ef4da83a69cf59c9**.

**Bounded current source/runtime/capture-integrity verdict: PASS.** No remaining actionable finding in this exact test delta. Neutral visual assessment of raw selected images still belongs to the fresh independent visual evaluator; mechanical geometry does not certify visual quality. No whole#339/fullcurrentapplication/externalMCP/eligibleapproval claim. The report preserves priorfailed3e2/98c and exactolder0c successes rather than treating them as current proof. Next action: root obtain fresh neutral visual result, assemble exact-head source/evidence mapping and retain protected approval/check gates.
