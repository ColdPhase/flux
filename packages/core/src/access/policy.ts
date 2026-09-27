import { and, eq, or, sql, type SQL, type SQLWrapper } from 'drizzle-orm';
import { schema } from '@flux/db';
import type { ProjectAccess, WorkspaceRole } from '@flux/contracts';
import type { Executor, Principal } from '../types.js';
import { ForbiddenError, NotFoundError } from './errors.js';

/**
 * # Flux access policy
 *
 * This module is the single authorization choke point. Every entry point that reads or
 * changes workspace data — the HTTP API, WebSocket subscriptions and replay, worker jobs,
 * and the future file, search, MCP and extension surfaces — MUST decide access through
 * {@link authorize} / {@link assertAuthorized} for one object and through
 * {@link visibleFilter} for lists. Nothing may query collaborative tables for a caller
 * without one of them. See `docs/development/access-policy.md`.
 *
 * Rules, evaluated from current rows on every call (there is no cache, so removing a
 * membership, grant or agent applies to the very next call):
 *
 * - A principal acts inside one workspace. People act through their membership role
 *   (`owner`, `admin`, `member`, `guest`); an agent acts only through its own project
 *   grants and only while it is not revoked. A person-owned agent is also capped by its
 *   owner's current access and stops working when the owner leaves the workspace.
 * - Project access levels: none < viewer < contributor < manager.
 *   - An explicit `denied` grant gives none. **Explicit deny wins** over every role,
 *     grant, visibility and ownership rule for that project and its drafts.
 *   - Workspace owners and admins are managers of every project.
 *   - Otherwise an explicit `contributor` or `viewer` grant applies (a viewer grant also
 *     narrows a member's implicit access).
 *   - Otherwise a `member` is a contributor on `workspace`-visible projects. Guests and
 *     agents see only projects they were explicitly granted; nobody without a grant or
 *     manager role sees a `restricted` project.
 * - Drafts are private to their author by default. Workspace membership alone never
 *   reveals a private draft. A `project` draft is readable at project level viewer and
 *   writable at contributor. A `workspace` draft is readable by owners, admins and
 *   members (not guests or agents) and writable by its author, owners and admins.
 *   Sharing and moving need the author or, for a non-private draft, an owner/admin.
 * - Callers that cannot see an object get {@link NotFoundError} (404) so its existence
 *   does not leak; visible objects with a forbidden action get {@link ForbiddenError} (403).
 */

export const WORKSPACE_ACTIONS = ['workspace.read', 'workspace.read_members', 'workspace.manage_members', 'workspace.manage_agents', 'project.create', 'draft.create', 'agent.create'] as const;
export const PROJECT_ACTIONS = ['project.read', 'project.write', 'project.manage'] as const;
export const DRAFT_ACTIONS = ['draft.read', 'draft.write', 'draft.share', 'draft.move'] as const;
export const AGENT_ACTIONS = ['agent.read', 'agent.revoke'] as const;

/** Actions grouped by the kind of object they are checked against. */
export interface ActionsByResource {
  workspace: (typeof WORKSPACE_ACTIONS)[number];
  project: (typeof PROJECT_ACTIONS)[number];
  draft: (typeof DRAFT_ACTIONS)[number];
  agent: (typeof AGENT_ACTIONS)[number];
}
export type ResourceType = keyof ActionsByResource;
export type Action = ActionsByResource[ResourceType];
export interface ResourceRef<T extends ResourceType = ResourceType> {
  type: T;
  id: string;
}

export interface Decision {
  /** The principal may perform the action. */
  allowed: boolean;
  /** The principal may know that the object exists; false maps to 404, not 403. */
  visible: boolean;
}

/** Current facts about one principal in one workspace, read fresh for every decision. */
export interface Actor {
  principal: Principal;
  workspaceId: string;
  /** Membership role of a person; null for agents and non-members. */
  role: WorkspaceRole | null;
  agent: { ownerUserId: string | null; ownerRole: WorkspaceRole | null } | null;
  /** False for non-members, revoked agents, agents whose owner left, and fixtures. */
  active: boolean;
}

export const LEVEL = { none: 0, viewer: 1, contributor: 2, manager: 3 } as const;
const MANAGER_ROLES: readonly WorkspaceRole[] = ['owner', 'admin'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value);
}

export function isManager(role: WorkspaceRole | null) {
  return role !== null && MANAGER_ROLES.includes(role);
}

export function accessName(level: number): ProjectAccess | null {
  if (level >= LEVEL.manager) return 'manager';
  if (level >= LEVEL.contributor) return 'contributor';
  if (level >= LEVEL.viewer) return 'viewer';
  return null;
}

export interface LoadOptions {
  /** Inside a mutation transaction: lock the membership/agent rows so a concurrent revocation waits or is seen. */
  lock?: boolean;
}

async function memberRole(db: Executor, workspaceId: string, userId: string, lock: boolean): Promise<WorkspaceRole | null> {
  const query = db.select({ role: schema.workspaceMembers.role }).from(schema.workspaceMembers)
    .where(and(eq(schema.workspaceMembers.workspaceId, workspaceId), eq(schema.workspaceMembers.userId, userId)));
  const rows = lock ? await query.for('share') : await query;
  return rows[0]?.role ?? null;
}

/** Reads the principal's current standing in a workspace. Never cached. */
export async function loadActor(principal: Principal, workspaceId: string, db: Executor, options: LoadOptions = {}): Promise<Actor> {
  const lock = options.lock ?? false;
  const inactive: Actor = { principal, workspaceId, role: null, agent: null, active: false };
  if (!isUuid(workspaceId) || !principal.id) return inactive;
  if (principal.kind === 'human') {
    const role = await memberRole(db, workspaceId, principal.id, lock);
    return { ...inactive, role, active: role !== null };
  }
  if (principal.kind === 'agent') {
    if (!isUuid(principal.id)) return inactive;
    const query = db.select({ ownerUserId: schema.agents.ownerUserId, revokedAt: schema.agents.revokedAt }).from(schema.agents)
      .where(and(eq(schema.agents.id, principal.id), eq(schema.agents.workspaceId, workspaceId)));
    const [agent] = lock ? await query.for('share') : await query;
    if (!agent || agent.revokedAt) return inactive;
    const ownerRole = agent.ownerUserId ? await memberRole(db, workspaceId, agent.ownerUserId, lock) : null;
    const active = agent.ownerUserId === null || ownerRole !== null;
    return { ...inactive, agent: { ownerUserId: agent.ownerUserId, ownerRole }, active };
  }
  return inactive;
}

function grantExists(column: 'user_id' | 'agent_id', principalId: string, projectId: SQLWrapper, role: 'contributor' | 'viewer' | 'denied'): SQL {
  return sql`EXISTS (SELECT 1 FROM project_grants g WHERE g.project_id = ${projectId} AND g.${sql.raw(column)} = ${principalId} AND g.role = ${role})`;
}

function humanLevel(userId: string, role: WorkspaceRole | null, projectId: SQLWrapper, visibility: SQLWrapper): SQL {
  if (!role) return sql`0`;
  const denied = grantExists('user_id', userId, projectId, 'denied');
  if (isManager(role)) return sql`(CASE WHEN ${denied} THEN 0 ELSE 3 END)`;
  const implicit = role === 'member' ? sql` WHEN ${visibility} = 'workspace' THEN 2` : sql``;
  return sql`(CASE WHEN ${denied} THEN 0 WHEN ${grantExists('user_id', userId, projectId, 'contributor')} THEN 2 WHEN ${grantExists('user_id', userId, projectId, 'viewer')} THEN 1${implicit} ELSE 0 END)`;
}

/**
 * SQL expression for the actor's access level (0–3) to the project identified by
 * `projectId` whose visibility column/expression is `visibility`. Composable into lists.
 */
export function projectLevelSql(actor: Actor, projectId: SQLWrapper, visibility: SQLWrapper): SQL {
  if (!actor.active) return sql`0`;
  if (actor.principal.kind === 'human') return humanLevel(actor.principal.id, actor.role, projectId, visibility);
  const id = actor.principal.id;
  const own = sql`(CASE WHEN ${grantExists('agent_id', id, projectId, 'denied')} THEN 0 WHEN ${grantExists('agent_id', id, projectId, 'contributor')} THEN 2 WHEN ${grantExists('agent_id', id, projectId, 'viewer')} THEN 1 ELSE 0 END)`;
  const owner = actor.agent?.ownerUserId;
  return owner ? sql`LEAST(${own}, ${humanLevel(owner, actor.agent?.ownerRole ?? null, projectId, visibility)})` : own;
}

const draftProjectVisibility = sql`(SELECT p.visibility FROM projects p WHERE p.id = ${schema.drafts.projectId})`;

function draftProjectLevel(actor: Actor): SQL {
  return sql`(CASE WHEN ${schema.drafts.projectId} IS NULL THEN 0 ELSE ${projectLevelSql(actor, schema.drafts.projectId, draftProjectVisibility)} END)`;
}

function isDraftOwner(actor: Actor): SQL {
  return actor.principal.kind === 'agent' ? eq(schema.drafts.ownerAgentId, actor.principal.id) : eq(schema.drafts.ownerUserId, actor.principal.id);
}

/** Condition over `projects` rows: the project is in the actor's workspace and at least viewable. */
export function visibleProjectsSql(actor: Actor): SQL {
  if (!actor.active) return sql`false`;
  return and(eq(schema.projects.workspaceId, actor.workspaceId), sql`${projectLevelSql(actor, schema.projects.id, schema.projects.visibility)} >= 1`)!;
}

/** Condition over `drafts` rows: the actor may read the draft. Apply before count/limit. */
export function visibleDraftsSql(actor: Actor): SQL {
  if (!actor.active) return sql`false`;
  const d = schema.drafts;
  const column = actor.principal.kind === 'agent' ? 'agent_id' : 'user_id';
  const denied = sql`(${d.projectId} IS NOT NULL AND ${grantExists(column, actor.principal.id, d.projectId, 'denied')})`;
  const audiences: SQL[] = [isDraftOwner(actor), sql`(${d.visibility} = 'project' AND ${draftProjectLevel(actor)} >= 1)`];
  if (actor.principal.kind === 'human' && actor.role !== 'guest') audiences.push(sql`${d.visibility} = 'workspace'`);
  return and(eq(d.workspaceId, actor.workspaceId), sql`NOT ${denied}`, or(...audiences))!;
}

/**
 * The list filter for a principal in a workspace. Put it in the WHERE clause of the list
 * query and of its count so invisible rows never reach counts, pages or payloads.
 */
export async function visibleFilter(principal: Principal, workspaceId: string, kind: 'project' | 'draft', db: Executor): Promise<SQL> {
  const actor = await loadActor(principal, workspaceId, db);
  return kind === 'project' ? visibleProjectsSql(actor) : visibleDraftsSql(actor);
}

// ---------------------------------------------------------------------------------------
// Single-object evaluation. Internal evaluators also return the loaded row so domain
// methods decide and act on the same data inside one transaction.

type DraftRow = typeof schema.drafts.$inferSelect;
type ProjectRow = typeof schema.projects.$inferSelect;
type AgentRow = typeof schema.agents.$inferSelect;

export interface WorkspaceEvaluation extends Decision { actor: Actor }
export interface ProjectEvaluation extends Decision { actor: Actor | null; project: ProjectRow | null; level: number }
export interface DraftEvaluation extends Decision { actor: Actor | null; draft: DraftRow | null; level: number; isOwner: boolean }
export interface AgentEvaluation extends Decision { actor: Actor | null; agent: AgentRow | null }

const DENIED: Decision = { allowed: false, visible: false };

export async function evaluateWorkspace(principal: Principal, action: ActionsByResource['workspace'], workspaceId: string, db: Executor, options?: LoadOptions): Promise<WorkspaceEvaluation> {
  const actor = await loadActor(principal, workspaceId, db, options);
  if (!actor.active) return { ...DENIED, actor };
  const human = principal.kind === 'human';
  let allowed: boolean;
  switch (action) {
    case 'workspace.read':
    case 'draft.create':
      allowed = true;
      break;
    case 'workspace.read_members':
    case 'agent.create':
      allowed = human && actor.role !== 'guest';
      break;
    case 'workspace.manage_members':
    case 'workspace.manage_agents':
    case 'project.create':
      allowed = human && isManager(actor.role);
      break;
  }
  return { allowed, visible: true, actor };
}

export async function evaluateProject(principal: Principal, action: ActionsByResource['project'], projectId: string, db: Executor, options?: LoadOptions): Promise<ProjectEvaluation> {
  const none = { ...DENIED, actor: null, project: null, level: 0 };
  if (!isUuid(projectId)) return none;
  const [located] = await db.select({ workspaceId: schema.projects.workspaceId }).from(schema.projects).where(eq(schema.projects.id, projectId));
  if (!located) return none;
  const actor = await loadActor(principal, located.workspaceId, db, options);
  if (!actor.active) return { ...none, actor };
  const [row] = await db.select({ project: schema.projects, level: projectLevelSql(actor, schema.projects.id, schema.projects.visibility).mapWith(Number) })
    .from(schema.projects).where(eq(schema.projects.id, projectId));
  if (!row || row.level < LEVEL.viewer) return { ...none, actor };
  const needed = action === 'project.manage' ? LEVEL.manager : action === 'project.write' ? LEVEL.contributor : LEVEL.viewer;
  return { allowed: row.level >= needed, visible: true, actor, project: row.project, level: row.level };
}

export async function evaluateDraft(principal: Principal, action: ActionsByResource['draft'], draftId: string, db: Executor, options: LoadOptions = {}): Promise<DraftEvaluation> {
  const none = { ...DENIED, actor: null, draft: null, level: 0, isOwner: false };
  if (!isUuid(draftId)) return none;
  const [located] = await db.select({ workspaceId: schema.drafts.workspaceId }).from(schema.drafts).where(eq(schema.drafts.id, draftId));
  if (!located) return none;
  const actor = await loadActor(principal, located.workspaceId, db, options);
  if (!actor.active) return { ...none, actor };
  const query = db.select({
    draft: schema.drafts,
    readable: visibleDraftsSql(actor).mapWith(Boolean),
    level: draftProjectLevel(actor).mapWith(Number),
    isOwner: isDraftOwner(actor).mapWith(Boolean),
  }).from(schema.drafts).where(eq(schema.drafts.id, draftId));
  const [row] = options.lock ? await query.for('update') : await query;
  if (!row || !row.readable) return { ...none, actor };
  const { draft, level, isOwner } = row;
  const manager = isManager(actor.role);
  let allowed: boolean;
  switch (action) {
    case 'draft.read':
      allowed = true;
      break;
    case 'draft.write':
      allowed = isOwner || (draft.visibility === 'project' && level >= LEVEL.contributor) || (draft.visibility === 'workspace' && manager);
      break;
    case 'draft.share':
    case 'draft.move':
      allowed = isOwner || (draft.visibility !== 'private' && manager);
      break;
  }
  return { allowed, visible: true, actor, draft, level, isOwner };
}

export async function evaluateAgent(principal: Principal, action: ActionsByResource['agent'], agentId: string, db: Executor, options?: LoadOptions): Promise<AgentEvaluation> {
  const none = { ...DENIED, actor: null, agent: null };
  if (!isUuid(agentId)) return none;
  const [agent] = await db.select().from(schema.agents).where(eq(schema.agents.id, agentId));
  if (!agent) return none;
  const actor = await loadActor(principal, agent.workspaceId, db, options);
  const self = principal.kind === 'agent' && principal.id === agent.id;
  const ownedByCaller = principal.kind === 'human' && agent.ownerUserId === principal.id;
  const visible = actor.active && (self || (principal.kind === 'human' && actor.role !== 'guest'));
  if (!visible) return { ...none, actor };
  const allowed = action === 'agent.read' || ownedByCaller || isManager(actor.role);
  return { allowed, visible, actor, agent };
}

/**
 * Decides whether `principal` may perform `action` on `resource`, reading current
 * membership, grants and object visibility. Use {@link assertAuthorized} to throw the
 * matching 404/403 error instead.
 */
export async function authorize<T extends ResourceType>(principal: Principal, action: ActionsByResource[T], resource: ResourceRef<T>, db: Executor): Promise<Decision> {
  const { allowed, visible } = await evaluate(principal, action, resource, db);
  return { allowed, visible };
}

/** Throws NotFoundError when the object is invisible to the principal, ForbiddenError when the action is not allowed. */
export async function assertAuthorized<T extends ResourceType>(principal: Principal, action: ActionsByResource[T], resource: ResourceRef<T>, db: Executor): Promise<void> {
  enforce(await evaluate(principal, action, resource, db), resource.type);
}

async function evaluate(principal: Principal, action: Action, resource: ResourceRef, db: Executor): Promise<Decision> {
  switch (resource.type) {
    case 'workspace': return evaluateWorkspace(principal, action as ActionsByResource['workspace'], resource.id, db);
    case 'project': return evaluateProject(principal, action as ActionsByResource['project'], resource.id, db);
    case 'draft': return evaluateDraft(principal, action as ActionsByResource['draft'], resource.id, db);
    case 'agent': return evaluateAgent(principal, action as ActionsByResource['agent'], resource.id, db);
  }
}

const LABELS: Record<ResourceType, string> = { workspace: 'Workspace', project: 'Project', draft: 'Draft', agent: 'Agent' };

/** Converts a decision into the non-leaking error contract. */
export function enforce<D extends Decision>(decision: D, type: ResourceType): D {
  if (!decision.visible) throw new NotFoundError(LABELS[type], `${type.toUpperCase()}_NOT_FOUND`);
  if (!decision.allowed) throw new ForbiddenError(`Not allowed to perform this action on the ${type}`);
  return decision;
}
