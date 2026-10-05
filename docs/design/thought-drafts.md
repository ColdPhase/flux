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
Editing after a failed attempt gets a fresh request key while retaining the
thought ID, so an uncertain earlier creation cannot become a duplicate thought.
If that earlier creation did commit, the next Save finds the thought by its ID
(`THOUGHT_EXISTS`). It then finishes the save: the newer text is sent as an
ordinary edit at the version just read, so another author's change in between
is still a conflict.
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
