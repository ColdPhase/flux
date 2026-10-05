# Project export

A project export (issue #123) is an open, documented copy of one project that people can read,
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

`project.manage` belongs to workspace owners and admins, unless an explicit deny on the project
applies ([access policy](../development/access-policy.md#rules)). An invisible project answers
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

Format `flux.project-export`, `formatVersion` 1. The TypeScript types (`ProjectExport`) and the
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
| `people` | Everyone who can read the project now, with `access` (`manager`, `contributor`, `viewer`) and `workspaceRole`, decided by the access policy. |
| `grants` | Explicit project grants, including `denied`. |
| `actors` | Names of every person and agent referenced anywhere in the export. |
| `conversations` | Each conversation with all messages in sequence: author, text, cited material or doc version, time. A message made by a saved blocker, a published result or a public handoff (#154) also has `contribution` (`{ "kind": "blocker" \| "handoff" }` or `{ "kind": "result", "resultId" }`); ordinary messages omit it. |
| `files` (optional) | Published attachments: id, display name, size, SHA-256, message and conversation ids, order, and bundle path. Absent for projects without published files. Message `files` lists id, name and size in attachment order. |
| `materials` | Published materials with every immutable version: title, text, URL, author, time. |
| `docs` | Docs with every version: title, Markdown text, `draft`/`published`, reason, author, time, and `file` (the Markdown file of the current text). |
| `sketches` | Project sketches with their thoughts (text, position, size, shape, author, version) and links between thoughts (label). |
| `work`, `decisions`, `results` | All fields of #101: status, blocker, owner, parking, who proposed and who accepted, supersession, finding, evidence. |
| `links` | Typed links (`source`, `affects`, `still_applies`, `about`, `related`, `mentions`) whose two ends are both in the export. |

## What is never exported

- other projects of the workspace;
- direct messages;
- private notes (drafts), including the private note a material was published from: the
  material's text is exported, its source note and the note's id are not;
- private sketches, and the placement of a note on any sketch;
- images placed on map thoughts (#252): the thought and its caption are exported, the image
  is not in format version 1; a full backup keeps it;
- accounts, e-mail addresses, sessions, push subscriptions and notifications;
- approved project policies for agents (#160): a full backup keeps them, a project export does not;
- agent connections, OAuth clients, access and refresh tokens and signing keys (secrets of this
  instance), and pending agent proposals (#52), which are not part of format version 1;
- events, idempotency records and other internal rows.

Drafts shared with the project are also left out in format version 1: a shared note becomes
project content when it is published as a material. Links whose target the export leaves out
are dropped, so an export never names an object it does not contain. `app/tests/app/export.test.ts`
checks this with distinctive text in another project, a DM, a private note (published from, so
its id is referenced internally), a private sketch that places the note, and another member's
extra notification address, quiet hours and mute, and also checks that
no e-mail address, private note id, client mutation id, agent connection id or other project
id appears.
`scripts/check_backup.sh` checks the same for `./flux export` on the demo data.

## Compatibility

Format 1 is a public extension contract of v0.1 ([O-010 EXT-2](../product/extension-contracts.md#ext-2--project-export-format-1)).
Within one `formatVersion`, a release may add fields (even required ones) and enum values; readers
ignore unknown fields and treat an unknown enum value as unknown. Removing, renaming or making a
field optional, changing its type or meaning, removing an enum value, removing or renaming a bundle
file, or changing the manifest identification needs a new `formatVersion`. The JSON Schema rejects unknown top-level
keys so that a change to the format cannot go unnoticed in the tests, and
`app/tests/app/extension-contracts.test.ts` pins the schema and bundle layout to
`app/tests/app/contracts/project-export.v1.json`. See [integrations](../integrations/README.md#ext-2-read-a-project-export).
