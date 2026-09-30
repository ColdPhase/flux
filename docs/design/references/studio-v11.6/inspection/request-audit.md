# Request audit and correction — 2026-09-30

The user requested an **informational repository, issue, PR and milestone update**
for the latest Studio 11.6 design and co-work capability, preserving useful
functionality. They did not request production implementation in this intake.
Their follow-up correctly identified obsolete design material in PR #150.

## Actual mistakes at head 3c358c6

- PR #150 added **17 Studio 11.1 PNGs alongside 27 real Studio 11.6 captures**.
  The 11.6 HTML was correct and matched the supplied hash; the older added
  package unnecessarily left two visual targets in the review.
- New direction notices were prepended without rewriting conflicting current
  prose. `docs/design/direction.md` still said “Current target” was 11.1;
  design/product entry points, milestone briefs and #134/#135/#148/#149/#151
  still led with older primary/latest references. This was an incomplete handoff.
- The 27 original 11.6 captures covered generic tabs, not enough of the new
  delegation, repository, handoff and first-message flows. They were valid
  11.6 images but insufficiently useful as the implementation reference.
- UI116-2/#136 did not explicitly require role swapping and the reachable
  handoff point with original-message navigation and reference download.
- #68 still named an undecided compute source as a blocker, although O-008
  was accepted. The appended co-work note had not reconciled this older text.

## Corrective work

Remove the new 11.1 package and PNGs from this PR's final tree; preserve originals
and previous inspection/review through immutable links in
[reference history](../../../reference-history.md). The user's original files
are unchanged. The already-merged v11 package remains clearly marked historical.
No older image is rebranded as 11.6.

Rewrite current design/product/milestone entry points and affected issue headers
into one coherent direction. Current screenshot additions come only from the
unchanged `flux-studio-v11.6.html`; filenames start `studio-v11.6-` and the
[manifest](report.json) records source hash/runtime/view/scenario/image hash.
The [gallery](../gallery.md) is the current visual entry point. Add focused
source-flow, preference, three-connection and wide-viewport evidence, with
prototype hooks, disposable fixtures and emulation explicitly disclosed.

Make role-swap/handoff actions explicit in UI116-2/#136/#153, preserving grants,
login identity, instruction and historical authorship. Correct #68's dependency
to accepted O-008 while retaining unfinished provider/runtime/UI acceptance.
Amend #147 so historical 11.1 preservation means immutable Git history, not
competing active images. None of this declares the product features implemented.

## User request → implementation handoff

| Requested outcome | Concrete contract / issue | Audit result |
| --- | --- | --- |
| Complete 11.6 UI direction; useful functional behavior preserved | UI116-1–5, #136 | Covered; corrected conflicting current-reference prose and obsolete PNG additions |
| Workspace/project GitHub integration and one Flux backlog | CO-3, #74 | Covered; tenant/project mapping, many repos/PRs, signed event reconciliation, deterministic same-task policy/manual override; no GitHub Issue mirror |
| Flux as local-agent coordination/context tool | CO-1–5, #152/#153 | Covered; shared authorized domain sources, local execution, scoped claims/checkpoints/targeted handoffs and truthful client limits |
| Several agents per person, including Hubert two + Marek one | CO-1, #152/#153/#136 | Covered; stable separate identities/grants/sessions, normal-login consent and exact three-connection acceptance fixture |
| Keep the embedded chat/research/map/wiki helper | CO-1, #57/#68 | Covered; external co-work additive; corrected stale compute-source blocker |
| Autonomous work and mutual review inside granted scope | CO-1/2/4, #153 | Covered; standing authorization, fresh verdict for new SHA/version, non-author same-owner review policy, separate eligible GitHub approvals |
| Creation notice and first actual task conversation message | UI116-3, #154 | Covered; one notice versus root, actual author, one shared thread, attachments/results, atomic retry/concurrency and historical preservation |
| Clear handoff flow and sources | UI116-2, #136/#153 | Clarified missing swap, reachable checkpoint/wait state, original message and scoped reference download |
| Subtle project/tab/message/card animation and typing | UI116-5, #155 | Covered; real scoped ephemeral typing, reduced motion, no draft publication/unread/model effects, no forced scrolling |
| Small Android through 4K/ultrawide; useful additional context, familiar UX | ADAPT-1–5, #151/#136 and #20 | Covered; preserved full viewport/input/zoom/device matrix; tall-screen stream/composer proximity explicitly refined |
| Inform existing agents through repo/issues/PRs/milestones | AGENTS/design/product entry points, #147/PR #150 and both milestone briefs | Corrected current pointers and explicit owner/dependency map; eligible protected PR approval remains separate |

Independent requirement review (`coop_reconciliation`) confirmed the core scope
was covered and identified the handoff-action and #68 corrections above. A fresh
neutral screenshot review is recorded separately in [visual-review.md](visual-review.md).
This audit is planning/content evidence, not eligible GitHub approval.

## What remains implementation work

The new co-work/GitHub capability, production redesign, task-message changes,
real typing and motion, all-client interoperability and full device acceptance
remain in their open issues. Source demos, local domain-hook checks and PNGs do
not establish those outcomes. Active #134/PR #146 and #135/PR #145 remain
foundation slices with their own review scope; #148/#149 and #136 deliver the
current final target. No other worker's production branch is edited by this fix.
