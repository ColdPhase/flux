# Safe route-code recovery — #326

2026-10-08, accepted bounded peer correction to the existing #326 contract. A
failed code download must not turn a visit-only private copy into the older stored
copy, discard an unsent command/file/reference, or claim durability that the
browser refused. The original lazy-route, entry-size, phone, compression and PWA
criteria remain required.

The existing Home/form drafts, shared composer snapshots and thought drafts
publish only reload-risk metadata to a small shared registry. They retain their
original text, immutable command/upload/thought/reference identities and storage
formats. A refused empty clear is also a risk: a new document could resurrect its
older stored value. Unfinished selected file bytes are visit-local even when their
metadata was stored. Reading positions and empty untouched drafts do not falsely
claim unsent work. Successful persistence/settlement or the existing confirmed
session retirement updates the corresponding metadata. Recovery never retires
another account's work or grants access.

Code-error and optional-surface recovery validate the current account/session
through the existing identity API and observe the current registry. Unknown,
failed or changed validation cannot assert that reloading is safe. A genuinely
verified writable-storage case keeps the real document Reload action. When
current owned volatile work would be lost, hard reload is unavailable and the
message says to keep this tab open and return to the work. Go to Home and existing
Close/Escape paths preserve the current visit. No generic confirmation,
reauthentication, fake persistence success or cold import of a heavy route is
introduced. Private contents, keys, account IDs and counts are not exposed in the
error message.

Before performing a reload, validate again and re-read the risk; an edit, upload,
retirement, owner change or unmount during that check invalidates the old decision.
Account/session boundaries and existing server-side permissions remain authoritative.

Verify the old source separately: store A, exhaust actual browser storage, edit B,
fail a real secondary chunk and restore its delivery. Its unguarded reload can
restore A. The corrected case must retain B in this document, refuse destructive
reload, recover through Home/Close with the same identities, and permit genuine
network-restored reload once persistence is safe. Cover Home and shared composers,
failed clears, thought captures, unfinished file bytes and current-session
validation/refusal/late response. Run Chromium and WebKit in isolated Docker;
source preparation alone is not a runtime pass. Keep the original nine route,
phone, asset-delivery, offline and compression guards unchanged.
