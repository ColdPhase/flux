import { randomUUID } from 'node:crypto';
import type { CreateDraftCommand, Draft, DraftListQuery, DraftVisibility, MoveDraftCommand, Page, ProjectVisibility, ShareDraftCommand, UpdateDraftCommand } from '@flux/contracts';
import { recordEvent } from '../events.js';
import type { Database, Executor, Principal } from '../types.js';
import { eventPorts } from './common.js';
import { ForbiddenError, InvalidInputError, NotFoundError, PreconditionRequiredError, RuleViolationError, VersionConflictError } from './errors.js';
import { enforce, evaluateDraft, evaluateProject, evaluateWorkspace, isUuid, type Actor } from './policy.js';
import type { AccessPorts } from './repositories.js';
import type { DraftRecord } from './records.js';
import { body, DRAFT_VISIBILITIES, name, oneOf, parsePage } from './validation.js';

// Drafts (issues #46, #91). Update, share and move require the caller's expected version (If-Match); it is checked
// after authorization, with the draft row locked `FOR UPDATE` by the access reader, and before any write.

type DraftPorts = Pick<AccessPorts, 'drafts' | 'projects' | 'access' | 'events'>;

export function toDraft(row: DraftRecord): Draft {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    projectId: row.projectId,
    owner: row.ownerUserId ? { kind: 'human', id: row.ownerUserId } : { kind: 'agent', id: row.ownerAgentId! },
    title: row.title,
    body: row.body,
    visibility: row.visibility,
    version: row.version,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * Enforces the caller's expected version on a draft that is already authorized and locked.
 * Authorization comes first so a missing or stale precondition never reveals an object.
 */
function requireVersion(draft: DraftRecord, expected: unknown) {
  if (expected === undefined || expected === null) throw new PreconditionRequiredError();
  if (typeof expected !== 'number' || !Number.isInteger(expected) || expected < 1) throw new InvalidInputError('expectedVersion must be a positive integer');
  if (draft.version !== expected) throw new VersionConflictError(draft.version, toDraft(draft));
}

/**
 * Resolves a target project for a draft in `workspaceId`: it must be in the same
 * workspace and writable by the principal. A project the caller can see in another
 * workspace is a rule violation; an invisible one is reported as not found.
 */
async function requireTargetProject(principal: Principal, workspaceId: string, projectId: unknown, tx: Executor, ports: Pick<AccessPorts, 'access'>) {
  if (!isUuid(projectId)) throw new NotFoundError('Project', 'PROJECT_NOT_FOUND');
  const evaluation = await evaluateProject(principal, 'project.write', projectId, ports.access(tx), { lock: true });
  if (!evaluation.visible) throw new NotFoundError('Project', 'PROJECT_NOT_FOUND');
  if (evaluation.project!.workspaceId !== workspaceId) throw new RuleViolationError('A draft can only link to a project in its own workspace', 'CROSS_WORKSPACE');
  if (!evaluation.allowed) throw new ForbiddenError('Contributor access to the target project is required', 'PROJECT_WRITE_REQUIRED');
  return evaluation.project!;
}

/**
 * Checks the audience a draft is about to get. Workspace-wide sharing is for people
 * who are owners, admins or members, and only outside restricted projects so a
 * workspace-visible draft never reveals a restricted project.
 */
function requireAudience(actor: Actor, visibility: DraftVisibility, project: { visibility: ProjectVisibility } | null) {
  if (visibility === 'project' && !project) throw new InvalidInputError('projectId is required for project visibility');
  if (visibility === 'workspace') {
    if (actor.principal.kind !== 'human' || actor.role === 'guest') throw new ForbiddenError('Only workspace members can share with the whole workspace', 'WORKSPACE_SHARE_FORBIDDEN');
    if (project?.visibility === 'restricted') throw new RuleViolationError('A draft in a restricted project cannot be shared with the whole workspace', 'RESTRICTED_PROJECT');
  }
}

async function projectOf(tx: Executor, ports: Pick<AccessPorts, 'projects'>, projectId: string | null) {
  return projectId ? ports.projects(tx).get(projectId) : null;
}

/**
 * Creates a draft that is private to its author inside a writable project. People may
 * omit the project; an agent must name a project where it currently is a contributor.
 */
export async function createDraft(principal: Principal, workspaceId: string, command: CreateDraftCommand, db: Database, ports: DraftPorts): Promise<Draft> {
  const title = name(command?.title, 'Title');
  const text = body(command.body);
  return db.transaction(async (tx) => {
    enforce(await evaluateWorkspace(principal, 'draft.create', workspaceId, ports.access(tx), { lock: true }), 'workspace');
    if (principal.kind === 'agent' && (command.projectId === undefined || command.projectId === null)) {
      throw new RuleViolationError('An agent can only create drafts inside a project it contributes to', 'PROJECT_REQUIRED');
    }
    const projectId = command.projectId === undefined || command.projectId === null ? null
      : (await requireTargetProject(principal, workspaceId, command.projectId, tx, ports)).id;
    const id = randomUUID();
    const row = await ports.drafts(tx).insert({
      id, workspaceId, projectId, title, body: text, createdBy: principal.id,
      ownerUserId: principal.kind === 'human' ? principal.id : null,
      ownerAgentId: principal.kind === 'agent' ? principal.id : null,
    });
    await recordEvent(eventPorts(ports, tx), principal, workspaceId, 'draft.created.v1', id, { projectId, visibility: 'private' });
    return toDraft(row);
  });
}

export async function getDraft(principal: Principal, draftId: string, db: Database, ports: Pick<DraftPorts, 'access'>): Promise<Draft> {
  const { draft } = enforce(await evaluateDraft(principal, 'draft.read', draftId, ports.access(db)), 'draft');
  return toDraft(draft!);
}

/** Drafts the principal can read, filtered before count and pagination. */
export async function listDrafts(principal: Principal, workspaceId: string, query: DraftListQuery, db: Database, ports: Pick<DraftPorts, 'drafts' | 'access'>): Promise<Page<Draft>> {
  const page = parsePage(query);
  const { actor } = enforce(await evaluateWorkspace(principal, 'workspace.read', workspaceId, ports.access(db)), 'workspace');
  if (query.projectId !== undefined && !isUuid(query.projectId)) throw new InvalidInputError('projectId must be a UUID');
  const { total, rows } = await ports.drafts(db).listVisible(actor, query.projectId, page);
  return { items: rows.map(toDraft), total, ...page };
}

export async function updateDraft(principal: Principal, draftId: string, command: UpdateDraftCommand, db: Database, ports: DraftPorts): Promise<Draft> {
  const changes: { title?: string; body?: string } = {};
  if (command?.title !== undefined) changes.title = name(command.title, 'Title');
  if (command?.body !== undefined) changes.body = body(command.body);
  if (!Object.keys(changes).length) throw new InvalidInputError('Nothing to update');
  return db.transaction(async (tx) => {
    const { draft } = enforce(await evaluateDraft(principal, 'draft.write', draftId, ports.access(tx), { lock: true }), 'draft');
    requireVersion(draft!, command.expectedVersion);
    const row = await ports.drafts(tx).updateText(draftId, changes);
    await recordEvent(eventPorts(ports, tx), principal, draft!.workspaceId, 'draft.updated.v1', draftId, { version: row.version });
    return toDraft(row);
  });
}

/**
 * Changes a draft's audience: `project` (its own or a named project in the same
 * workspace), `workspace`, or back to `private`.
 */
export async function shareDraft(principal: Principal, draftId: string, command: ShareDraftCommand, db: Database, ports: DraftPorts): Promise<Draft> {
  const scope = oneOf(command?.scope, DRAFT_VISIBILITIES, 'scope');
  return db.transaction(async (tx) => {
    const { actor, draft } = enforce(await evaluateDraft(principal, 'draft.share', draftId, ports.access(tx), { lock: true }), 'draft');
    requireVersion(draft!, command.expectedVersion);
    let projectId = draft!.projectId;
    if (command.projectId !== undefined && command.projectId !== draft!.projectId) {
      if (scope !== 'project') throw new InvalidInputError('projectId applies only to project scope; use move to change the project');
      projectId = (await requireTargetProject(principal, draft!.workspaceId, command.projectId, tx, ports)).id;
    } else if (scope === 'project' && projectId) {
      await requireTargetProject(principal, draft!.workspaceId, projectId, tx, ports);
    }
    requireAudience(actor!, scope, await projectOf(tx, ports, projectId));
    const row = await ports.drafts(tx).setAudience(draftId, { projectId, visibility: scope });
    await recordEvent(eventPorts(ports, tx), principal, draft!.workspaceId, 'draft.shared.v1', draftId, { from: draft!.visibility, visibility: scope, projectId });
    return toDraft(row);
  });
}

/**
 * Moves a draft to another project of the same workspace (or out of any project). The
 * caller states the resulting visibility, so a move never silently widens the audience.
 * Moving to another workspace is rejected; that needs a later copy command.
 */
export async function moveDraft(principal: Principal, draftId: string, command: MoveDraftCommand, db: Database, ports: DraftPorts): Promise<Draft> {
  const visibility = oneOf(command?.visibility, DRAFT_VISIBILITIES, 'visibility');
  if (command.projectId !== null && typeof command.projectId !== 'string') throw new InvalidInputError('projectId must be a project id or null');
  return db.transaction(async (tx) => {
    const { actor, draft } = enforce(await evaluateDraft(principal, 'draft.move', draftId, ports.access(tx), { lock: true }), 'draft');
    requireVersion(draft!, command.expectedVersion);
    if (principal.kind === 'agent' && command.projectId === null) {
      throw new RuleViolationError('An agent cannot move a draft outside every project', 'PROJECT_REQUIRED');
    }
    const target = command.projectId === null ? null : await requireTargetProject(principal, draft!.workspaceId, command.projectId, tx, ports);
    requireAudience(actor!, visibility, target);
    const row = await ports.drafts(tx).setAudience(draftId, { projectId: target?.id ?? null, visibility });
    await recordEvent(eventPorts(ports, tx), principal, draft!.workspaceId, 'draft.moved.v1', draftId, { from: draft!.projectId, projectId: target?.id ?? null, visibility });
    return toDraft(row);
  });
}
