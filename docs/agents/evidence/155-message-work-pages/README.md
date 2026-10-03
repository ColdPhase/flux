# Bounded native message work — #155

2026-10-01. Final source and UI fixtures:
`2a848c4bc19aa27ceb8d094b1da3703d481c9be7`. Production web code and TypeScript
client tests are byte-identical to independently reviewed
`8e9ae10ec9c644c095e284d6287291bec64b350a`, where the configured Docker build,
typecheck and lint passed. Only two Python browser fixtures changed afterwards;
the UI-test image was rebuilt from their final bytes. Final build, client and
wider browser invocations exited 0.

**25/25 client/architecture tests passed in 471.539458 ms** (17 client/helper and
8 architecture checks). **45/45 browser journeys passed in 77.335 s**: 8 new
MessageWork, 17 ProjectSurface, 10 WorkDecisions and 10 PersonalAssistant.
Desktop/phone variants are subtests, not additional named journeys. Existing
assistant tests use the configured mock provider, not real agent clients.

MessageObjects now reads one global native SOURCE association window for up to
100 loaded message IDs in a batch covering the actual viewport. It renders at most 50 matched edges/chips and
uses independent bounded object and edge continuations. Exact per-message native
kind counts are retained even when a preview is incomplete. Typed native work,
decision and result rows retain their identities and native status/owner text.
No page becomes a complete ProjectWork or an accumulating client collection.

The native public-command fixture creates 64 work, 3 decisions and 1 result
linked to two messages: 68 distinct objects and 132 SOURCE edges. The first
50-object window has 100 matching edges navigable in two groups of 50; the second
18-object window has 32 matching edges. Tests compare the complete kind/id union,
exact per-message counts, independent Previous/Next, edge reset on object change,
reload and account-scoped cursor memory. RELATED-only work is excluded from SOURCE
previews. The existing native Details route keeps all links reachable; its own
full-list migration remains open.

Actual route.fetch responses cover held reads, late responses, native cookie
account change, source-selector ABA while real auth revalidation is paused, and
required failure/retry without clearing the private reply. Focus/selection and
native reading anchors are checked. A single native smooth PageDown continues
while its batch delivery is held, and the returned observation preserves the
newest native anchor. A separate 141-message conversation verifies globally
bounded older/latest batches rather than an HTTP request per message.

The recovery fixture first proves a mounted first-source reader. It holds the
actual citation GET200, delivers a synthetic404, observes the original message
subtree become disconnected, then uses uninhibited native project200 responses
to restore the reader. It verifies the replacement subtree and older/latest/
older native chips. This is transient citation recovery, not native grant
revocation or physical-device proof. Read/navigation purity compares the target
project's work/decision/result DTOs and links before/after; it is not an all-DB
purity claim.

The older WorkDecisions completeness test now creates and records all 203 native
identities (101 work, 101 proposed decisions, 1 accepted rule). It checks exact
50/50/50/50/3 windows, the entire native ID union, exact counts, the same current
rule, terminal Next and direct Previous. This retains beyond-100 coverage under
the accepted bounded-page contract; it does not substitute for the 1000-work
performance fixture.

## Review, unsuccessful checks and harness limitations

Independent source review found and helped correct paused-dispatch scope
retirement, replacement-feed observation and interrupted/forgotten scrolling.
The final two-fixture revision was separately inspected at the immutable pin;
no remaining material source finding was reported. The reviewer ran no tests
and supplied no eligible whole-PR approval.

Fresh visual review found truncated phone task identities and unnecessary link
paging controls. Phone titles now remain whole, with owner/status below; a
complete link window retains its exact caption without redundant buttons.
Four final actual captures include mixed proposed/current/replaced decisions and
a result. Independent image-only review found no material issue in these supplied
states. It does not certify interaction, WCAG, motion or hardware.

Earlier checks failed the restored-feed fixture, smooth-scroll continuation,
strict result selector or old full-render expectation. The initial compiler
check also failed a ref parameter pattern. An attempted wait-for-all route cleanup
stalled; only the identified own UI-test one-off was stopped (exit137). A selected
WorkDecisions test initially lacked its mandatory test01 authentication setup.
These failures remain separate. One browser attempt began during prepare and is
explicitly excluded from final verification. Uncommitted intermediate variants
were not pinned; inputs.json describes only final source.

**The final wider log prints one Playwright asyncio CancelledError during route
teardown, outside the named test results.** Fixtures use ignoreErrors only for
unfinished routing handlers after native assertions. Browser pageerror assertions
remain and passed, but this does not prove every late fixture handler completed.
No clean routing-teardown claim is made. Original failed/pass logs are preserved;
raw-records.json records any credential redactions and actual process exits.

## Reproduce and continue

Check out the final source, copy this evidence folder from its later evidence
commit, then run `sh docs/agents/evidence/155-message-work-pages/reproduce.sh prepare`,
`message-client` and `message-work`. Defaults isolate flux155messagesrepro on
24581/24585; override COMPOSE_PROJECT_NAME and test ports for concurrent work.
Only clean that chosen stack. Owner used flux155browser on 18581/18585.

inputs.json hashes immutable git archive bytes and every saved output except
itself. Gzip/raw hashes and readable copies preserve terminal evidence; readable
copies only strip trailing ASCII whitespace and blank EOF lines. Saved wrappers,
current image IDs, viewports/zoom and four PNGs are included.

The parent ProjectShell still fetches complete work collections. Assistant work
reference/title/owner lookups in ProjectConversation remain legacy; so do
ProjectOverview, WorkDetails and document LinkPicker. Migrate those distinct
projections before removing the parent fetch. Whole-page fetch limits and the
original performance failure remain **unfixed/unverified**. Then rerun all eight
accepted 1000-work distributions (30 warm-ups, 200 actions, at least 60 seconds).
Canonical Task integration, real agents, motion, physical Android/iPhone/iPad
PWA/Web Push and integrated release acceptance remain required. Whole #155 and
the application are incomplete; PR170 remains draft without merge or closure.
