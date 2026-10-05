# Native bounded work Details — #155

2026-10-01. Final source `7c0fba2f5079619021c8b6dcd3a2f8216993f008`.
**70/70 browser scenarios passed in 117.554 s;25/25 client/architecture tests
passed in 271.024792 ms.** Final configured Docker build/typecheck/lint passed.
Agent setup/local links,34 foundation tests and wrapper syntax and branch whitespace checks passed.

This increment migrates individual work/decision/result Details and decision/result
forms. The complete #155 acceptance and full-product release remain open.

## Native behavior and scope

One own-object read retains its complete native fields and access; it is never
an invented full DTO made from a list row. Project context reads only project,
members and active agents. All relationship roles use separate native pages of
at most 50 edges. Dedicated decision/result choices retain one page of at most
50 rows; selected off-page objects get one explicit own-object read. Native
observations are independent; no combined two-GET snapshot is claimed.

The public-command fixture creates 67 unfinished work objects, an explicitly
selected completed work, 64 accepted rules, pinned material v1/v2, an exact
thought, a message with source and RELATED roles, and 54 source-linked docs.
Tests traverse complete native edge and choice unions, compare exact identities
and full outcome/reason/evidence, and check pinned source URLs. Navigation-only
purity is the target native work/decision/result DTO/link baseline, not all DB
state. Later command scenarios deliberately mutate their native fixture.

A native 503 relationship/choice failure masks unavailable shared content and
retains private text/selection with retry. Cross-page pivot choices retain only
IDs, enforce the native 50-keep/50-park bounds, and allow a user to free a choice
before selecting another page. Actual acceptance submits 50 keep and 1 park.
A real 409 after another command sets selected work aside retains the result
text and finish intent; the author explicitly chooses attachment without finish.
An actual committed result response held across form A → object B → reopened
form A cannot replace the fresh draft or change its text selection. Captured
owner identities retire private-state writes and late shell opens. A docked
object from project A keeps A on all linked-object navigation after the route
moves to project B.

Doc source links prove linkage rather than existence of a current body section.
The tested native update removes a section while its source link remains;
add-or-update appends it, and a subsequent unchanged native upsert keeps the
same version. UI wording promises neither an existing section nor an automatic
version increment. The document list itself still uses its existing collection
loader; this increment does not claim that consumer is migrated.

## Appearance and verification limits

An independent neutral six-image review identified an absent acceptance action,
a clipped single-line Finding, and lost proposal identity while reading choices.
The Finding now wraps and the proposal identity remains visible. A second
review caught work controls peeking beneath a sticky footer. The final variant
uses a separate bounded choice scrollport before the acceptance footer. Native
browser assertions check all element bounds against the actual panel body and
ensure the choice scrollport ends above its footer. The stronger bounds found
a 2px phone inset mismatch; production CSS was corrected without relaxing them.

Desktop is 1500×900 CSS pixels/DPR1, phone 412×915/DPR3, zoom 100%. Captures are
emulation evidence. Hardware installation, OS push, virtual keyboard, enlarged
text, ultrawide behavior, WCAG and full-product motion are not certified here.
Review records and environment.json provide exact result and image pins.
The final browser log contains one cancelled Playwright route callback and no
destroyed pending callbacks; both counts are recorded. Passing named native assertions/pageerror checks do
not certify every unfinished fixture handler completed. Assistant regression
checks use the configured mock provider, not a real provider acceptance pass.

Earlier failed build/browser variants are preserved with raw gzip hashes and
observed exits. Uncommitted variants are labelled without an immutable pin.
Readable logs strip trailing ASCII whitespace and blank EOF lines only; cookie
redactions, if any, are counted in raw-records.json.

## Reproduce and continue

Check out the final source and copy this folder from its later evidence commit:

```sh
sh docs/agents/evidence/155-work-details-pages/reproduce.sh prepare
sh docs/agents/evidence/155-work-details-pages/reproduce.sh details-all
sh docs/agents/evidence/155-work-details-pages/reproduce.sh message-client
```

The reproduction defaults isolate flux155detailsrepro on 25581/25585; set
COMPOSE_PROJECT_NAME, FLUX_TEST_PORT and FLUX_TEST_MAILPIT_PORT for concurrent
runs. The owner used flux155browser on 18581/18585. Cleanup only that chosen stack.
Inputs.json hashes immutable archive inputs and saved outputs except itself.

WorkDetails no longer loads full ProjectWork. Parent collections must remain
until assistant work references/owner/version metadata and document LinkPicker
have complete native readers. Then run the original 1000-object benchmark,
30 warm navigations and 200 actions over at least 60 seconds in each of its eight
distributions. The smaller functional fixture is not that benchmark. Current
canonical Task #154 integration, independent eligible PR approval, physical
Android/iPhone/iPad PWA and Web Push evidence, all foundation 8.1–8.16 outcomes,
integrated release/download/install verification remain required. No main
bypass, task closure or full-product completion is claimed.
