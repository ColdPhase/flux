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
 * - Sketches (issue #69): a `project` sketch is readable at project level viewer and
 *   changeable at contributor. A `private` sketch is readable and changeable only by the
 *   person who created it while they are active in the workspace; owners and admins do not
 *   see it, and agents never do. `sketch.create` in a workspace is a private sketch by an
 *   active person; a project sketch needs `project.write` on its project.
 * - Direct messages (issue #107): a DM's audience is exactly its current participants. Only a
 *   participant who is active in the workspace reads or writes it; workspace owners and admins
 *   who are not participants never see it, and agents never do in this slice. `dm.create` is
 *   for owners, admins and members (guests can take part when added, but not start a DM).
 * - An agent never works outside its current project grants, not even on drafts it
 *   authored: it creates drafts only inside a project where it is a contributor, and
 *   every read (viewer) or write, share and move (contributor) of any draft — its own
 *   private drafts included — needs its current level on the draft's project.
 * - With `lock: true` (inside a mutation transaction) the decision locks the rows it
 *   depends on — membership/agent `FOR SHARE`, the draft `FOR UPDATE`, the project and
 *   the principal's grants on it `FOR SHARE` — so a concurrent membership, grant or
 *   agent change either commits first and is seen, or waits until the mutation commits.
 * - Callers that cannot see an object get {@link NotFoundError} (404) so its existence
 *   does not leak; visible objects with a forbidden action get {@link ForbiddenError} (403).
 */

export const WORKSPACE_ACTIONS = ['workspace.read', 'workspace.read_members', 'workspace.manage_members', 'workspace.manage_agents', 'project.create', 'draft.create', 'agent.create', 'sketch.create', 'dm.create'] as const;
export const PROJECT_ACTIONS = ['project.read', 'project.write', 'project.manage'] as const;
export const DRAFT_ACTIONS = ['draft.read', 'draft.write', 'draft.share', 'draft.move'] as const;
export const AGENT_ACTIONS = ['agent.read', 'agent.revoke', 'agent.invoke'] as const;
export const SKETCH_ACTIONS = ['sketch.read', 'sketch.write'] as const;
export const DM_ACTIONS = ['dm.read', 'dm.write'] as const;
export const ASSISTANT_RUN_ACTIONS = ['assistant_run.read'] as const;

/** Actions grouped by the kind of object they are checked against. */
export interface ActionsByResource {
  workspace: (typeof WORKSPACE_ACTIONS)[number];
  project: (typeof PROJECT_ACTIONS)[number];
  draft: (typeof DRAFT_ACTIONS)[number];
  agent: (typeof AGENT_ACTIONS)[number];
  sketch: (typeof SKETCH_ACTIONS)[number];
  dm: (typeof DM_ACTIONS)[number];
  assistant_run: (typeof ASSISTANT_RUN_ACTIONS)[number];
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
  /**
   * Inside a mutation transaction: lock the membership/agent rows, the draft, and the
   * project and grant rows the decision reads, so a concurrent revocation waits or is seen.
   */
  lock?: boolean;
}

/**
 * Locks the project row and every grant row that can contribute to the actor's level on
 * it (`FOR SHARE`). Grant and revoke take `FOR NO KEY UPDATE` on the project row first
 * and `FOR UPDATE` (or DELETE) on the grant row, so they conflict with these locks:
 * whichever transaction locks first finishes before the other decides.
 */
export async function lockProjectAccess(db: Executor, actor: Actor, projectId: string): Promise<void> {
  if (!isUuid(projectId)) return;
  await db.execute(sql`SELECT 1 FROM projects WHERE id = ${projectId} FOR SHARE`);
  const holders: SQL[] = [];
  if (actor.principal.kind === 'human' && isUuid(actor.principal.id)) holders.push(sql`g.user_id = ${actor.principal.id}`);
  if (actor.principal.kind === 'agent' && isUuid(actor.principal.id)) {
    holders.push(sql`g.agent_id = ${actor.principal.id}`);
    if (actor.agent?.ownerUserId) holders.push(sql`g.user_id = ${actor.agent.ownerUserId}`);
  }
  if (!holders.length) return;
  await db.execute(sql`SELECT g.id FROM project_grants g WHERE g.project_id = ${projectId} AND (${sql.join(holders, sql` OR `)}) ORDER BY g.id FOR SHARE`);
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
  if (actor.principal.kind === 'agent') {
    // An agent reads only inside its current project access, including its own drafts.
    // A deny grant or a lost grant yields level 0, so no separate deny clause is needed.
    return and(eq(d.workspaceId, actor.workspaceId), sql`${draftProjectLevel(actor)} >= 1`,
      or(isDraftOwner(actor), sql`${d.visibility} = 'project'`))!;
  }
  const denied = sql`(${d.projectId} IS NOT NULL AND ${grantExists('user_id', actor.principal.id, d.projectId, 'denied')})`;
  const audiences: SQL[] = [isDraftOwner(actor), sql`(${d.visibility} = 'project' AND ${draftProjectLevel(actor)} >= 1)`];
  if (actor.principal.kind === 'human' && actor.role !== 'guest') audiences.push(sql`${d.visibility} = 'workspace'`);
  return and(eq(d.workspaceId, actor.workspaceId), sql`NOT ${denied}`, or(...audiences))!;
}

const sketchProjectVisibility = sql`(SELECT p.visibility FROM projects p WHERE p.id = ${schema.sketches.projectId})`;

function sketchProjectLevel(actor: Actor): SQL {
  return sql`(CASE WHEN ${schema.sketches.projectId} IS NULL THEN 0 ELSE ${projectLevelSql(actor, schema.sketches.projectId, sketchProjectVisibility)} END)`;
}

/** Condition over `sketches` rows: the actor may read the sketch. Apply before count/limit. */
export function visibleSketchesSql(actor: Actor): SQL {
  if (!actor.active) return sql`false`;
  const s = schema.sketches;
  const project = sql`(${s.scope} = 'project' AND ${sketchProjectLevel(actor)} >= 1)`;
  // Agents never see private sketches, not even their owner's.
  if (actor.principal.kind !== 'human') return and(eq(s.workspaceId, actor.workspaceId), project)!;
  const own = sql`(${s.scope} = 'private' AND ${s.createdByUserId} = ${actor.principal.id})`;
  return and(eq(s.workspaceId, actor.workspaceId), or(project, own))!;
}

/**
 * Condition over `dms` rows: the actor is a current participant. Workspace roles add nothing:
 * owners and admins see only the DMs they are in. Agents see none (no participant grants yet).
 */
export function visibleDmsSql(actor: Actor): SQL {
  if (!actor.active || actor.principal.kind !== 'human') return sql`false`;
  const d = schema.dms;
  return and(eq(d.workspaceId, actor.workspaceId),
    sql`EXISTS (SELECT 1 FROM dm_participants dp WHERE dp.dm_id = "dms"."id" AND dp.user_id = ${actor.principal.id})`)!;
}

/**
 * The list filter for a principal in a workspace. Put it in the WHERE clause of the list
 * query and of its count so invisible rows never reach counts, pages or payloads.
 */
export async function visibleFilter(principal: Principal, workspaceId: string, kind: 'project' | 'draft' | 'sketch' | 'dm', db: Executor): Promise<SQL> {
  const actor = await loadActor(principal, workspaceId, db);
  if (kind === 'sketch') return visibleSketchesSql(actor);
  if (kind === 'dm') return visibleDmsSql(actor);
  return kind === 'project' ? visibleProjectsSql(actor) : visibleDraftsSql(actor);
}

// ---------------------------------------------------------------------------------------
// Single-object evaluation. Internal evaluators also return the loaded row so domain
// methods decide and act on the same data inside one transaction.

type DraftRow = typeof schema.drafts.$inferSelect;
type ProjectRow = typeof schema.projects.$inferSelect;
type AgentRow = typeof schema.agents.$inferSelect;
type SketchRow = typeof schema.sketches.$inferSelect;
type DmRow = typeof schema.dms.$inferSelect;

export interface WorkspaceEvaluation extends Decision { actor: Actor }
export interface ProjectEvaluation extends Decision { actor: Actor | null; project: ProjectRow | null; level: number }
export interface DraftEvaluation extends Decision { actor: Actor | null; draft: DraftRow | null; level: number; isOwner: boolean }
export interface AgentEvaluation extends Decision { actor: Actor | null; agent: AgentRow | null }
export interface SketchEvaluation extends Decision { actor: Actor | null; sketch: SketchRow | null }
export interface DmEvaluation extends Decision { actor: Actor | null; dm: DmRow | null }
export interface AssistantRunEvaluation extends Decision { actor: Actor | null; run: { id: string; workspaceId: string; ownerUserId: string } | null }

const DENIED: Decision = { allowed: false, visible: false };

export async function evaluateWorkspace(principal: Principal, action: ActionsByResource['workspace'], workspaceId: string, db: Executor, options?: LoadOptions): Promise<WorkspaceEvaluation> {
  const actor = await loadActor(principal, workspaceId, db, options);
  if (!actor.active) return { ...DENIED, actor };
  const human = principal.kind === 'human';
  let allowed: boolean;
  switch (action) {
    case 'workspace.read':
      allowed = true;
      break;
    case 'draft.create':
      // People may keep unscoped private drafts; an agent needs a project it can write in
      // (createDraft additionally requires that project to be the draft's project).
      allowed = human || await hasWritableProject(actor, db);
      break;
    case 'sketch.create':
      allowed = human;
      break;
    case 'dm.create':
      allowed = human && actor.role !== 'guest';
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

async function hasWritableProject(actor: Actor, db: Executor): Promise<boolean> {
  const rows = await db.select({ id: schema.projects.id }).from(schema.projects)
    .where(and(eq(schema.projects.workspaceId, actor.workspaceId), sql`${projectLevelSql(actor, schema.projects.id, schema.projects.visibility)} >= ${LEVEL.contributor}`))
    .limit(1);
  return rows.length > 0;
}

export async function evaluateProject(principal: Principal, action: ActionsByResource['project'], projectId: string, db: Executor, options?: LoadOptions): Promise<ProjectEvaluation> {
  const none = { ...DENIED, actor: null, project: null, level: 0 };
  if (!isUuid(projectId)) return none;
  const [located] = await db.select({ workspaceId: schema.projects.workspaceId }).from(schema.projects).where(eq(schema.projects.id, projectId));
  if (!located) return none;
  const actor = await loadActor(principal, located.workspaceId, db, options);
  if (!actor.active) return { ...none, actor };
  if (options?.lock) await lockProjectAccess(db, actor, projectId);
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
  if (options.lock) {
    // Lock the draft first so its project cannot change, then that project's access rows.
    const [locked] = await db.select({ projectId: schema.drafts.projectId }).from(schema.drafts).where(eq(schema.drafts.id, draftId)).for('update');
    if (locked?.projectId) await lockProjectAccess(db, actor, locked.projectId);
  }
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
  if (principal.kind === 'agent') {
    // Readable already implies current viewer access; changes need current contributor access.
    const writable = level >= LEVEL.contributor;
    allowed = action === 'draft.read' || (writable && (action === 'draft.write' ? isOwner || draft.visibility === 'project' : isOwner));
    return { allowed, visible: true, actor, draft, level, isOwner };
  }
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
  // `agent.invoke` (#68, O-008): only the owning person, while the agent is not revoked. A
  // workspace role never lets anyone else use a person's assistant or its payer.
  const allowed = action === 'agent.invoke' ? ownedByCaller && !agent.revokedAt
    : action === 'agent.read' || ownedByCaller || isManager(actor.role);
  return { allowed, visible, actor, agent };
}

/**
 * With `lock`, the sketch row is taken `FOR NO KEY UPDATE` (changes to one sketch run one at a
 * time, so version checks and link rules see each other), then the project access rows
 * `FOR SHARE`, so a concurrent revocation is seen or waits.
 */
export async function evaluateSketch(principal: Principal, action: ActionsByResource['sketch'], sketchId: string, db: Executor, options: LoadOptions = {}): Promise<SketchEvaluation> {
  const none = { ...DENIED, actor: null, sketch: null };
  if (!isUuid(sketchId)) return none;
  const s = schema.sketches;
  const [located] = await db.select({ workspaceId: s.workspaceId, projectId: s.projectId }).from(s).where(eq(s.id, sketchId));
  if (!located) return none;
  const actor = await loadActor(principal, located.workspaceId, db, options);
  if (!actor.active) return { ...none, actor };
  if (options.lock) {
    await db.select({ id: s.id }).from(s).where(eq(s.id, sketchId)).for('no key update');
    // A private sketch depends only on its owner's membership, which loadActor locked.
    if (located.projectId) await lockProjectAccess(db, actor, located.projectId);
  }
  const [row] = await db.select({ sketch: s, readable: visibleSketchesSql(actor).mapWith(Boolean), level: sketchProjectLevel(actor).mapWith(Number) })
    .from(s).where(eq(s.id, sketchId));
  if (!row || !row.readable) return { ...none, actor };
  const allowed = action === 'sketch.read' || row.sketch.scope === 'private' || row.level >= LEVEL.contributor;
  return { allowed, visible: true, actor, sketch: row.sketch };
}

/**
 * A DM is visible and changeable only for its current participants. With `lock`, the DM row is
 * taken `FOR NO KEY UPDATE` (sends, renames and leaves of one DM run one at a time) and the
 * caller's participant row `FOR SHARE`, after `loadActor` locked the membership: leaving or a
 * membership removal (which cascades to the participant row) either commits first and is seen,
 * or waits until this change commits.
 */
export async function evaluateDm(principal: Principal, _action: ActionsByResource['dm'], dmId: string, db: Executor, options: LoadOptions = {}): Promise<DmEvaluation> {
  const none = { ...DENIED, actor: null, dm: null };
  if (!isUuid(dmId)) return none;
  const d = schema.dms;
  const [located] = await db.select({ workspaceId: d.workspaceId }).from(d).where(eq(d.id, dmId));
  if (!located) return none;
  const actor = await loadActor(principal, located.workspaceId, db, options);
  if (!actor.active || principal.kind !== 'human') return { ...none, actor };
  if (options.lock) {
    await db.select({ id: d.id }).from(d).where(eq(d.id, dmId)).for('no key update');
    await db.select({ userId: schema.dmParticipants.userId }).from(schema.dmParticipants)
      .where(and(eq(schema.dmParticipants.dmId, dmId), eq(schema.dmParticipants.userId, principal.id))).for('share');
  }
  const [row] = await db.select({ dm: d, readable: visibleDmsSql(actor).mapWith(Boolean) }).from(d).where(eq(d.id, dmId));
  if (!row || !row.readable) return { ...none, actor };
  // Reading and writing need the same thing: being a participant now.
  return { allowed: true, visible: true, actor, dm: row.dm };
}

/**
 * A personal assistant run (#68, O-008 §4): only its owner, while active in the run's
 * workspace, may know it exists. Workspace roles, project access and agents never see it; the
 * run's progress events therefore reach the owner alone. A committed answer is a separate
 * project object (`project.assistant_answer_committed.v1`) for the conversation's audience.
 */
export async function evaluateAssistantRun(principal: Principal, _action: ActionsByResource['assistant_run'], runId: string, db: Executor, options: LoadOptions = {}): Promise<AssistantRunEvaluation> {
  const none = { ...DENIED, actor: null, run: null };
  if (!isUuid(runId) || principal.kind !== 'human') return none;
  const r = schema.personalRuns;
  const [run] = await db.select({ id: r.id, workspaceId: r.workspaceId, ownerUserId: r.ownerUserId }).from(r).where(eq(r.id, runId));
  if (!run || run.ownerUserId !== principal.id) return none;
  const actor = await loadActor(principal, run.workspaceId, db, options);
  if (!actor.active) return { ...none, actor };
  return { allowed: true, visible: true, actor, run };
}

/**
 * Decides whether `principal` may perform `action` on `resource`, reading current
 * membership, grants and object visibility. Use {@link assertAuthorized} to throw the
 * matching 404/403 error instead.
 */
export async function authorize<T extends ResourceType>(principal: Principal, action: ActionsByResource[T], resource: ResourceRef<T>, db: Executor, options?: LoadOptions): Promise<Decision> {
  const { allowed, visible } = await evaluate(principal, action, resource, db, options);
  return { allowed, visible };
}

/**
 * Throws NotFoundError when the object is invisible to the principal, ForbiddenError when
 * the action is not allowed. Inside a commit transaction pass `{ lock: true }`: the
 * principal's membership/agent rows are locked FOR SHARE and a draft FOR UPDATE, so a
 * revocation committed earlier is seen and a concurrent one waits for this transaction.
 */
export async function assertAuthorized<T extends ResourceType>(principal: Principal, action: ActionsByResource[T], resource: ResourceRef<T>, db: Executor, options?: LoadOptions): Promise<void> {
  enforce(await evaluate(principal, action, resource, db, options), resource.type);
}

async function evaluate(principal: Principal, action: Action, resource: ResourceRef, db: Executor, options?: LoadOptions) {
  switch (resource.type) {
    case 'workspace': return evaluateWorkspace(principal, action as ActionsByResource['workspace'], resource.id, db, options);
    case 'project': return evaluateProject(principal, action as ActionsByResource['project'], resource.id, db, options);
    case 'draft': return evaluateDraft(principal, action as ActionsByResource['draft'], resource.id, db, options);
    case 'agent': return evaluateAgent(principal, action as ActionsByResource['agent'], resource.id, db, options);
    case 'sketch': return evaluateSketch(principal, action as ActionsByResource['sketch'], resource.id, db, options);
    case 'dm': return evaluateDm(principal, action as ActionsByResource['dm'], resource.id, db, options);
    case 'assistant_run': return evaluateAssistantRun(principal, action as ActionsByResource['assistant_run'], resource.id, db, options);
  }
}

const READ_ACTION = { workspace: 'workspace.read', project: 'project.read', draft: 'draft.read', agent: 'agent.read', sketch: 'sketch.read', dm: 'dm.read', assistant_run: 'assistant_run.read' } as const satisfies { [T in ResourceType]: ActionsByResource[T] };

/**
 * The workspace of an object the principal can currently see, or null. Entry points use
 * it to scope records such as idempotency keys without revealing invisible objects.
 */
export async function visibleWorkspaceOf(principal: Principal, resource: ResourceRef, db: Executor): Promise<string | null> {
  const evaluation = await evaluate(principal, READ_ACTION[resource.type], resource, db);
  if (!evaluation.visible) return null;
  if ('project' in evaluation) return evaluation.project?.workspaceId ?? null;
  if ('draft' in evaluation) return evaluation.draft?.workspaceId ?? null;
  if ('agent' in evaluation) return evaluation.agent?.workspaceId ?? null;
  if ('sketch' in evaluation) return evaluation.sketch?.workspaceId ?? null;
  if ('dm' in evaluation) return evaluation.dm?.workspaceId ?? null;
  if ('run' in evaluation) return evaluation.run?.workspaceId ?? null;
  return evaluation.actor.workspaceId;
}

// ---------------------------------------------------------------------------------------
// Events. The stream and replay deliver an event to a recipient only when this returns
// true at delivery time; payloads carry identifiers and kind, never content.

export interface EventRef {
  kind: string;
  workspaceId: string | null;
  objectId: string;
}

/** The object an event is about, derived from its versioned kind (`<type>.<verb>.v<n>`). */
export function eventResource(event: EventRef): ResourceRef | null {
  if (!event.workspaceId) return null;
  const type = event.kind.split('.', 1)[0];
  if (type === 'workspace') return event.objectId === event.workspaceId ? { type, id: event.objectId } : null;
  if (type === 'project' || type === 'draft' || type === 'agent' || type === 'sketch' || type === 'dm' || type === 'assistant_run') return { type, id: event.objectId };
  return null;
}

/**
 * Whether `principal` may receive `event` now: the principal must be active in the
 * event's workspace and currently able to read the object the event is about. Unknown
 * kinds and events without a workspace are never delivered.
 */
export async function authorizeEvent(principal: Principal, event: EventRef, db: Executor): Promise<boolean> {
  const resource = eventResource(event);
  if (!resource) return false;
  const decision = await evaluate(principal, READ_ACTION[resource.type], resource, db);
  if (!decision.allowed || !decision.visible) return false;
  // The object must still belong to the event's workspace (defense in depth).
  if ('actor' in decision && decision.actor && decision.actor.workspaceId !== event.workspaceId) return false;
  return true;
}

const LABELS: Record<ResourceType, string> = { workspace: 'Workspace', project: 'Project', draft: 'Draft', agent: 'Agent', sketch: 'Sketch', dm: 'Direct message', assistant_run: 'Assistant run' };

/** Converts a decision into the non-leaking error contract. */
export function enforce<D extends Decision>(decision: D, type: ResourceType): D {
  if (!decision.visible) throw new NotFoundError(LABELS[type], `${type.toUpperCase()}_NOT_FOUND`);
  if (!decision.allowed) throw new ForbiddenError(`Not allowed to perform this action on the ${type}`);
  return decision;
}
