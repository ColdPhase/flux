import type { MessageFile } from './files.js';
import type { ProjectAccess, ProjectGrantRole, ProjectVisibility, WorkspaceRole } from './access.js';
import type { MessageContribution } from './conversation.js';
import type { DecisionStatus, LinkOwnerType, LinkRole, ObjectRef, WorkStatus } from './work.js';

/**
 * Project export (issue #123, foundation 8.16). An open JSON document of one project, plus a
 * `.tar.gz` bundle with that document, the current text of every doc as a Markdown file, the JSON
 * Schema below and a manifest with SHA-256 checksums. Documented in docs/operations/export.md.
 *
 * It holds exactly what the project's own audience can read in the project: its conversations,
 * Wiki pages (docs, every former saved source among them) with every version, project sketches with thoughts and links, work,
 * decisions with their typed links, members and roles, and who made what. It never
 * holds other projects, direct messages, private sketches, sessions,
 * push subscriptions, notifications, agent connections, OAuth tokens, agent proposals or events. Re-import is not part of the format.
 */
export const projectExportPath = (projectId: string) => `/api/v1/projects/${projectId}/export`;
/** `GET projectExportPath(id)?format=bundle` answers the `application/gzip` bundle. */
export const PROJECT_EXPORT_BUNDLE_QUERY = 'format=bundle';
export const PROJECT_EXPORT_FORMAT = 'flux.project-export';
export const PROJECT_EXPORT_FORMAT_VERSION = 1;
export const PROJECT_EXPORT_SCHEMA_ID = 'https://flux.coldphase.dev/schemas/project-export.v1.json';

/** What the format deliberately leaves out; repeated in every export. */
export const PROJECT_EXPORT_EXCLUDED = [
  'other projects',
  'direct messages',
  'private sketches',
  'images placed on map thoughts (the thoughts and captions are exported; full backups keep the images)',
  'accounts, e-mail addresses, sessions, push subscriptions and notifications',
  'agent connections, OAuth clients and tokens, and pending agent proposals',
  'approved project policies for agents (kept in full backups)',
  'GitHub installations, authorizations, tokens, webhook deliveries, pull request snapshots and who connected a repository (task rules are exported dormant; repository bindings are never exported here)',
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
  /** Present only when the author posted through a local client or an assistant (LC-2, #842): its name, shown as "Ada · via Claude Code". */
  via?: string;
  /** The cited version of a Wiki page, if any. */
  source: { materialId: string; version: number } | null;
  /** Present only for a saved blocker, a "what came of it" line or a public handoff (#154). */
  contribution?: MessageContribution;
  createdAt: string;
}

export interface ProjectExportConversation {
  id: string;
  createdBy: ExportActor;
  createdAt: string;
  messages: ProjectExportMessage[];
}

export interface ProjectExportDocVersion {
  version: number;
  title: string;
  body: string;
  /** The link of a page that was a saved source (#1508); null for any other page. */
  url: string | null;
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
  /** The task's number in its project, "#12" (#276); never reused or changed. */
  number: number;
  title: string;
  outcome: string;
  status: WorkStatus;
  blocker: string | null;
  owner: ExportActor | null;
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

/** A task's "let linked PRs move this task" rule, exported dormant (#74). */
export interface ProjectExportGithubRule {
  taskId: string;
  mode: 'complete' | 'ready';
  recordedState: 'active' | 'suspended' | 'off';
  enabled: false;
}

/**
 * Task rules and the default mode (#74), present only when the project has any. Dormant and
 * disabled. Repository bindings are deliberately absent: their names, URLs and ids are private
 * GitHub facts that need the exporter's own current GitHub proof, which this ordinary export does
 * not perform. A destination must connect and authorize repositories itself.
 */
export interface ProjectExportGithubSources {
  dormant: true;
  /** The project's default rule mode on the exporting instance, if one was set. */
  defaultMode: 'complete' | 'ready' | null;
  rules: ProjectExportGithubRule[];
}

export interface ProjectExport {
  /** GitHub task rules, dormant. Absent when the project has none; never holds repositories. */
  githubSources?: ProjectExportGithubSources;
  /** Published attachments only. Exact bytes are in the bundle paths. Absent when the project has none. */
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
    /** Always false: there is no import yet. */
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
  docs: ProjectExportDoc[];
  sketches: ProjectExportSketch[];
  work: ProjectExportWork[];
  decisions: ProjectExportDecision[];
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
