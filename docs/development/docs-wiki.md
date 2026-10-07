# Project docs and wiki (issue #112)

Foundation 8.7 and the #44 rule "results inform knowledge without rewriting historical
statements". A project has many docs. Each doc has a title, a Markdown text, a draft or
published state and **immutable versions**, each with its author, time and reason. Docs link
to work, decisions, results, messages, sketches and other docs, and every linked object shows the
docs that link to it. Everything is visible exactly to the principals with current read access to
the project; draft is a state, not a second audience (private notes stay #36 private drafts).

## Reusing #36 materials

A doc **is** a #36 project material of `kind = 'doc'` (migration `0013_docs.sql`). Its versions
are the same `project_material_versions` snapshots, with two new columns: `state` and `reason`.
There is no second version table.

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
| `GET/POST /api/v1/projects/:projectId/docs` | List (most recently changed first; `limit`/`offset`) or create `{ title, body?, state?, reason?, from? }`. New docs are drafts unless `state` says otherwise. |
| `POST /api/v1/projects/:projectId/docs/preview` | `{ body }` → `{ html, mentions }`, rendered exactly as a saved version (project read access). |
| `GET/PATCH /api/v1/docs/:docId` | `PATCH { title?, body?, state?, reason? }` needs `If-Match: "<version>"` (or `expectedVersion`): 428 without, `409 VERSION_CONFLICT` with the latest doc (`current`) when stale. A save that changes nothing returns the doc without a new version. |
| `GET /api/v1/docs/:docId/versions`, `GET /api/v1/docs/:docId/versions/:version` | Newest first, each `{ version, title, state, reason, author, createdAt }`; one version adds `body`, `html` and `mentions`. |
| `POST /api/v1/docs/:docId/sections` | "Add to docs": `{ from: { type: 'result' \| 'decision', id } }`, with `If-Match`. |
| `GET /api/v1/workspaces/:workspaceId/docs` | Docs in every project of the workspace that the policy's `visibleFilter` lets the caller read, applied before the page and the total. |

Every POST/PATCH accepts `Idempotency-Key` through the shared runner in
`app/apps/server/src/http/commands.ts`; a replay rechecks current project read access. Responses with
a version carry `ETag`. A doc in a project the caller cannot see is `404 DOC_NOT_FOUND`, the same
as a missing one. When no reason is given, the server writes one from the change: "Started the
doc", "Published", "Moved back to draft", "Renamed to “…”", "Edited the text" (joined with " · ").

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
`doc`, `work`, `decision`, `result`, `message`, `thought` or `sketch`. The editor's **Link**
picker (⌘/Ctrl K) inserts them. On each save the server parses the new text (only real links,
not code) and rewrites the doc's `mentions` links in the #101 `project_object_links` table: the
table accepts `doc` as a source and `doc` and `sketch` as targets (migration 0013). A reference to
something outside the project, a private sketch or a missing object is stored as nothing and
renders as quiet plain text "(not available)"; its title is never looked up outside the project.
Earlier versions keep their own text, so their references remain readable in history.

Backlinks are the incoming links: other docs that mention a doc, and work objects linked to it
(`POST /api/v1/projects/:id/links` now accepts `{ type: 'doc' }` and `{ type: 'sketch' }`
targets). Work items, decisions and results show "In docs" in their Details. Rendered references
open in the app: docs, messages and sketches by route, work objects in the Details panel
(`/projects/:id/tasks?open=decision:<id>` opens it from a new tab).

## Add to docs

On a result or decision, **Add to docs** (Details panel) starts a doc from it or writes its
section into an existing doc as a new version. The section is a `## Result: …` or
`## Decision: …` heading with the finding or rule state, its evidence or rationale, and a
`Source: [title](flux:result/<id>)` line. The doc also gets a `source` link to the object, which
is kept across later edits. Adding the same object again rewrites **only its section** (found by
its `Source:` line; other text is kept byte for byte) with the current state, for example
"Earlier rule · replaced Sep 28 by [new rule]", as the next version with the reason "Updated the
decision “…”". The earlier statement stays in the earlier version. Nothing to change makes no
version. Headings inside quoted evidence are escaped so a section keeps its shape.

## Events

A committed create, edit or section records exactly one project event in its transaction:
`project.doc_created.v1` or `project.doc_updated.v1`, `object_id` the project and
`data: { docId, version }` (identifiers only). The stream reaches current project readers; the
return view (#106) shows "Ari started a doc: …" or "Doc updated: …" with the versions made and
the latest reason, and links to the history from the version before them. Idempotent replays and
refused changes record none.

## Web

`app/apps/web/src/docs/` is a project's **Wiki** tab, two panes (appearance per the
[final design](../design/final/README.md)):

- **Page index** (`Wiki.tsx`, 212 px): the project's pages with drafts marked, a search box that
  filters by title and excerpt (with a count and an empty state; Escape clears), **New page** and
  **Import .md** for people who can write. The selection is quiet: a 4% tint, weight 600, a 3 px
  dot and one `aria-current`. `/projects/:id/docs` opens the page last open in this tab, else the
  latest change.
- **Top bar** (57 px, sticky): what is open, "Unsaved changes in this tab" when a draft of an edit
  is kept, quiet icon actions (Share, Download, History, Focus) and one primary (Edit for writers).
- **Reader** (`…/docs/:docId`, earlier versions at `…/versions/:n` with a calm "earlier version"
  line), **editor** (`…/new`, `…/edit`: Write · Preview · Both on wide screens, the server-rendered
  preview, the link picker, ⌘/Ctrl S saves, ⌘/Ctrl ⇧ P toggles the preview, unsaved text kept in the
  tab's session storage) and **history** (`…/history?from=&to=`: every version with its reason and
  a line diff with changed words marked, jsdiff 9.0.0, folded context, `+`/`−` marks and
  screen-reader words so colour is never alone). A concurrent save shows who saved which version,
  "Show their changes" as a diff, and the explicit choices "Keep my text on top of version N" or
  "Discard mine, use theirs"; nothing is overwritten silently.
- **Import .md** (`markdown-file.ts`): one `.md`/`.markdown` file of at most 400 KB and 100,000
  characters, valid UTF-8 without NUL; anything else is refused with its reason and nothing is
  created. It always creates a draft; the title comes from a leading `# Title`, else the file name;
  line endings become `\n`. The body goes through the server's renderer like any edit
  (`markdown-it` with `html: false`, then `sanitize-html`).
- **Download**: the open page or version as Markdown. Managers also get the whole project as a
  bundle, from the server's export route, which requires `project.manage`.
- **Share**: copies the page link (with a selectable fallback when the clipboard is refused) and
  names the page's audience, with "See who has access".
- **Focus**: hides the index and keeps that choice in the tab.

Home › Wiki lists the docs of every readable project. On a phone or a narrow pane the index becomes
a search row with a horizontal strip of pages above the document; while a page is edited the strip
steps aside, the bar scrolls with the page and only Cancel / Save stay at the bottom, so the text
field is never covered. Targets are 44 px on touch.

## Tests and evidence

`app/tests/app/docs.test.ts` (API, two people, a viewer, an outsider and an agent principal:
access, version immutability and citations, If-Match 428/409 and a concurrent race, idempotent
retries, links and backlinks across all target types without cross-project leaks, sanitization,
Add to docs with section rewrite, events and the workspace list filter), `app/tests/app/returns.test.ts`
(doc items in the return view) and `app/tests/ui/test_docs.py` (Playwright: write with preview and a
link, publish, concurrent edit and conflict, history and diff at 1440 and 1280, add from a
result, phone read/edit/compare, hostile text) and `app/tests/ui/test_wiki_panes.py` (the two panes,
quiet selection and focus ring in every theme, search and its count, New page, Import .md with its
refusals, downloads compared byte for byte, the managers-only bundle, share, focus mode, phone 390
and 320 with the editor's text field uncovered, tablet 820). Screenshots: `docs/design/docs-wiki/`.

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
