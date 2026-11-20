import { PROJECT_EXPORT_FORMAT, PROJECT_EXPORT_FORMAT_VERSION, PROJECT_EXPORT_SCHEMA_ID } from './export.js';

// JSON Schema (draft-07) of `project.json`, kept apart from the export's types and paths so the web app, which only reads the paths,
// does not carry it. Hand-written to match the types in export.ts; the application test suite validates real exports against it.
const id = { type: 'string', minLength: 1 } as const;
const time = { type: 'string', format: 'date-time' } as const;
const text = { type: 'string' } as const;
const count = { type: 'integer', minimum: 1 } as const;
const nullable = /* @__NO_SIDE_EFFECTS__ */ <T extends object>(schema: T) => ({ anyOf: [schema, { type: 'null' }] }) as const;
const object = /* @__NO_SIDE_EFFECTS__ */ <P extends Record<string, unknown>>(properties: P) =>
  ({ type: 'object', additionalProperties: false, required: Object.keys(properties), properties }) as const;
const list = /* @__NO_SIDE_EFFECTS__ */ <T extends object>(items: T) => ({ type: 'array', items }) as const;
const ref = /* @__NO_SIDE_EFFECTS__ */ (name: string) => ({ $ref: `#/definitions/${name}` }) as const;

const actor = object({ kind: { enum: ['human', 'agent'] }, id });
const namedActor = object({ kind: { enum: ['human', 'agent'] }, id, name: text });
const objectRef = {
  oneOf: [
    object({ type: { enum: ['message', 'thought', 'doc', 'sketch', 'work', 'decision'] }, id }),
    object({ type: { const: 'material' }, id, version: count }),
  ],
} as const;

const exportFileSchema = object({ id, name: text, size: { type: 'integer', minimum: 1 }, messageId: id, conversationId: id,
  position: { type: 'integer', minimum: 0, maximum: 9 }, sha256: { type: 'string', pattern: '^[0-9a-f]{64}$' }, path: { type: 'string', pattern: '^files/[0-9a-f-]+$' } });

const baseExportSchema = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  $id: PROJECT_EXPORT_SCHEMA_ID,
  title: 'Flux project export, format version 1',
  definitions: {
    actor,
    namedActor,
    objectRef,
    message: {
      ...object({ id, sequence: count, author: ref('actor'), body: text, source: nullable(object({ materialId: id, version: count })), createdAt: time }),
      required: ['id', 'sequence', 'author', 'body', 'source', 'createdAt'],
      properties: { id, sequence: count, author: ref('actor'), body: text, source: nullable(object({ materialId: id, version: count })), createdAt: time,
        files: list(object({ id, name: text, size: { type: 'integer', minimum: 1 } })),
        via: text,
        contribution: object({ kind: { enum: ['blocker', 'handoff', 'came_of_it'] } }) },
    },
    conversation: object({ id, createdBy: ref('actor'), createdAt: time, messages: list(ref('message')) }),
    docVersion: object({ version: count, title: text, body: text, url: nullable(text), reason: text, author: ref('actor'), createdAt: time }),
    doc: object({ id, createdBy: ref('actor'), createdAt: time, currentVersion: count, file: { type: 'string', pattern: '^docs/[^/]+\\.md$' }, versions: { ...list(ref('docVersion')), minItems: 1 } }),
    thought: object({
      id, text, x: { type: 'integer' }, y: { type: 'integer' }, width: { type: 'integer' }, height: { type: 'integer' },
      shape: { enum: ['card', 'pill', 'circle'] }, createdBy: ref('actor'), version: count, createdAt: time,
    }),
    sketch: object({
      id, title: text, createdBy: ref('actor'), version: count, createdAt: time, updatedAt: time,
      thoughts: list(ref('thought')),
      links: list(object({ id, fromId: id, toId: id, label: nullable(text), createdAt: time })),
    }),
    work: object({
      lifecycle: { oneOf: [object({ state: { const: 'active' } }), object({ state: { const: 'creation_reverted' }, noticeId: id, revertedAt: time, revertedBy: ref('actor') })] },
      creationHistory: object({ origin: nullable({ enum: ['native_agent', 'ai_proposal', 'human'] }), baselineVersion: nullable(count), baseline: {}, proposalId: nullable(id), firstPersistedUseAt: nullable(time),
        notices: list(object({ id, kind: { enum: ['task.created', 'task.creation_reverted'] }, createdBy: ref('actor'), sources: list(ref('objectRef')), createdAt: time })) }),
      id, number: count, title: text, outcome: text, status: { enum: ['open', 'in_progress', 'blocked', 'done'] }, blocker: nullable(text), dropped: { type: 'boolean' }, cameOfIt: nullable(text),
      owner: nullable(ref('actor')), createdBy: ref('actor'), version: count, createdAt: time, updatedAt: time,
    }),
    decision: object({
      id, title: text, rationale: text, status: { enum: ['proposed', 'accepted', 'superseded'] }, proposedBy: ref('actor'), decidedBy: nullable(ref('actor')),
      decidedAt: nullable(time), supersedesId: nullable(id), supersededById: nullable(id), version: count, createdAt: time, updatedAt: time,
    }),
    link: object({
      id, role: { enum: ['source', 'affects', 'related', 'mentions', 'part_of'] },
      from: object({ type: { enum: ['work', 'decision', 'doc'] }, id }), to: ref('objectRef'), createdBy: ref('actor'), createdAt: time,
    }),
  },
  ...object({
    $schema: { const: PROJECT_EXPORT_SCHEMA_ID },
    format: { const: PROJECT_EXPORT_FORMAT },
    formatVersion: { const: PROJECT_EXPORT_FORMAT_VERSION },
    exportedAt: time,
    provenance: object({ exportedBy: ref('namedActor'), instanceOrigin: nullable(text), schemaVersion: count, reimportSupported: { const: false } }),
    excluded: list(text),
    project: object({ id, name: text, visibility: { enum: ['workspace', 'restricted'] }, createdAt: time, workspace: object({ id, name: text }) }),
    people: list(object({
      kind: { enum: ['human', 'agent'] }, id, name: text, access: { enum: ['manager', 'contributor'] },
      workspaceRole: nullable({ enum: ['owner', 'admin', 'member', 'guest'] }),
    })),
    grants: list(object({ principal: ref('actor'), role: { enum: ['manager', 'contributor'] }, createdAt: time })),
    actors: list(ref('namedActor')),
    conversations: list(ref('conversation')),
    docs: list(ref('doc')),
    sketches: list(ref('sketch')),
    work: list(ref('work')),
    decisions: list(ref('decision')),
    links: list(ref('link')),
  }),
} as const;

const modeSchema = { enum: ['complete', 'ready'] } as const;
const githubSourcesSchema = object({
  dormant: { const: true }, defaultMode: nullable(modeSchema),
  rules: list(object({ taskId: id, mode: modeSchema, recordedState: { enum: ['active', 'suspended', 'off'] }, enabled: { const: false } })),
});

export const PROJECT_EXPORT_JSON_SCHEMA = { ...baseExportSchema,
  properties: { ...baseExportSchema.properties, files: list(exportFileSchema), githubSources: githubSourcesSchema },
} as const;
