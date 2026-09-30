# Independent contract review — F-016 / F-017

2026-09-30. Read-only reviewer `coop_reconciliation`, under `flux-plan-task`.
Compared all three supplied co-work documents with repository base
`3cd91d798a8767ba8a87ceecde98b49f76aed15a`, current issues/PRs and primary
MCP/GitHub/client documentation. Reviewed the reconciled `mcp-cowork.md`,
`studio-v11.6.md`, #74 amendment, four new bounded task drafts, and #136/#147
amendments. Symbolic task names were resolved to published issue links afterward.
No application code or GitHub records were changed by the reviewer.

**Result: accepted as independent planning/content review** after one material
correction. The first draft conflated execution authorization with review and
could revoke standing review consent whenever a new SHA appeared. Corrected
CO-4 and the runtime task: execution-only grants cannot claim review; new SHA or
result version stales the verdict, not an applicable standing review grant;
a replacement reviewer validates its own grant. Regression: new commit → stale
verdict → authorized fresh review without another owner prompt. Reviewer verified
this delta and found no further material contract/dependency gaps.

Reviewer also corrected the handoff wording: #133/PR #140 is merged;
#134/PR #146 and #135/PR #145 remain active/open at this intake. Their foundations
and existing reviews remain; #148/#149 are successors, not evidence of completion.

Accepted boundaries include three connections/two owners in one normal account
session; same-owner non-author review under policy versus separate GitHub approval
eligibility; existing tenant/project and helper boundaries; one Flux task/thread;
standing autonomy with existing human-only decision acceptance; unchanged task
statuses and manual automation override; first-message concurrency and private
prompt/history protection; completed #52 reuse and coordinated shell ownership.

This is not implementation verification or eligible GitHub PR approval. Final
protected merge still requires an eligible independent review of PR #150's
pushed head and its required checks. No claims of working Codex co-work, live
GitHub binding, typing, redesigned production UI or device acceptance are made.
