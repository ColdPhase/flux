# Confirmed thought capture (#149)

Recorded before implementation, 2026-09-30, under the #149 contract. Appearance follows the
[final design](final/README.md) (F-026), whose rule P12 adds the draft thought on release. The #134 personal ID-only outline, shared graph,
source navigation and map camera remain authoritative.

New root/child capture opens one private draft per account/workspace/place/map.
F-026 S15 and #349 AC-3 limit screens at or below 640 CSS px to plain additions:
selection, keyboard Add and clipboard text/lines/images never infer a parent there.
A draft opened on a wider screen retains its content when narrowed. Before its
first Save it shows a plain addition and saves without creating a connection on the phone.
Existing graph links and saved thought positions remain unchanged. Wider screens
keep confirmed connected capture and the intended-parent checks described below.
The actual creation payload is recorded per thought immediately before dispatch.
Changing screen width never rewrites an attempted payload or renews its key.
Refining text after an uncertain Save also retains the original creation body/key;
the desired text and its edit key are separate. Only after confirming current server
state may explicit Save refine that text through the ordinary version-checked edit.
An unsent draft first saved on a phone keeps that plain-addition intent on later
retries. For an earlier connected attempt, the phone only confirms an existing
server thought (and, if edited, uses the ordinary version-checked text update);
it does not dispatch or recreate its connection. If that thought is not present,
the text stays recoverable and the earlier save must be checked/retried on a
computer. Partial pasted batches retain each dispatched row's own canonical
payload while unsent rows may first be saved as plain additions on the phone.
Missing canonical metadata never proves that a key was unused, including in a
tracked-format copy left behind by a refused storage write. A separate unused
proof belongs to this account/place/map, thought ID and creation key. Before a
creation dispatch the client removes that proof and verifies its absence, while
retaining the canonical attempt in memory and trying to persist it. Refusing the
full attempt write alone does not disable memory-only Save. If neither canonical
persistence nor invalidation can make stale unused authorization unusable, only
that dispatch is refused: no request is sent, text/IDs/keys stay, and the draft
keeps its known unused retry state rather than claiming an attempt was dispatched.
A fresh thought whose bound unused proof never existed can save entirely in
memory even when all storage access is blocked. Successfully retained canonical
state already makes an older unused proof irrelevant; later storage refusal does
not convert that known creation back into unused or unknown intent.
After reload, a valid canonical attempt wins over any stale unused proof; a valid
unused proof permits first Save; neither is an unknown save on every viewport.
Unknown and historical markerless copies only confirm an existing server thought
and use an ordinary guarded refinement. An absent thought retains the original
text/IDs/coordinates/key with an unresolved-save message; widening alone cannot
recover lost canonical information. Confirmation does not create a link or infer
personal outline grouping from the stale draft's parent. Unrelated grouping and
drafts stay intact. A refinement is submitted only by explicit Save, against the
version just read and the known earlier text; a different peer text is shown
without overwriting it and the person's retained text stays recoverable.

This refused-storage lifecycle was independently reviewed on 2026-10-10 for
#380/#349 against #149 AC-2/AC-3. It preserves memory-only Save during the visit
and the existing limit that reload can recover only accepted storage. It adds no
public API or server reservation contract.
It retains text, intended parent ID, client thought/link IDs, position and an
idempotency key in this tab's session storage, with memory fallback. No shared
thought, relation, event, outline grouping or API write exists before the first Save/Enter.
An uncertain response may already have published the earlier write; the draft says
that its save is unconfirmed rather than claiming it is still certainly private.
List/Map and map navigation retain it; blur never saves. So do the task
count chooser (opening it, Escape, Close and opening a task beside the map) and switching
project views (Conversation, Agents, Tasks, Wiki) within the same visit. Empty Save leaves the
draft open; Cancel/Escape discards it without a server mutation. Signing out
clears the tab's thought drafts. A different account cannot restore them.

This visit's newest copy is authoritative. If the browser refuses a storage write
(for example a full quota) and still holds an older persisted copy, leaving the
map and reopening it in the same visit restores the newer text; no shared write
occurs. A reload can recover only what storage accepted. Once storage accepts
writes again it holds the newest text, and Save, Cancel and sign-out clear both
copies. Another tab never sees this tab's draft.

Save locks the submitted text while the existing authorized atomic thought+
optional-link command runs. Only a confirmed response adds the thought to the
local document, records its normal undo step, groups its ID in this person's list
and clears the draft. A failed/uncertain response retains the text and the stable
client IDs/key for explicit retry; no replacement ID or partial-link command is
created. The server rechecks the intended parent and current write access.
Editing after a failed attempt gives the refinement its own edit key while
keeping the immutable creation body/key and thought ID. A creation replay or
`THOUGHT_EXISTS` recovery reads authoritative current state rather than trusting
an older creation receipt. Only the known earlier text may then be refined by an
ordinary edit at the version just read; another author's newer text remains a
conflict. A restored copy with unknown earlier text may only refine its owner's
untouched version-1 creation, never silently replace a later version.
A parent removed or access revoked is an error; it never silently becomes a root.

Existing thought editing remains inline. F2 and visible Edit open the same text
editor; Enter saves, Shift+Enter is multiline, IME composition does not commit,
and Escape or visible Cancel edit retains the original. The visible Save edit
control also works with touch. A text edit submits the version captured when the
editor opened, even if a newer version arrives over the stream. A newer version
that still has the opened text (a move, resize or shape change, including this
person's own nudge just before editing) is not a conflict: the edit is sent once
on that version. Only a changed text is a conflict. Failed/conflicting
text remains in the editor and must remain recoverable
and must not force an overwrite of a newer version. Form/modal shortcuts retain
normal scope. API/persistence tests and real two-user browser paths verify these
states; pictures cannot certify them.

Independent image assessment found that desktop failure/conflict wording was clipped
at the toolbar's right edge. Recovery wording must wrap in a dedicated full-width
row immediately above the current edit actions, keeping the retained text and
next action visible. Ordinary concise status stays compact. This finding is part
of #149's truthful failure/recovery scope.

## Paste on the map (#252)

Recorded before implementation, 2026-10-05. Paste only fills the same private
draft; nothing shared is written before Save, and Save uses the commands above.

- **Where.** Ctrl/⌘ V while focus is on the map or list (a thought, the canvas
  or the page itself). Text fields keep their native paste: the thought editor,
  the draft field and the sketch name are never intercepted. Touch devices,
  which have no paste shortcut there, get **Paste lines, a link or an image** in
  the empty new-thought draft (Thought, then Paste). It reads the clipboard
  through the browser's own permission prompt and fills that draft, keeping its
  parent; when the browser refuses, the status says so and nothing changes. The
  toolbar keeps its tools, so phone widths keep their two rows.
- **Who and when.** Only people who can change the map. A viewer's paste reads
  nothing, uploads nothing and says “You can look at this map but not add to
  it”. While an edit or another draft is open, paste says to finish or cancel it
  first. With clipboard text and an image together, the image wins.
- **Lines.** Lines are trimmed and empty ones dropped. One line is the ordinary
  draft with that text. Several lines become one draft with one row per future
  thought, at most 50 (`SKETCH_LIMITS.pasteLines`); a paste with more is refused
  as a whole with the count, and nothing is drafted. A row over the 1,000-character
  thought limit is marked and blocks Save until it is shortened or removed. Each
  row keeps its own thought ID, link ID and request key; all rows share the
  intended parent of the Thought button (the last selected thought, else top
  level) and take the next free spots. Rows are editable and removable; Enter
  saves all, Escape or Cancel discards all.
- **Saving lines.** Save sends the rows in order through the atomic
  thought(+link) command. Only confirmed rows join the map, as one undo step
  (“added N thoughts”) that removes all of them. A failed row stops the run: the
  confirmed rows stay saved, the rest stay in the draft with their IDs and keys,
  and the status says how many were saved. A retry reuses those IDs and keys, so
  an uncertain earlier creation cannot duplicate a thought (`THOUGHT_EXISTS`
  recovery as above).
- **Links.** A paste whose whole text is one `http:`/`https:` URL is a draft
  whose text is that URL. No page title is fetched: on 2026-10-05 Flux had no
  server-side page fetch path, and the only guarded fetcher is the F-020 AI
  endpoint guard, which is not a page fetcher. A title fetcher needs its own
  SSRF-reviewed contract. Any thought whose whole text is one `http(s)` URL shows
  as a link (its host, opening in a new tab with `noopener noreferrer`); other
  schemes stay plain text. A URL row of a line paste becomes a link the same way.
- **Images.** Project maps only, because stored files belong to a project;
  private and DM maps refuse an image with a message. PNG, JPEG, GIF or WebP from
  1 byte to 5 MiB (the stored-file limit); another type, an empty or a larger file
  is refused before any upload. The image is staged privately through the
  stored-files path (uploader-only, never shared; the #252 exception to “no API
  write before Save”). The draft then holds the staged file's ID, name and size
  and an editable caption, prefilled “Pasted image”. Save creates the thought
  with `fileId`, and the server publishes the file to it in the same transaction
  (see the [stored-files amendment](../development/task-discussions.md#map-thought-images-252-migration-0051)).
  Cancel discards the draft; the staged file stays private and expires after
  7 days (there is deliberately no delete route). A failed upload creates no
  draft and says why. After a reload the draft still names the staged file and
  the preview downloads it for its uploader only.
- **Showing images.** An image thought shows its image above the caption. The
  web app downloads the bytes with the session, accepts only PNG, JPEG, GIF or
  WebP by their signature (never SVG) and shows them from a local object URL.
  New image thoughts start at 240 × 200 and resize like any thought. Removing
  one removes the thought; the file stays published to the project, and Undo
  restores the same thought with the same image.
