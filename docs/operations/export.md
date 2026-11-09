# Project export

A project export is an open, documented copy of one project that people can read,
keep and process with ordinary tools. It is not a backup: it has one project and none of the
private or internal data that a [backup](backup-restore.md) keeps.

**Re-import is not part of this slice.** Format version 1 has no import; every export says so in
`provenance.reimportSupported: false` and in its README.

## Getting an export

| Way | Result | Who |
| --- | --- | --- |
| `GET /api/v1/projects/:projectId/export` | `project.json` (`application/json`) | A signed-in person with `project.manage`. |
| `GET /api/v1/projects/:projectId/export?format=bundle` | The bundle (`application/gzip`, `Content-Disposition: attachment`) | Same. |
| `./flux export <project id or exact name> [--as EMAIL] [--output FILE]` | The bundle in `exports/` | The operator, acting as the account `--as` names, by default the workspace's first owner. |

`project.manage` belongs to a space's admins and to the company's owners and admins
([access policy](../development/access-policy.md#rules)). An invisible project answers
`404`, a visible one the caller may not manage `403`, a missing session `401`. The command line
runs the same core use case as the API inside the API container, as that account, so the
policy decides there too (`--as` a member without `project.manage` is refused). Responses carry
`Cache-Control: no-store`.

Export metadata is read in one read-only `REPEATABLE READ` transaction, so all
relationships show the same moment even while people keep working. Published
attachments are immutable. Bundle generation checks their size and SHA-256 before
responding, then reads one file at a time outside SQL and streams tar and
asynchronous gzip with backpressure. A disconnected HTTP client cancels further
reads. A later missing/corrupt object fails the archive stream; it never silently
omits files or writes a successful partial manifest.

## Bundle

```
flux-project-<first 8 of project id>-<UTC time>/
  project.json                          the whole project (below)
  files/<file id>                       exact published attachment bytes
  docs/<doc id>.md                      current Markdown text of each doc
  schema/project-export.v1.schema.json  JSON Schema (draft-07) of project.json
  README.md                             what is in it and what is not
  manifest.json                         path, bytes and SHA-256 of every other file
```

Any `tar` extracts it (`tar -xzf flux-project-….tar.gz`). The launcher prints the bundle's own
SHA-256. Only published attachments join the bundle under `files/`; private staged
uploads are excluded. Original display names and relationships are in `project.json`.
JSON-only export carries metadata, while the bundle carries the bytes as well.

## `project.json`

A task's discussion is a conversation of the project, so it is in the `conversations` array with the others, agents' messages included (a task has one discussion, #868).

Format `flux.project-export`, `formatVersion` 1 (the one current format). The TypeScript types (`ProjectExport`) and the
JSON Schema (`PROJECT_EXPORT_JSON_SCHEMA`) are in
[`app/packages/contracts/src/export.ts`](../../app/packages/contracts/src/export.ts) (Apache-2.0); the
application tests validate real exports against the schema. Timestamps are ISO 8601 UTC.
People and agents are referenced as `{ "kind": "human" | "agent", "id" }`; `actors` gives their
names.

| Key | Contents |
| --- | --- |
| `$schema`, `format`, `formatVersion`, `exportedAt` | Identification. |
| `provenance` | `exportedBy` (with name), `instanceOrigin` (`FLUX_PUBLIC_ORIGIN`), database `schemaVersion`, `reimportSupported: false`. |
| `excluded` | The list below, repeated in every export. |
| `project` | Id, name, visibility, creation time, workspace id and name. |
| `people` | Everyone who can read the project now, with `access` (`manager` or `contributor`) and `workspaceRole`, decided by the access policy. |
| `grants` | Explicit project grants (`manager` or `contributor`). |
| `actors` | Names of every person and agent referenced anywhere in the export. |
| `conversations` | Each conversation with all messages in sequence: author, text, cited material or doc version, time. A message made by a saved blocker, the "what came of it" line or a public handoff also has `contribution` (`{ "kind": "blocker" \| "handoff" \| "came_of_it" }`); ordinary messages omit it. A message its author posted through a local client or with Show everyone also has `via`, the client's or assistant's name ("Claude Code"); the author stays the person. |
| `files` (optional) | Published attachments: id, display name, size, SHA-256, message and conversation ids, order, and bundle path. Absent for projects without published files. Message `files` lists id, name and size in attachment order. |
| `materials` | Published materials with every immutable version: title, text, URL, author, time. |
| `docs` | Docs with every version: title, Markdown text, reason, author, time, and `file` (the Markdown file of the current text). |
| `sketches` | Project sketches with their thoughts (text, position, size, shape, author, version) and links between thoughts (label). |
| `work`, `decisions` | All fields: status, blocker, whether it was dropped and what came of it, owner, who proposed and who accepted, supersession. |
| `githubSources` (optional) | Only for projects with GitHub task rules: `dormant: true`, the project's default rule mode and `rules` (task id, mode, the state it had, `enabled: false`). Repository bindings are never exported here: a repository's name, URL and id are private GitHub facts that need the exporter's own current GitHub proof, which this export does not check. No installation or App ids, tokens, connecting person, deliveries or pull request data either. Nothing imports it yet (`reimportSupported: false`); a future import must create rules disabled and require a person to connect and authorize repositories on the destination. |
| `links` | Typed links (`source`, `affects`, `related`, `mentions`, `part_of`) whose two ends are both in the export. |

## What is never exported

- other projects of the workspace;
- direct messages;
- private sketches;
- images placed on map thoughts: the thought and its caption are exported, the image
  is not in the export; a full backup keeps it;
- accounts, e-mail addresses, sessions, push subscriptions and notifications;
- approved project policies for agents: a full backup keeps them, a project export does not;
- agent connections, OAuth clients, access and refresh tokens and signing keys (secrets of this
  instance), and pending agent proposals, which are not part of the export;
- events, idempotency records and other internal rows.

Links whose target the export leaves out are dropped, so an export never names an object it does not
contain. (Private drafts and the placement of a note on a sketch are not in the list above because
they no longer exist: they went with "Your notes", #947, #999.) `app/tests/app/export.test.ts`
checks this with distinctive text in another project, a DM, a private sketch, and another member's
extra notification address, quiet hours and mute, and also checks that
no e-mail address, client mutation id, agent connection id or other project
id appears.
`scripts/check_backup.sh` checks the same for `./flux export` on the demo data.

## Compatibility

The export is a public extension contract ([O-010 EXT-2](../product/extension-contracts.md#ext-2--project-export-format)),
and nothing is kept compatible before the first public release
([rule](../product/extension-contracts.md#no-compatibility-before-the-first-public-release)):
a change edits the one current format in place, with no version bump and no reading of an
older format. `formatVersion` names that current format. Readers should ignore unknown fields
and treat an unknown enum value as unknown. The JSON Schema rejects unknown top-level keys so
that a change to the format cannot go unnoticed in the tests, and
`app/tests/app/extension-contracts.test.ts` pins the schema and bundle layout to
`app/tests/app/contracts/project-export.json`. See [integrations](../integrations/README.md#ext-2-read-a-project-export).

Task creation Undo keeps every task in the export. Each task carries `lifecycle` (active, or creation
reverted with the notice, time and actor) and `creationHistory` (trusted origin, immutable baseline, first persisted
use, proposal identity, and the original and reversion notices with their actual actors). Active application lists
leave creation-reverted tasks out; direct reads and the export name them explicitly. Command receipts stay in full
backups, as before.
