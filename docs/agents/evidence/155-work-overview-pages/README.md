# Bounded native Overview — #155

2026-10-01. Tested source and final browser fixture:
`b1f648d7fcc497fa735cc913f9e8bfacb91113b9`. Configured Docker build, typecheck
and lint passed at `76397bf184661277471ebf6700f74df0711f38f2`. Production
and TypeScript test bytes match both pins. The only subsequent source delta
waits for actual native wheel delivery before capturing a browser-test anchor;
the final UI-test image was rebuilt from the tested source.

**25/25 client/architecture checks passed in 281.51325 ms.**
**53/53 browser journeys passed in 93.676 s:** 8 Overview,
17 ProjectSurface, 8 MessageWork, 10 WorkDecisions and 10 PersonalAssistant.
Desktop/phone variants are subtests. Assistant regressions use the configured
mock provider. Setup/local documentation links, 34 foundation Python tests,
wrapper syntax and full-branch whitespace were checked separately.

## Native reads and behavior

Overview reads one ANY association page of at most 50 native work, decision
and result rows for the whole conversation or exactly the selected message.
Conversation scope covers all native messages independently of the bounded
source-count window. A separate global relationship page covers at most 50
edges for the actual current row references. Neither page accumulates DTOs or
becomes a complete ProjectWork. Object and relationship Previous/Next are
independent; refreshing object rows resets their relationship continuation.
A passive row-window change also retires a cursor captured for another ref set.
Each native observation remains separate; no two-GET atomic snapshot is claimed.

The native public-command fixture creates 65 work, 3 decisions and 1 result:
**69 distinct kind/id objects**, including RELATED-only work. Exact API identity
and relationship unions remain reachable through 50/19 object windows and all
native 50-edge continuations. Its 141-message conversation exceeds the source
count window; an older selected message remains exact after genuine reply
pagination, rather than falling back to the whole conversation. The view retains
one scoped already-loaded native message, disclosed only after the current
association read verifies that source. It does not fetch or cache the whole feed.

Pinned material v1 and v2 retain their respective titles and destinations even
when the current route has only the renamed latest version. Native thought
sources land on the exact selected thought in its sketch; source documents remain
reachable through the appropriate relation window. Proposed, current and earlier
decisions and results retain their native kind/status. Global current project
state uses the shared native summary independently; Overview does not acquire a
Task page lease or replace its atomic summary. No false empty document/sketch
claim is made for partial or unavailable reads.

Held genuine responses verify same-scope refresh retains checked rows, native
reading position within 3 px, reply focus and selection. Required 503 reads
clear unavailable rows, show retry rather than an empty collection, remove the
obsolete scroll cue and retain private text. A held older relation page cannot
replace newer object-window content. The passive actual-window mutation case
uses a declared public work-create fixture, then checks current exact references
and retired relation cursors. Read/navigation purity compares target native
work/decision/result DTOs and links; it is not an all-database purity claim.
The declared fixture mutation establishes a fresh baseline immediately after
creation before subsequent read checks.

The bounded object list exposes its scroll continuation explicitly; keyboard
focus makes each tested row visible on desktop and phone. Phone source browsing
retains project, conversation and audience above the scrolling body. The cue
requires a current nonempty overflowing list, so failed reads cannot suggest
scrolling through zero objects. Optional panel context preserves other panel
callers' defaults. Six actual captures include first-page, mixed second-page
and scrolled source states at desktop 1500×900 DPR1 and phone 412×915 DPR3,
zoom 100%. These are emulations, not physical-device evidence.

## Independent reviews and unsuccessful attempts

Independent source review found and helped correct relation cursor reuse after
passive row membership change, latest-version titles on pinned citations, and
missing exact thought destinations. Later review caught a stale overflow cue
when failed reads removed its list. These findings were closed at immutable
source pins. The final fixture-only native-wheel wait was separately reviewed;
it preserves the strict anchor, focus/selection and failure checks. Reviewers
ran no tests and provided no eligible whole-PR approval.

The neutral image-only review found unclear scroll continuation and missing
owning context in the scrolled phone source view. Both were corrected and
reassessed; see review.md for exact supplied images/pins and bounds. Appearance
review does not certify scrolling behavior, accessibility, motion or hardware.

Earlier failures remain saved separately: an incorrect older-reply button name,
response callback append-order mistaken for the current DOM observation, and a
guessed CSS selection class instead of native aria-pressed. A later wider run
failed its anchor assertion because capture preceded asynchronous wheel delivery.
The isolated diagnostic records capture scrollTop=0, held=450 and delivered=450,
confirming a premature test sample. Waiting for native scroll delivery fixes that
fixture; the <3 px preservation assertion is retained. Uncommitted diagnostic
variants have no immutable source pin and are labelled accordingly.

The final wider log reports one pending Playwright routing task destroyed during
MessageWork teardown, outside the named test results. No clean route-handler
teardown claim is made. Fixtures use ignoreErrors only for unfinished routing
handlers during cleanup after native assertions. Browser pageerror assertions
remain and pass; this does not certify every fixture handler completed.
Raw-records.json preserves observed process exits, raw/gzip hashes and any
credential redaction metadata. Readable copies strip only trailing ASCII
whitespace and blank EOF lines. Initial command launch failed because the owner
wrapper was not executable; that empty non-application attempt is excluded.

## Reproduce and continue

Check out the tested source and copy this evidence folder from its later
evidence commit. Run these commands:

```sh
sh docs/agents/evidence/155-work-overview-pages/reproduce.sh prepare
sh docs/agents/evidence/155-work-overview-pages/reproduce.sh overview-all
sh docs/agents/evidence/155-work-overview-pages/reproduce.sh message-client
```
Defaults isolate flux155overviewrepro on 25581/25585. Override
COMPOSE_PROJECT_NAME, FLUX_TEST_PORT and FLUX_TEST_MAILPIT_PORT for concurrent
runs. The owner used flux155browser on 18581/18585. Cleanup only that chosen stack.

Inputs.json hashes immutable git archive bytes and all saved outputs except
itself. Environment.json records current image IDs, build/source distinction,
actual results, callback diagnostics and screenshot hashes/dimensions. Owner and
portable wrappers are saved. Previous Tasks and MessageObjects evidence remains
pinned to its original source; these Overview checks do not rewrite it.

PR170 remains draft. Parent ProjectShell still fetches full collections, and
WorkDetails, assistant work reference/title/owner lookups and document LinkPicker
still require their own complete bounded native projections. Migrate these
before removing that parent fetch. Whole-page initial bounds and the historical
1000-work performance failure remain **unfixed/unverified**. Afterwards rerun
all eight accepted distributions: 30 warm-ups, 200 actions and at least 60 seconds.
Canonical Task composition, real supported agent clients, motion, wide/enlarged
text, physical Android/iPhone/iPad PWA and OS Web Push, integrated release and
foundation acceptance remain required. Whole #155 and the application are
incomplete; no merge readiness, closure, bypass or publication is claimed.
