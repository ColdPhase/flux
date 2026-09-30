# Confirmed thought capture (#149)

Recorded before implementation, 2026-09-30, under the accepted Studio 11.6
UI116-1/4 and #149 contract. The #134 personal ID-only outline, shared graph,
source navigation and map camera remain authoritative.

New root/child capture opens one private draft per account/workspace/place/map.
It retains text, intended parent ID, client thought/link IDs, position and an
idempotency key in this tab's session storage, with memory fallback. No shared
thought, relation, event, outline grouping or API write exists before Save/Enter.
List/Map and map navigation retain it; blur never saves. Empty Save leaves the
draft open; Cancel/Escape discards it without a server mutation. Signing out
clears the tab's thought drafts. A different account cannot restore them.

Save locks the submitted text while the existing authorized atomic thought+
optional-link command runs. Only a confirmed response adds the thought to the
local document, records its normal undo step, groups its ID in this person's list
and clears the draft. A failed/uncertain response retains the text and the stable
client IDs/key for explicit retry; no replacement ID or partial-link command is
created. The server rechecks the intended parent and current write access.
Editing after a failed attempt gets a fresh request key while retaining the
thought ID, so an uncertain earlier creation cannot become a duplicate thought.
A parent removed or access revoked is an error; it never silently becomes a root.

Existing thought editing remains inline. F2 and visible Edit open the same text
editor; Enter saves, Shift+Enter is multiline, IME composition does not commit,
and Escape or visible Cancel edit retains the original. The visible Save edit
control also works with touch. A text edit submits the version captured when the
editor opened, even if a newer version arrives over the stream. Failed/conflicting
text remains in the editor and must remain recoverable
and must not force an overwrite of a newer version. Form/modal shortcuts retain
normal scope. API/persistence tests and real two-user browser paths verify these
states; pictures cannot certify them.
