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

The export is read in one read-only `REPEATABLE READ` transaction, so all its parts show the
same moment even while people keep working.

## Bundle

```
flux-project-<first 8 of project id>-<UTC time>/
  project.json                          the whole project (below)
  docs/<doc id>.md                      current Markdown text of each doc
  schema/project-export.v1.schema.json  JSON Schema (draft-07) of project.json
  README.md                             what is in it and what is not
  manifest.json                         path, bytes and SHA-256 of every other file
```

Any `tar` extracts it (`tar -xzf flux-project-….tar.gz`). The launcher prints the bundle's own
SHA-256. Uploaded files will join the bundle under `files/` when projects have file uploads;
today materials are text and links.

## `project.json`

Format `flux.project-export`, `formatVersion` 1. The TypeScript types (`ProjectExport`) and the
JSON Schema (`PROJECT_EXPORT_JSON_SCHEMA`) are in
[`packages/contracts/src/export.ts`](../../packages/contracts/src/export.ts) (Apache-2.0); the
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
| `conversations` | Each conversation with all messages in sequence: author, text, cited material or doc version, time. |
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
- accounts, e-mail addresses, sessions, push subscriptions and notifications;
- agent connections, OAuth clients, access and refresh tokens and signing keys (secrets of this
  instance), and pending agent proposals (#52), which are not part of format version 1;
- events, idempotency records and other internal rows.

Drafts shared with the project are also left out in format version 1: a shared note becomes
project content when it is published as a material. Links whose target the export leaves out
are dropped, so an export never names an object it does not contain. `tests/app/export.test.ts`
checks this with distinctive text in another project, a DM, a private note (published from, so
its id is referenced internally) and a private sketch that places the note, and also checks that
no e-mail address, private note id, client mutation id, agent connection id or other project
id appears.
`scripts/check_backup.sh` checks the same for `./flux export` on the demo data.

## Compatibility

A later format version may add fields; readers should ignore unknown ones. Removing or changing
the meaning of a field needs a new `formatVersion`. The JSON Schema rejects unknown top-level
keys so that a change to the format cannot go unnoticed in the tests.
