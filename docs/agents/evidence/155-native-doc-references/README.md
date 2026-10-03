# Native document references and private editor ownership — #155

2026-10-03. Owner Zamojski5, existing branch
`claude-maurycy/155-truthful-typing`, draft PR170. Tested runtime
`5a1dfaa04edeedc0d552cd6050d99d9b3dd66c1e`; base composition evidence
`c4f01936e5cdc49eae8b0fe7978b7f8daf6126df`. This is a bounded implementation
checkpoint under the [existing slice contract](../../../development/performance/2026-10-03-native-doc-ref-migration.md),
not completion or merge readiness of the original task.

## Observable behavior and actual verification

The document reference picker uses the accepted native `doc_refs` choice API:
up to50 rows of each enabled kind, complete next/previous pages and literal title
search; no native full work/decision/result collection in the picker. All types
keeps mixed40-match discovery; selecting a native type exposes the complete native
window. Existing document/project-sketch/recent-message discovery remains; this
stage does not certify global non-native/message pagination or removal of the
parent's complete native collections.

The entire private editor lifetime now belongs to the account/project/document.
Same-route revalidation and parameter navigation preserve only that owner's draft.
An old pending native read cannot revive a retired scope. A successful save waits
for router ownership to settle; switching editor retires its navigation/storage
callbacks. Reopening the original draft retains the same persisted native retry
UUID, so a committed save retried after scope change creates one document.
Revalidation retaining the same editor finishes its queued save normally. Preview
cancellation and scheduled picker focus do not publish into a retired editor or
steal a newer title-field focus. Native commands/final server authorization remain.

Actual isolated Docker run [raw log](5a1-sixteen-pass.log.gz): **EXIT0,16/16 UI,
0 skips,29.315s**, rebuild/typecheck/lint passed. Lint has one pre-existing
WorkReadContext useMemo warning and zero errors (the preceding0cdf run had a
second cleanup-ref warning, subsequently removed by capturing the same Set).
`run-ui.sh` derives the trusted repo UI runner and only selects `test_docs` and
`test_doc_references`; its original absolute worktree path/ports are recorded.
Compose project `flux-ui-1791000347-81737` must be checked against the raw log;
project names are generated per run. Only the disposable run resources are removed.

The native/browser fixtures and assertions exercised:

- 105 actual objects of each work/decision/result kind:50/50/5 distinct pages,
 previous page, off-page literal search, other-project exclusion and all105 IDs.
 Actual native response observations assert requested limit50 and <=50 rows;
 these are separate from the DOM count assertion.
- All six kinds insert the exact `flux:type/id`; phone uses actual browser taps.
 Save persists all six native mention links; the edited document excludes itself.
- Keyboard selection beyond40 stays exposed inside its own list. Phone insertion
 guidance is asserted inside the viewport. Search/type/page identities remain clear.
- A required503 hides partial matches; retry preserves query/private text. Both
 desktop1440x900 and emulated phone390x844 execute this and the scope scenarios.
- Same-document project and document navigation, shared-cookie account change with
 same-route router revalidation, held old account response and held query A→B→A.
 No fabricated native response content or identity ACK. Browser abort behavior is
 distinct from the existing read-store generation/unit evidence for abort-ignoring
 transports; these browser scenarios do not certify an abort-ignoring network.
- A native save committed before leaving its editor is completed after new scope
 commit, or while both destination project loaders are held. It cannot redirect
 the new scope or erase the old owner's retry UUID. Same-key native retry creates
 exactly one document; a same-editor held revalidation finishes normally once.
- Existing document creation/preview/citation/publish, concurrent version conflict,
 version history/diff, adding a native result section, phone reading/editing and
 hostile Markdown assertions remain unchanged and pass.

Setup/local links and all63 foundation tests pass; owned delta whitespace passes.
These host Python checks are repo setup checks, not application verification.
App dependencies, services, native persistence and browser tests ran in Docker.
The raw API logs contain native request evidence; screenshots cannot certify it.

## Independent assessment and failed baselines

Independent source reports retain the original findings and repairs, with exact
heads. The initial review found unkeyed private editor ownership (P1). The6db real
baseline passed10/12 tests and failed both project/account draft boundaries. Later
source review identified save completion during pending destination loaders (P2);
the247 real baseline redirected back to the old reader. Both findings were repaired
and independently assessed in subsequent source reports. Source-only reports
attribute runtime evidence to the owner and are not eligible GitHub approval.

All raw iterations are retained: a61 lint failure,757 ambiguous test controls,
6db real ownership failures,8ac newer title focus stolen,247 real pending-loader
redirect,0dad mobile drawer/late-bound cleanup fixture failures,0cdf16-test pass,
and current5a1 pass. No failing baseline is relabelled as accepted runtime.

Neutral screenshot reviews are separate from behavior. Their earlier scope-hint
and out-of-viewport touch-cue findings remain in the reports. Current rendered
review has its own screenshot hashes/head. Images and emulated phone journeys are
not real installation, Web Push, accessibility or hardware acceptance.

## Required continuation

PR170 stays **draft**, issue155 open. Original AC1–AC5, remaining assistant native
citation/title/owner/version readers, full parent loader migration, complete scale
and motion/typing matrix, superseded-only native fixture, eligible independent peer
assessment, integrated current candidate and applicable real-device/provider/MCP
client/install/release evidence remain required. Earlier ca full676 API and230
59-test composition evidence stays at its original pins and is not transferred to
this head. Next owner action is the remaining native assistant/full-parent migration;
next peer action is a bounded independent assessment of this pushed checkpoint.
