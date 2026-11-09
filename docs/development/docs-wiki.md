# Project docs and wiki (issue #112)

Foundation 8.7 and the #44 rule "what was learned informs knowledge without rewriting historical
statements". A project has many docs. Each doc has a title, a Markdown text and **immutable
versions**, each with its author, time and reason (the server's words; nobody types it). A page has no
Draft / Published state (#942). Docs link
to work, decisions, messages, sketches and other docs, and every linked object shows the
docs that link to it. Everything is visible exactly to the principals with current read access to
the project.

## Reusing #36 materials

A doc **is** a #36 project material of `kind = 'doc'` (migration `0013_docs.sql`). Its versions
are the same `project_material_versions` snapshots, with a new `reason` column. There is no second
version table.

- A message cites a doc version exactly as it cites a material:
  `source: { materialId: <docId>, version: 3 }`. The citation keeps reading version 3 after
  later edits; `GET /api/v1/materials/:id/versions/:version` still serves it, and the web app
  opens it in the doc reader.
- A database trigger rejects `UPDATE` on `project_material_versions`, so no version (of a doc or
  a material) is ever rewritten, even outside the API.
- `GET /api/v1/projects/:id/materials` lists only `kind = 'material'`; `PATCH /api/v1/materials/:id`
  on a doc is `409 USE_DOC_API`. Docs change only through the doc API below.
- People write docs through this API (`403 DOC_NEEDS_PERSON` for an agent principal); agents with
  a project grant read them. Since #152 (migration `0043`), an agent can also start and edit docs,
  but only under its owner's standing grant over MCP
  ([agent connection](agent-connection.md#project-wiki-docs-and-conversations)). The doc and each
  version then name that agent as their real author (`created_by_agent_id`, `author_agent_id`);
  only docs can be agent-written.

## API

| Method and path | Notes |
| --- | --- |
| `GET/POST /api/v1/projects/:projectId/docs` | List (most recently changed first; `limit`/`offset`) or create `{ title, body?, cause?, from? }` (`cause` is only `import`). |
| `POST /api/v1/projects/:projectId/docs/preview` | `{ body }` → `{ html, mentions }`, rendered exactly as a saved version (project read access). |
| `GET/PATCH /api/v1/docs/:docId` | `PATCH { title?, body?, cause? }` (`cause`: `restore`, `keep_mine` or `page_left`) needs `If-Match: "<version>"` (or `expectedVersion`): 428 without, `409 VERSION_CONFLICT` with the latest doc (`current`) when stale. A save that changes nothing returns the doc without a new version. |
| `GET /api/v1/docs/:docId/versions`, `GET /api/v1/docs/:docId/versions/:version` | Newest first, each `{ version, title, reason, author, createdAt }`; one version adds `body`, `html` and `mentions`. |
| `DELETE /api/v1/docs/:docId` | Deletes the page for everyone with access (#941, [below](#deleting-a-page-941)). Needs `If-Match: "<version>"` like an edit: 428 without, `409 VERSION_CONFLICT` with the latest doc when stale. `204`. A page that is gone, or that the caller cannot see, is `404 DOC_NOT_FOUND`; so a retry after the answer was lost is 404. |
| `POST /api/v1/docs/:docId/sections` | "Add to docs": `{ from: { type: 'decision', id } }`, with `If-Match`. |

Every POST/PATCH accepts `Idempotency-Key` through the shared runner in
`app/apps/server/src/http/commands.ts`; a replay rechecks current project read access. Responses with
a version carry `ETag`. A doc in a project the caller cannot see is `404 DOC_NOT_FOUND`, the same
as a missing one. **A person never types a version's reason or state** (#942): `state` and `reason`
are not fields any more and are dropped like any unknown field. The server writes the reason from the change, "Started the page",
"Renamed to “…”", "Edited the text" (joined with " · "), or, when the save names a **cause**, from the
cause it has checked against the page:

| `cause` | Allowed on | The reason the server writes |
| --- | --- | --- |
| `{ kind: 'import', fileName }` | create | "Imported from notes.md": the name's last part, without control or direction characters, on one line, at most 60 characters (a longer one keeps its start and its extension) |
| `{ kind: 'restore', version }` | save | "Restored version 3" (the version must exist), **only when the saved title and text are that version's**; any other save is described by its change |
| `{ kind: 'keep_mine', version }` | save | "In place of Ada’s version 4": the saver kept their text over the page's head, which Ada wrote. The sentence names the head the save replaces, whichever `version` the request names; over their own version the change describes itself |
| `{ kind: 'page_left', version }` | save | "Saved as the page was left, in place of version 4", with the page's head as the version |

A request that names a version the page does not have is `400`. The sentences are true to what happened (#1021): a request cannot make the
history say a restore that was no restore, or a version it did not replace.

A cause names no more than a kind and a version or file name; it adds nothing else to the page. The same
cause is accepted on the live save (`POST /api/v1/docs/:docId/live/save`), except `import`. Agents and the
assistant reach the same commands through MCP: an agent may say why in its own words (`reason`), and an
assistant's version reads "Asked by Ada: …" (F-036). Undo writes its own sentence. Export format 1 keeps
`state` on each doc version, always `published`, because removing a field needs a new `formatVersion`.

## Markdown and safety

The text is a small Markdown subset: paragraphs, headings, emphasis, strikethrough, lists,
quotes, code, tables, rules and links. The server renders it; the client only inserts the
server's HTML. Two independent layers (`app/apps/server/src/docs/markdown.ts`):

1. **markdown-it 15.0.2** with raw HTML off (it is shown as text), images off, linkify only for
   explicit `https://` addresses, and a link check after entity decoding that allows only
   `http(s)://`, `mailto:`, same-app paths (`/…`, never `//…`), `#…` and `flux:` references.
2. **sanitize-html 2.17.7** on the output with an allowlist of tags, attributes, classes
   (`doc-ref`, `language-*`), `text-align` styles on table cells and the schemes `http`, `https`,
   `mailto`. External links get `target="_blank" rel="noopener noreferrer nofollow"`.

`app/tests/app/docs.test.ts` checks `<script>`, `<img onerror>`, raw `<a href="javascript:">`,
`javascript:` in any case and entity-encoded, `data:` and `vbscript:` links, `data:` images,
autolinks, reference definitions, protocol-relative links, `<iframe>`, `<svg onload>` and
`<style>` in the saved doc, a version and the preview. `app/tests/ui/test_docs.py` loads hostile text
in the browser and asserts that no dialog opens and no image, script or hostile link exists.

## Links and backlinks

A doc refers to an object of its project with `[label](flux:<type>/<id>)`, where `type` is
`doc`, `work`, `decision`, `message`, `thought` or `sketch`. The editor's **Link**
picker (⌘/Ctrl K) inserts them. On each save the server parses the new text (only real links,
not code) and rewrites the doc's `mentions` links in the #101 `project_object_links` table: the
table accepts `doc` as a source and `doc` and `sketch` as targets (migration 0013). A reference to
something outside the project, a private sketch or a missing object is stored as nothing and
renders as quiet plain text "(not available)"; its title is never looked up outside the project.
Earlier versions keep their own text, so their references remain readable in history.

Backlinks are the incoming links: other docs that mention a doc, and work objects linked to it
(`POST /api/v1/projects/:id/links` now accepts `{ type: 'doc' }` and `{ type: 'sketch' }`
targets). Work items and decisions show "In docs" in their Details. Rendered references
open in the app: docs, messages and sketches by route, work objects in the Details panel
(`/projects/:id/tasks?open=decision:<id>` opens it from a new tab).

## Add to docs

On a decision, **Add to docs** (Details panel) starts a doc from it or adds it to an
existing doc as a new version. The doc also gets a `source` link to the object, which is kept
across later edits.

There is no result to add (#1054): what came of a task is its one line, and what matters is written on a page by editing it.

### Decisions in the Wiki (F-034)

Founder decision 2026-10-30 ([#763 E1](https://github.com/ColdPhase/flux/issues/763#issuecomment-6532915221)).
A **decision** is never copied into a page. Add to docs inserts one reference line at the end of
the page, `[title](flux:decision/<id>)` on its own line after a blank line (so it stands alone as
the card), as the next version with the reason "Added the decision “…”". If the page already
holds that line, nothing changes and no version is made.

- **The card.** The reader shows a decision reference standing alone on its line as Prostota's one
  line (`desktop-wiki.webp`): the state glyph and word ("Decision accepted", "Decision replaced"),
  the title, the date and who, and under it the decision's short reason, the first sentence of its
  rationale (`DecisionRowProjection.reason`, at most 160 characters). The whole card opens the
  decision in the Details panel. A reference inside a sentence stays an inline link.
- **Live.** The card is read from the decision as it is now (the reader's reference read on load,
  focus and every 20 seconds), so accepting or replacing a decision changes no page text and adds
  no version. A page's history holds the edits people make, and its outline its own headings.
- **Proposed decisions stay out.** Adding a proposed decision is refused with 422
  `DECISION_NOT_ACCEPTED` (also when starting a doc from it); the Details panel dims "Add to a Wiki page"
  with "Accept it first to add it to the Wiki". A decision referenced earlier that is later
  replaced shows "Decision replaced".
- **Nothing to convert.** Founder direction 2026-10-31: Flux is pre-release with no installations
  or data anywhere, so no page holds a section copied by the earlier "Add to docs" and there is no
  conversion job, migration or schema change. The card needs only the decision's existing fields.

## Deleting a page (#941)

⋯ › **Delete page** (desktop and phone) asks for an OK in the space's own dialog ("Delete <title>?": it says the page goes for
everyone, with its earlier versions, and that a message that cited it keeps its text). Deleting always waits for an OK (Prostota
principle 6). Anyone who may write in the space may delete a page; an earlier version is read-only and has no Delete.
`DELETE /api/v1/docs/:docId` takes the version the person saw (`If-Match`), so a page edited meanwhile is not deleted unseen. It runs in
one transaction with the page's row and its shared text locked, and removes the page by these rules. A write that waited for the page's lock while a delete committed finds the page gone: `404 DOC_NOT_FOUND`, never a 500 (a second Delete at the same moment reads the same, and the dialog treats a 404 as already deleted):

| What named the page | Rule |
| --- | --- |
| Its versions, shared working copy, receipts and archives | Deleted with the row (`ON DELETE CASCADE`). Nothing of the page can be read: its address, versions, shared text and `GET /api/v1/materials/:id/versions/:n` are 404. |
| Its links, from and to it (mentions, sources, backlinks) | Deleted, including a task's or decision's source that named one of its versions; the creation notice of a task made from it drops that entry (so a project export holds no id of a deleted page). A page that names it still reads the name as missing. The tasks it mentioned stay, and keep the evidence that the page used them. |
| Its search rows | Deleted by the version trigger that wrote them. |
| A message that cited one of its versions | Keeps its text. `project_messages.source_material_*` are cleared and `source_deleted` is set (the database refuses a row that is both); the API sends `source: null` and `sourceDeleted: true`, and the message shows a **Page deleted** card with nothing to open. |
| An agent suggestion about it (`agent_proposals`) | Cleared (deleted): it can no longer be acted on. |
| A task plan item made from it (`project_task_plan_intents`) | Cleared (deleted); the task made from it stays. |
| A live room on it (`live_sessions.doc_id`) | An open room becomes `ending`, which the live lifecycle finishes at the media server; an ended session keeps the page's id as history, so the column has no foreign key. The trigger `live_sessions_doc_in_space` (migration 0030) keeps what the key held: a new session, or a changed `doc_id`, must name a page of the session's own space (`foreign_key_violation` otherwise). Ending a room is a state change and does not fire it. |
| The people with it open | The shared-text connections are told on commit (`pg_notify`), find the page gone, and receive `revoked`; unsaved shared text goes with the page. The space's `project.doc_deleted.v1` event also reaches them, and the Wiki reads its list of pages again. An open page that learns it (the event, or the room closing) asks the server whether the space still answers and the page does not; if so it shows **This page was deleted** with a way back to the Wiki, and no editor. Text the person typed during the visit stays in the tab, in a read-only box with Copy my text. If the space does not answer either, it says access ended instead. |

It records one event, `project.doc_deleted.v1` with `{ docId, version }` (ids only). **Agents** propose it with `flux_delete_doc`
(operation `doc.delete`, postcondition `doc_removed`): the call always waits for the owner's OK in both modes that change anything (F-036
AG-3), shows as "Delete / Keep" in the owner's change log, and has no Undo, since nothing can be put back. A person-facing route refuses an
agent principal (`DOC_NEEDS_PERSON`); only the owner's approval runs the delete for the agent.

**Undo of a page an agent started** (AG-8, #1021) is this delete. The change log keeps a removal plan for `doc.create`; the owner's Undo
deletes the page, as the owner, if every version was written by that agent (or is the owner's own Undo of its edit), nothing names the page (a
link to it, a message that cited it, a suggestion or a task plan item made from it), no call is held on it and nobody has unsaved text in its shared copy. The delete
carries the version the check read, so an edit that lands meanwhile is a version conflict and the page stays. Otherwise the Undo changes nothing
and says "Changed since. Open it" or "Used since. Open it". The space's AI switch applies (as for any removal Undo).

## Events

A committed create, edit or section records exactly one project event in its transaction:
`project.doc_created.v1` or `project.doc_updated.v1`, `object_id` the project and
`data: { docId, version }` (identifiers only). The stream reaches current project readers; the
return view (#106) shows "Ari started a doc: …" or "Doc updated: …" with the versions made and
the latest reason, and links to the history from the version before them. A deleted page records
`project.doc_deleted.v1` (see above). Idempotent replays and refused changes record none.

## Web

`app/apps/web/src/docs/` is a space's **Wiki** tab, as the [final design](../design/final/README.md)
draws it since #869: two columns only, the sidebar and the page.

- **The page** (`…/docs/:docId`) is edited where it is read (`editing/WikiEditor.tsx`). Its text
  stays the Markdown the server stores and renders; `editing/livePreview.ts` draws it as the page
  (headings, emphasis, lists, quotes, code, rules, links and tables, with `@lezer/markdown`) and
  shows a line's or a span's marks only where the caret is. A `flux:` reference reads as the
  reader's chip or card (F-034) and opens what it refers to; on the line being written it reads as
  its label and kind (CW-4). ⌘/Ctrl K inserts a reference from the link picker, Enter continues a
  list or quote, ⌘/Ctrl B and I wrap bold and italic. There is no Write / Preview / Both, no raw
  Markdown field, no reason field and no Draft / Published in the interface or the API; versions get the
  server's reasons ("Edited the text", "Renamed to “…”", "Restored version N").
- **Versions save by themselves.** With live editing (#228) the text is the page's shared Y.Text;
  typing is shared at once, and an editor saves the confirmed head as the next version once its own
  text has rested for 2 s, at most once per 30 s per person, and at once when the person leaves the
  page. Text nobody present wrote is saved by an editor alone in the room. Another person's save of
  the same head is a quiet conflict. A native write while a page is open (an agent, Add to docs)
  starts a new generation; the room tells each open editor to read the page again (`resync`, reason `generation`, then it closes the connection, as the map's room does; #1116), and an editor with nothing pending opens it afresh, one with text of its own not yet shared keeps that text privately. Without live editing
  (`FLUX_LIVE_EDITING=off`) the editor holds this tab's copy and saves it with `If-Match` 1.2 s
  after typing rests; a concurrent save shows who saved, with "Keep my text" or "Use their version"
  (the server writes the kept version's reason from the cause, naming the version it replaced), and unsaved text survives a reload of
  the tab. A tab that closes with unsaved text sends it at once and also leaves a copy on this
  device (localStorage, removed at sign-out and once a save holds the text), which the next visit
  to the page restores whatever order the closing saves reached the server in (#967). The answer of
  the closing save is never seen, so a copy can outlive a save that went through: when the copy is
  older than the page and a later version by the same person already holds its text, the editor
  drops the copy before it opens (#982; it reads the newest versions after the copy, then at most five of
  the person's own in full, together, and gives up after three seconds with the copy kept), so there is no conflict with text the person already saved. The copies of
  other accounts are removed when an account's shell opens; an account's own never are, by age or otherwise: the copy exists only because
  every save sent as the tab closed was refused, so it may be the only place the text still is.
- **The row above the title**: "Saved · just now" (or "Saving…"), "Jonas is here too" and the faces
  of the people writing, **Contents** (≡: the headings, levels 1–3; choosing one scrolls to it,
  smoothly unless motion is reduced; "No headings yet" without any) and **⋯** (History, Copy link,
  Export, Import a Markdown file, Rename page, Delete page). The title is the **page switcher**: "Find a page",
  the space's pages by name with the open one checked, and "+ New page", which names the page in
  place and opens it with the caret in its text. `/projects/:id/docs` opens the page last open in
  this tab, else the latest change; a space without pages offers New page and the import.
  The save state is not a live region, so a screen reader does not hear "Saving…" and "Saved" at
  every pause; who joins ("Jonas is here too") is announced, and a failed save is an alert (#950).
- **Quiet while open (#862, #950).** A writer's unchanged caret is renewed every 2.5 s (the server
  keeps it 5 s) and only within 30 s of their last keystroke or caret move, like the enrollment;
  then their caret and face leave the other screens until they type or move it again. The room's
  `saved` message carries the saved version's title, so an open page follows a rename without
  reading the page. Rename and Restore save the head with their title or reason; when someone else
  typed or saved meanwhile, they try again on the newer head for up to 10 s.
- **History** (⋯ › History, `…/history?from=&to=`): every version with its reason, author and date,
  the comparison as the page reads or as exact Markdown, and **Restore version N**, which opens the
  page and makes that version the page again (shared at once with live editing) as the next version.
  An earlier version (`…/versions/:n`) is read as the server rendered it, with Restore.
- **Import a Markdown file** (`markdown-file.ts`): one `.md`/`.markdown` file of at most 400 KB and
  100,000 characters, valid UTF-8 without NUL; anything else is refused with its reason and nothing
  is created. The title comes from a leading `# Title`, else the file name; line endings become
  `\n`; the rest is the page's text, unchanged.
- **Export**: the open page or version as Markdown; managers choose between the page and the whole
  space as a bundle, from the server's export route, which requires `project.manage`.
- **Copy link** copies the page's address, with the exact link selected on the page when the
  browser refuses the clipboard.

A task or decision opened from a page opens over it, never as a column beside it. On a phone
the same page has the same row and menus within its column; targets are 44 px on touch.

## Tests and evidence

`app/tests/app/docs.test.ts` (API, two people, an outsider and an agent principal:
access, version immutability and citations, If-Match 428/409 and a concurrent race, idempotent
retries, links and backlinks across all target types without cross-project leaks, sanitization,
Add to docs with decision references, the F-034 migration, events and the workspace list filter), `app/tests/app/returns.test.ts`
(doc items in the return view), `app/tests/app/wiki-decision-cards.test.ts` (F-034: the reference line, the live card read, proposed decisions refused, the text rules and an encrypted workspace) and, in the browser,
`app/tests/ui/test_wiki_final.py` (the page as drawn: two columns, the switcher, Contents, ⋯, the
title row in one place with one page or many, tables, the phone), `test_wiki_panes.py` (the journey:
writing and automatic versions, New page, Import with its refusals, History, Restore, Rename,
exports compared byte for byte, Copy link, phone 390 and 320, tablet 820, contrast),
`test_docs.py` (a page with a reference, two people at once, history and diff, add from a decision,
the phone, hostile text), `test_wiki_panes.py` also covers Delete page (`test_12` and `test_13`, the computer and the phone; `test_14`, a page deleted while it is open),
`app/tests/app/docs-delete.test.ts` (#941: the version it needs, everything the delete
removes, a citing message, suggestions and plan items, a live room, the event, access, a write that waits for a delete, an encrypted space), `live-doc-anchor.test.ts` (a live room stays in its page's space), `test_doc_references.py` (the link picker), `test_wiki_decision_cards.py`
and `test_live_editing.py` (two people, sockets and automatic versions).

## Not yet

Live shared text with named writers/cursors before Save is required by
[F-021/#228](live-editing-proposal.md). The independently assessed contract is
admitted only for disabled calibration; current saved-version writes do not deliver
it. The future shared working body is distinct from immutable saved versions and
citations, with a shared-core fence on every native writer and explicit private
recovery. Existing local recovery must never broadcast automatically. #61 provides
authorized media/shared context; it did not deliver wiki character co-editing.

File uploads and images (a separate slice), real-time co-editing (#228), agent doc writes outside
a standing grant, full-text search inside the wiki index (the index filters by title and excerpt;
Search and Jump to already find doc text), and moving a doc between projects.
