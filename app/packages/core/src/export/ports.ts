import type {
  ExportActor,
  ProjectExport,
  ProjectExportConversation,
  ProjectExportAgentThread,
  ProjectExportDecision,
  ProjectExportDoc,
  ProjectExportGrant,
  ProjectExportFile,
  ProjectExportLink,
  ProjectExportMaterial,
  ProjectExportResult,
  ProjectExportSketch,
  ProjectExportWork,
  ProjectPerson,
  WorkspaceRole,
} from '@flux/contracts';
import type { Principal } from '../principal.js';

/**
 * Ports of the project export use case (issue #123). The server implements them with the access
 * policy (`evaluateProject` for `project.manage`, `listProjectPeople` for the audience) and the
 * `@flux/db` export rows; nothing in `packages/core/src/export` imports those adapters.
 */

/** Rows of one project, already in their wire shape. No access decisions are made here. */
export interface ProjectExportRows {
  files?(projectId: string): Promise<ProjectExportFile[]>;
  project(projectId: string): Promise<ProjectExport['project'] | null>;
  grants(projectId: string): Promise<ProjectExportGrant[]>;
  workspaceRoles(workspaceId: string): Promise<{ userId: string; role: WorkspaceRole }[]>;
  conversations(projectId: string): Promise<ProjectExportConversation[]>;
  agentThreads?(projectId: string): Promise<ProjectExportAgentThread[]>;
  /** Materials of kind `material` with every version, without the private source note. */
  materials(projectId: string): Promise<ProjectExportMaterial[]>;
  /** Docs with every version. */
  docs(projectId: string): Promise<Omit<ProjectExportDoc, 'file'>[]>;
  /** Sketches shared with the project (scope `project`) only, without placements. */
  sketches(projectId: string): Promise<ProjectExportSketch[]>;
  work(projectId: string): Promise<ProjectExportWork[]>;
  decisions(projectId: string): Promise<ProjectExportDecision[]>;
  results(projectId: string): Promise<ProjectExportResult[]>;
  links(projectId: string): Promise<ProjectExportLink[]>;
  /** Display names keyed by `<kind>:<id>`. */
  names(actors: ExportActor[]): Promise<Map<string, string>>;
}

/** Adapter over the core access policy. */
export interface ProjectExportAccess {
  /**
   * Throws NotFoundError when the project is invisible to the principal and ForbiddenError when it
   * is visible but the principal may not manage it (`project.manage`).
   */
  requireManage(principal: Principal, projectId: string): Promise<void>;
  /** Everyone who can read the project now, decided by the policy. */
  audience(principal: Principal, projectId: string): Promise<ProjectPerson[]>;
}

export interface ProjectExportPorts {
  files?: { read(id: string): Promise<Uint8Array | null> };
  access: ProjectExportAccess;
  rows: ProjectExportRows;
}

/** Runs the export in one read-only snapshot transaction, so every part shows one point in time. */
export interface ProjectExportUnitOfWork {
  run<T>(work: (ports: ProjectExportPorts) => Promise<T>): Promise<T>;
}

export interface ProjectExportContext {
  schemaVersion: number;
  /** FLUX_PUBLIC_ORIGIN of this instance, recorded as provenance. */
  instanceOrigin: string | null;
  now?: () => Date;
}
