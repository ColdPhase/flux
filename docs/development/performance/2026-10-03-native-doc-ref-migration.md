# Native document reference picker migration — #155

2026-10-03. Implementation slice within the already independently accepted
[native work read contract](2026-10-01-native-work-read-contract.md), using its
existing `purpose=choices&choice=doc_refs&kind=…` API. Owner remains Zamojski5 on
existing branch/draft PR170; independent final evaluator PelikanFix16. This is not
a new public API, task admission, parent criterion reduction or accepted runtime.

- LP1: no `loadProjectWork` or complete native work/decision/result collection in
  LinkPicker. Keep one <=50-row native observation per enabled kind. All types
  retains mixed discovery; a compact type selector exposes complete next/previous
  native pages without concatenation. Search uses the native literal title query,
  retaining the existing kind-prefix search behavior.
- LP2: preserve all six reference kinds, exact native IDs and Markdown insertion,
  document self-exclusion, pinned reader destinations and private unsaved editor.
  Existing document, project sketch and recent-message discovery scope is retained;
  this slice does not claim all-message/global non-native pagination.
- LP3: account/project/self/type/search/page scope retires old responses at render
  and after abort-ignoring A→B→A reads; dispatch pauses during router identity
  revalidation. Loading/unavailable/empty stay distinct. A failed required read
  cannot publish a partial list as all matches; explicit retry preserves query
  and the private editor. Native commands and final authorization stay unchanged.
- LP4: keyboard and touch can reach/select native entries beyond the old40-match
  cap, with the selected option exposed within its own list. Real browser/native
  persistence checks cover >100 objects of each native kind, scoped title search,
  six-kind insertion, failure/retry, held old scope and account/private draft fences
  on desktop/phone. Fresh neutral rendered assessment stays separate from behavior.

Full-parent native collections, assistant titles/owner/version readers, original
#155 AC1–AC5, complete scale matrix, superseded-only native fixture and whole
application/device/provider/release acceptance remain required work.
