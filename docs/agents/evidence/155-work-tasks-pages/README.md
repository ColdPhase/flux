# Native Tasks page and shared header — #155

2026-10-01. Owner-run source: `5fd93e17c3e26ce8e3b472c68c04e03d123d0f49`.
Configured Docker build, typecheck and lint passed. Final prepare, client and
browser invocations all exited 0. **23/23 client tests** passed in 364.385875 ms
(15 state/protocol tests plus 8 architecture checks), no failures, cancellations
or skips. **23/23 browser tests** passed in 37.697 s (6 new native pagination
journeys plus 17 existing ProjectSurface journeys), no failures, errors or skips.
Desktop/phone variants are subtests, not additional named tests.

Tasks now renders one bounded native ProjectWorkView and its own summary. The
outer project header consumes that same observation through the shared facet;
it does not race a second standalone summary into an active Tasks page. Exact
all/mine counts, bounded current-owner names and lightweight native rows replace
the Tasks consumer's complete arrays. A same-scope refresh retains the last
checked page and summary atomically; scope changes and required failures mask
them. No page is cast to a complete ProjectWork, concatenated or used as an
implicit source for unshown choices.

The real fixture uses native authentication and public commands: two human
owners with distinct full Ada names, 123 work items (105 open, 12 in progress,
6 blocked), 3 decisions (proposed/current/superseded) and 1 result. Actual browser
navigation reaches 50/50/27 rows, checks the exact union of all 127 created native
kind/id identities, terminal Next and direct Previous, direct cursor URLs and
reload of page 2. Switching Blocked and All restores page 2 and its actual native
reading anchor within 3 CSS px. This is a 127-object functional fixture, not a
replacement for the accepted 1000-work benchmark.

Held reads use actual route.fetch responses from the native API, with explicit
response-assembly synchronization. Tests cover passive refresh retaining row
keyboard focus and private-field selection, a late All response after Blocked,
a synthetic required-read 503 that cannot become empty work or erase the private
draft, retry against the actual native server, and a native cookie account swap
while the earlier account's page is held. Returned mine rows/counts match the new
account's native endpoint. Separate open-only projects show a truthful nonempty
state caption on desktop and phone.

Sticky view/page controls preserve access while reading. The additional browser
journey walks 20 Shift+Tab native rows on desktop and phone and checks each focused
row's actual rectangle below those controls. Source limits focus adjustments to
the current active native row and its own pane; cleanup cancels the pending frame.
The original ProjectSurface suite also passed, including private draft source/
Back, view/resize/reload, failed storage, replay, confirmed clear, ABA edits and
account change. Read journeys compare the target project's native work DTO digest
before/after. This is scoped work-field purity, not a whole-database assertion.

## Review and unsuccessful checks

Independent read-only source review found refresh and empty-caption issues;
they were corrected before the final run. The reviewer also requested final-page
coverage and actual keyboard exposure. An initial browser run failed anchor/
held-response synchronization; a later added keyboard test exposed real sticky
occlusion. A CSS padding attempt corrected that focus case but regressed anchors.
Final source keeps targeted focus exposure without that padding; all final tests
pass together. Those failed intermediate runs remain separate and are never
counted as final passes. Their uncommitted source variants were not pinned, so
the manifest's immutable inputs describe only the final tested source.

A fresh visual reviewer assessed the two actual second-page captures against a
neutral member/job brief and Studio 11.6 references. The visible count-scope
ambiguity was corrected to "127 objects"; final review found no material issue
in those supplied states. See review.md for limits. Screenshot review does not
certify interaction, responsiveness between captures, touch hardware or WCAG.
Reviewers did not run tests, approve the whole task or supply eligible GitHub
approval. Owner checks and independent review are distinct evidence.

## Reproduction and provenance

At the tested source, copy this folder from its later evidence commit. Run
`sh docs/agents/evidence/155-work-tasks-pages/reproduce.sh prepare`, `read-client`,
then `task-pages`. Defaults isolate flux155taskpagesrepro on 23581/23585; override
COMPOSE_PROJECT_NAME, FLUX_TEST_PORT and FLUX_TEST_MAILPIT_PORT for concurrent work.
Cleanup only that chosen stack when no longer needed. Owner used flux155browser
on 18581/18585; all recorded invocations are terminal. Saved environment contains
the current image IDs, resource allocation and actual screenshot viewports/zoom.

inputs.json.gz binds git-show bytes at the immutable source and every saved output
except itself. Seven terminal logs have gzip/raw hashes; readable copies only
trim trailing ASCII whitespace and blank EOF lines. **The initial failed browser
trace printed three actual test Cookie headers: saved raw and gzip redact these
credentials.** raw-records.json records the redaction count, saved raw hash and
private original hash. The unredacted original remains outside the repository;
no extractable fixture authentication cookie is published. Other raw logs are
unchanged. Original wrapper, reproducible commands, failed/pass logs and two
actual PNGs are saved.

## Remaining application work

The parent ProjectShell loader still fetches complete work/decision/result arrays.
MessageObjects, ProjectOverview, WorkDetails and document LinkPicker still consume
legacy complete lists. Therefore initial whole-page fetch limits and the prior
performance gates remain **unfixed/unverified**, despite the bounded Tasks render.
Migrate all of those consumers to their distinct native association/relation/detail/
choice projections before removing the parent complete fetch. Keep every native
source, version, continuation, deep choice and private form usable.

Rerun the original public-command 1000-work fixture and all eight accepted
30-warm-up/200-action/60-second distributions after that integration. Canonical
Task support, real-agent/motion verification, physical Android/iPhone/iPad PWA
installation/Web Push and integrated release acceptance remain open. Separate
backend proof remains pinned at ef15f28 and initial client proof at 5776fc4.
Whole #155 AC1–AC5 and the full product are not complete. PR170 stays draft;
no merge, issue closure, bypass or publication is claimed.
