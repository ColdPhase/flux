import type { MessageFile } from './files.js';
import type { ProjectAccess, ProjectGrantRole, ProjectVisibility, WorkspaceRole } from './access.js';
import type { MessageContribution } from './conversation.js';
import type { DocState } from './docs.js';
import type { DecisionStatus, LinkOwnerType, LinkRole, ObjectRef, ResultFinding, WorkStatus } from './work.js';

/**
 * Project export (issue #123, foundation 8.16). An open JSON document of one project, plus a
 * `.tar.gz` bundle with that document, the current text of every doc as a Markdown file, the JSON
 * Schema below and a manifest with SHA-256 checksums. Documented in docs/operations/export.md.
 *
 * It holds exactly what the project's own audience can read in the project: its conversations,
 * materials and docs with every version, project sketches with thoughts and links, work,
 * decisions and results with their typed links, members and roles, and who made what. It never
 * holds other projects, direct messages, private notes (drafts), private sketches, sessions,
 * push subscriptions, notifications, agent connections, OAuth tokens, agent proposals or events. Re-import is not part of format version 1.
 */
export const projectExportPath = (projectId: string) => `/api/v1/projects/${projectId}/export`;
/** `GET projectExportPath(id)?format=bundle` answers the `application/gzip` bundle. */
export const PROJECT_EXPORT_BUNDLE_QUERY = 'format=bundle';
export const PROJECT_EXPORT_FORMAT = 'flux.project-export';
export const PROJECT_EXPORT_FORMAT_VERSION = 1;
export const PROJECT_EXPORT_SCHEMA_ID = 'https://flux.coldphase.dev/schemas/project-export.v1.json';

/** What format version 1 deliberately leaves out; repeated in every export. */
export const PROJECT_EXPORT_EXCLUDED = [
  'other projects',
  'direct messages',
  'private notes (drafts), including the private source of a published material',
  'private sketches and placements of notes on a sketch',
  'images placed on map thoughts (the thoughts and captions are exported; full backups keep the images)',
  'accounts, e-mail addresses, sessions, push subscriptions and notifications',
  'agent connections, OAuth clients and tokens, and pending agent proposals',
  'approved project policies for agents (kept in full backups)',
  'events, idempotency records and other internal rows',
] as const;

export interface ExportActor {
  kind: 'human' | 'agent';
  id: string;
}

export interface ExportNamedActor extends ExportActor {
  name: string;
}

export interface ProjectExportPerson extends ExportNamedActor {
  /** Current access to the project. */
  access: ProjectAccess;
  /** Workspace role of a person; null for an agent. */
  workspaceRole: WorkspaceRole | null;
}

export interface ProjectExportGrant {
  principal: ExportActor;
  role: ProjectGrantRole;
  createdAt: string;
}

export interface ProjectExportMessage {
  files?: MessageFile[];
  id: string;
  sequence: number;
  author: ExportActor;
  body: string;
  /** The cited material or doc version, if any. */
  source: { materialId: string; version: number } | null;
  /** Present only for a saved blocker, a published result (naming that exported result) or a public handoff (#154). */
  contribution?: MessageContribution;
  createdAt: string;
}

export interface ProjectExportConversation {
  id: string;
  createdBy: ExportActor;
  createdAt: string;
  messages: ProjectExportMessage[];
}

export interface ProjectExportMaterialVersion {
  version: number;
  title: string;
  body: string;
  url: string | null;
  author: ExportActor;
  createdAt: string;
}

export interface ProjectExportMaterial {
  id: string;
  createdBy: ExportActor;
  createdAt: string;
  currentVersion: number;
  /** Oldest first. */
  versions: ProjectExportMaterialVersion[];
}

export interface ProjectExportDocVersion {
  version: number;
  title: string;
  body: string;
  state: DocState;
  reason: string;
  author: ExportActor;
  createdAt: string;
}

export interface ProjectExportDoc {
  id: string;
  createdBy: ExportActor;
  createdAt: string;
  currentVersion: number;
  /** Bundle path of the current text as Markdown. */
  file: string;
  /** Oldest first. */
  versions: ProjectExportDocVersion[];
}

export interface ProjectExportThought {
  id: string;
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
  shape: 'card' | 'pill' | 'circle';
  createdBy: ExportActor;
  version: number;
  createdAt: string;
}

export interface ProjectExportSketch {
  id: string;
  title: string;
  createdBy: ExportActor;
  version: number;
  createdAt: string;
  updatedAt: string;
  thoughts: ProjectExportThought[];
  links: { id: string; fromId: string; toId: string; label: string | null; createdAt: string }[];
}

export interface ProjectExportWork {
  lifecycle: { state: 'active' } | { state: 'creation_reverted'; noticeId: string; revertedAt: string; revertedBy: ExportActor };
  creationHistory: {
    origin: 'native_agent' | 'ai_proposal' | 'human' | null;
    baselineVersion: number | null; baseline: unknown | null; proposalId: string | null; firstPersistedUseAt: string | null;
    notices: { id: string; kind: 'task.created' | 'task.creation_reverted'; createdBy: ExportActor; sources: ObjectRef[]; createdAt: string }[];
  };
  id: string;
  title: string;
  outcome: string;
  status: WorkStatus;
  blocker: string | null;
  owner: ExportActor | null;
  parked: { decisionId: string; at: string } | null;
  createdBy: ExportActor;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectExportDecision {
  id: string;
  title: string;
  rationale: string;
  status: DecisionStatus;
  proposedBy: ExportActor;
  decidedBy: ExportActor | null;
  decidedAt: string | null;
  supersedesId: string | null;
  supersededById: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectExportResult {
  id: string;
  title: string;
  finding: ResultFinding;
  evidence: string;
  createdBy: ExportActor;
  createdAt: string;
}

export interface ProjectExportLink {
  id: string;
  role: LinkRole;
  from: { type: LinkOwnerType; id: string };
  to: ObjectRef;
  createdBy: ExportActor;
  createdAt: string;
}

export interface ProjectExportFile extends MessageFile {
  messageId: string;
  conversationId: string;
  position: number;
  sha256: string;
  path: string;
}

export interface ProjectExport {
  /** Published attachments only. Exact bytes are in the bundle paths. Absent in legacy file-free exports. */
  files?: ProjectExportFile[];
  $schema: typeof PROJECT_EXPORT_SCHEMA_ID;
  format: typeof PROJECT_EXPORT_FORMAT;
  formatVersion: typeof PROJECT_EXPORT_FORMAT_VERSION;
  exportedAt: string;
  provenance: {
    exportedBy: ExportNamedActor;
    /** FLUX_PUBLIC_ORIGIN of the exporting instance. */
    instanceOrigin: string | null;
    schemaVersion: number;
    /** Always false in format version 1: there is no import yet. */
    reimportSupported: false;
  };
  excluded: string[];
  project: { id: string; name: string; visibility: ProjectVisibility; createdAt: string; workspace: { id: string; name: string } };
  /** Everyone who can read the project now, with their access. */
  people: ProjectExportPerson[];
  /** Explicit project grants, including denials. */
  grants: ProjectExportGrant[];
  /** Display names of every person or agent referenced anywhere in this export. */
  actors: ExportNamedActor[];
  conversations: ProjectExportConversation[];
  materials: ProjectExportMaterial[];
  docs: ProjectExportDoc[];
  sketches: ProjectExportSketch[];
  work: ProjectExportWork[];
  decisions: ProjectExportDecision[];
  results: ProjectExportResult[];
  /** Typed links between exported objects. */
  links: ProjectExportLink[];
}

/** One file of the bundle as listed in its `manifest.json`. */
export interface ProjectExportManifestFile {
  path: string;
  bytes: number;
  sha256: string;
}

export interface ProjectExportManifest {
  format: 'flux.project-export-bundle';
  formatVersion: 1;
  projectId: string;
  exportedAt: string;
  files: ProjectExportManifestFile[];
}

// JSON Schema (draft-07) of `project.json`. Hand-written to match the types above; the
// application test suite validates real exports against it.
const id = { type: 'string', minLength: 1 } as const;
const time = { type: 'string', format: 'date-time' } as const;
const text = { type: 'string' } as const;
const count = { type: 'integer', minimum: 1 } as const;
const nullable = <T extends object>(schema: T) => ({ anyOf: [schema, { type: 'null' }] }) as const;
const object = <P extends Record<string, unknown>>(properties: P) =>
  ({ type: 'object', additionalProperties: false, required: Object.keys(properties), properties }) as const;
const list = <T extends object>(items: T) => ({ type: 'array', items }) as const;
const ref = (name: string) => ({ $ref: `#/definitions/${name}` }) as const;

const actor = object({ kind: { enum: ['human', 'agent'] }, id });
const namedActor = object({ kind: { enum: ['human', 'agent'] }, id, name: text });
const objectRef = {
  oneOf: [
    object({ type: { enum: ['message', 'thought', 'doc', 'sketch', 'work', 'decision', 'result'] }, id }),
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
        contribution: { oneOf: [object({ kind: { enum: ['blocker', 'handoff'] } }), object({ kind: { const: 'result' }, resultId: id })] } },
    },
    conversation: object({ id, createdBy: ref('actor'), createdAt: time, messages: list(ref('message')) }),
    materialVersion: object({ version: count, title: text, body: text, url: nullable(text), author: ref('actor'), createdAt: time }),
    material: object({ id, createdBy: ref('actor'), createdAt: time, currentVersion: count, versions: { ...list(ref('materialVersion')), minItems: 1 } }),
    docVersion: object({ version: count, title: text, body: text, state: { enum: ['draft', 'published'] }, reason: text, author: ref('actor'), createdAt: time }),
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
      id, title: text, outcome: text, status: { enum: ['open', 'in_progress', 'blocked', 'done', 'not_pursued'] }, blocker: nullable(text),
      owner: nullable(ref('actor')), parked: nullable(object({ decisionId: id, at: time })), createdBy: ref('actor'), version: count, createdAt: time, updatedAt: time,
    }),
    decision: object({
      id, title: text, rationale: text, status: { enum: ['proposed', 'accepted', 'superseded'] }, proposedBy: ref('actor'), decidedBy: nullable(ref('actor')),
      decidedAt: nullable(time), supersedesId: nullable(id), supersededById: nullable(id), version: count, createdAt: time, updatedAt: time,
    }),
    result: object({ id, title: text, finding: { enum: ['positive', 'negative'] }, evidence: text, createdBy: ref('actor'), createdAt: time }),
    link: object({
      id, role: { enum: ['source', 'affects', 'still_applies', 'about', 'related', 'mentions'] },
      from: object({ type: { enum: ['work', 'decision', 'result', 'doc'] }, id }), to: ref('objectRef'), createdBy: ref('actor'), createdAt: time,
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
      kind: { enum: ['human', 'agent'] }, id, name: text, access: { enum: ['manager', 'contributor', 'viewer'] },
      workspaceRole: nullable({ enum: ['owner', 'admin', 'member', 'guest'] }),
    })),
    grants: list(object({ principal: ref('actor'), role: { enum: ['contributor', 'viewer', 'denied'] }, createdAt: time })),
    actors: list(ref('namedActor')),
    conversations: list(ref('conversation')),
    materials: list(ref('material')),
    docs: list(ref('doc')),
    sketches: list(ref('sketch')),
    work: list(ref('work')),
    decisions: list(ref('decision')),
    results: list(ref('result')),
    links: list(ref('link')),
  }),
} as const;

export const PROJECT_EXPORT_JSON_SCHEMA = { ...baseExportSchema,
  properties: { ...baseExportSchema.properties, files: list(exportFileSchema) },
} as const;
