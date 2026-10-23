import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, inArray, isNull, sql, type SQL } from 'drizzle-orm';
import { schema, eventRepository, projectGoalRows, workspaceAiSweepRows } from '@flux/db';
import { ASSISTANT_RUN_CHANGED_EVENT, ASSISTANT_WORKING_EVENT, WORKSPACE_AI_POLICY_CHANGED_EVENT } from '@flux/contracts';
import type {
  SetWorkspaceAiPolicyCommand,
  SetWorkspaceAiPolicyResult,
  WorkspaceAiSweepJob,
  WorkspaceAiSwept,
  AddMemberCommand,
  Agent,
  ChangeRoleCommand,
  CreateAgentCommand,
  CreateDraftCommand,
  AddProjectViewCommand,
  CreateProjectCommand,
  ProjectViewId,
  CreateWorkspaceCommand,
  Draft,
  DraftListQuery,
  DraftVisibility,
  GrantProjectCommand,
  MoveDraftCommand,
  Page,
  PageQuery,
  Project,
  ProjectGrant,
  ProjectPerson,
  ProjectGrantRole,
  ProjectVisibility,
  ShareDraftCommand,
  UpdateDraftCommand,
  Workspace,
  WorkspaceAiPolicy,
  WorkspaceMember,
  WorkspaceRole,
} from '@flux/contracts';
import { PROJECT_TEMPLATES, PROJECT_VIEWS, TEMPLATE_VIEWS } from '@flux/contracts';
import type { Database, Executor, Principal } from '../types.js';
import { ConflictError, ForbiddenError, InvalidInputError, NotFoundError, PreconditionRequiredError, RuleViolationError, VersionConflictError } from './errors.js';
import { policyEventPorts, recordEvent } from '../events.js';
import { presentProjectGoal } from '../project-goals/service.js';
import {
  accessName,
  enforce,
  evaluateAgent,
  evaluateDraft,
  evaluateProject,
  evaluateWorkspace,
  isUuid,
  LEVEL,
  projectLevelSql,
  requireWorkspaceAi,
  workspaceAi,
  visibleDraftsSql,
  visibleProjectsSql,
  type Actor,
} from './policy.js';

/** Optional transaction composition: prepare grant/project events, then flush after all related writes. */
export interface DomainEventSink {
  record(principal: Principal, workspaceId: string, kind: string, objectId: string, data: Record<string, unknown>): Promise<void>;
}

// Events of these use cases: the access policy decides the audience; `@flux/db` stores (#89).
const events = (tx: Executor) => policyEventPorts(tx, eventRepository(tx));

// Domain commands for workspaces, projects, grants, agents and drafts. Every method
// authorizes through ./policy.ts before touching data; mutations decide and write in the
// same transaction with the rows the decision depends on locked (membership/agent, draft,
// project and the actor's grants on it). Membership, grant and agent changes take
// conflicting locks on the rows they change, so a concurrent revocation is either seen or
// waits until the mutation commits. Entry points must call these methods, never the tables.
// Draft update, share and move require the caller's expected version (If-Match).

const ROLES: readonly WorkspaceRole[] = ['owner', 'admin', 'member', 'guest'];
const PROJECT_VISIBILITIES: readonly ProjectVisibility[] = ['workspace', 'restricted'];
const GRANT_ROLES: readonly ProjectGrantRole[] = ['contributor', 'viewer', 'denied'];
const DRAFT_VISIBILITIES: readonly DraftVisibility[] = ['private', 'project', 'workspace'];
const MAX_BODY = 100_000;

type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];

function oneOf<T extends string>(value: unknown, allowed: readonly T[], field: string): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) throw new InvalidInputError(`${field} must be one of ${allowed.join(', ')}`);
  return value as T;
}

function name(value: unknown, field = 'Name'): string {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text || text.length > 200) throw new InvalidInputError(`${field} must be 1–200 characters`);
  return text;
}

function body(value: unknown): string {
  if (value === undefined) return '';
  if (typeof value !== 'string' || value.length > MAX_BODY) throw new InvalidInputError(`Body must be a string of at most ${MAX_BODY} characters`);
  return value;
}

export function parsePage(query: PageQuery = {}): { limit: number; offset: number } {
  const limit = query.limit === undefined ? 50 : Number(query.limit);
  const offset = query.offset === undefined ? 0 : Number(query.offset);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new InvalidInputError('limit must be an integer from 1 to 100');
  if (!Number.isInteger(offset) || offset < 0 || offset > 10_000) throw new InvalidInputError('offset must be an integer from 0 to 10000');
  return { limit, offset };
}

function pgCode(error: unknown): string | undefined {
  const candidate = error as { code?: unknown; cause?: { code?: unknown } };
  const code = candidate?.code ?? candidate?.cause?.code;
  return typeof code === 'string' ? code : undefined;
}

/**
 * Enforces the caller's expected version on a draft that is already authorized and locked.
 * Authorization comes first so a missing or stale precondition never reveals an object.
 */
function requireVersion(draft: typeof schema.drafts.$inferSelect, expected: unknown) {
  if (expected === undefined || expected === null) throw new PreconditionRequiredError();
  if (typeof expected !== 'number' || !Number.isInteger(expected) || expected < 1) throw new InvalidInputError('expectedVersion must be a positive integer');
  if (draft.version !== expected) throw new VersionConflictError(draft.version, toDraft(draft));
}

async function lockWorkspace(tx: Tx, workspaceId: string) {
  if (!isUuid(workspaceId)) return;
  // NO KEY UPDATE serializes membership changes without blocking inserts that only
  // reference the workspace (their foreign-key checks take KEY SHARE).
  await tx.select({ id: schema.workspaces.id }).from(schema.workspaces).where(eq(schema.workspaces.id, workspaceId)).for('no key update');
}

/**
 * Taken before a grant change: conflicts with the `FOR SHARE` lock that mutations hold on
 * the project while they decide (see lockProjectAccess), including for grants that do
 * not exist yet, without blocking inserts that only reference the project.
 */
async function lockProjectForGrantChange(tx: Tx, projectId: string) {
  if (!isUuid(projectId)) return;
  await tx.select({ id: schema.projects.id }).from(schema.projects).where(eq(schema.projects.id, projectId)).for('no key update');
}

function toWorkspace(row: typeof schema.workspaces.$inferSelect, role: WorkspaceRole | null, ai: WorkspaceAiPolicy): Workspace {
  return { id: row.id, name: row.name, role, version: row.version, createdAt: row.createdAt.toISOString(), ai };
}

const MISSING_AI_POLICY: WorkspaceAiPolicy = { state: 'blocked', version: 0, changedAt: new Date(0).toISOString(), changedBy: null };

/**
 * The AI policy of each workspace as its reader sees it (F-029): the state for every member, and who
 * changed it only for a reader with `workspace.read_members` (owners, admins, members; not guests or agents).
 */
async function workspaceAiViews(db: Executor, readers: { workspaceId: string; role: WorkspaceRole | null }[]): Promise<Map<string, WorkspaceAiPolicy>> {
  const ids = [...new Set(readers.map((reader) => reader.workspaceId))];
  if (!ids.length) return new Map();
  const p = schema.workspaceAiPolicies;
  const rows = await db.select({ workspaceId: p.workspaceId, state: p.state, version: p.version, changedAt: p.changedAt,
    changedBy: p.changedBy, changedByName: schema.authUsers.name }).from(p)
    .leftJoin(schema.authUsers, eq(schema.authUsers.id, p.changedBy)).where(inArray(p.workspaceId, ids));
  const byId = new Map(rows.map((row) => [row.workspaceId, row]));
  const views = new Map<string, WorkspaceAiPolicy>();
  for (const { workspaceId, role } of readers) {
    const row = byId.get(workspaceId);
    if (!row) { views.set(workspaceId, MISSING_AI_POLICY); continue; }
    const named = role !== null && role !== 'guest' && row.changedBy !== null && row.changedByName !== null;
    views.set(workspaceId, { state: row.state, version: row.version, changedAt: row.changedAt.toISOString(),
      changedBy: named ? { id: row.changedBy!, name: row.changedByName! } : null });
  }
  return views;
}

function toProject(row: typeof schema.projects.$inferSelect, level: number, goal: Project['goal'] = null): Project {
  const access = accessName(level);
  if (!access) throw new Error('Invisible project serialized');
  return { id: row.id, workspaceId: row.workspaceId, name: row.name, visibility: row.visibility, access, views: row.views as ProjectViewId[], goal, version: row.version, createdAt: row.createdAt.toISOString() };
}

/** The goal each project shows (#520): its current goal, or else its most recently reached one. */
async function shownGoals(db: Executor, projectIds: string[]): Promise<Map<string, Project['goal']>> {
  const rows = await projectGoalRows(db).shown(projectIds);
  return new Map([...rows].map(([id, row]) => [id, presentProjectGoal(row)]));
}

function toGrant(row: typeof schema.projectGrants.$inferSelect): ProjectGrant {
  return {
    id: row.id,
    projectId: row.projectId,
    principal: row.userId ? { kind: 'human', id: row.userId } : { kind: 'agent', id: row.agentId! },
    role: row.role,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
  };
}

function toAgent(row: typeof schema.agents.$inferSelect): Agent {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    name: row.name,
    owner: row.ownerUserId ? { kind: 'human', id: row.ownerUserId } : { kind: 'workspace' },
    revokedAt: row.revokedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

export function toDraft(row: typeof schema.drafts.$inferSelect): Draft {
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

// ---------------------------------------------------------------------------------------
// Workspaces and membership

/** Creates a workspace; the creating person becomes its owner. Agents cannot create workspaces. */
export async function createWorkspace(principal: Principal, command: CreateWorkspaceCommand, db: Database): Promise<Workspace> {
  if (principal.kind !== 'human') throw new ForbiddenError('Only people can create workspaces');
  const workspaceName = name(command?.name);
  const id = randomUUID();
  return db.transaction(async (tx) => {
    const [row] = await tx.insert(schema.workspaces).values({ id, name: workspaceName, createdBy: principal.id }).returning();
    await tx.insert(schema.workspaceMembers).values({ workspaceId: id, userId: principal.id, role: 'owner', createdBy: principal.id });
    await recordEvent(events(tx), principal, id, 'workspace.created.v1', id, {});
    return toWorkspace(row!, 'owner', (await workspaceAiViews(tx, [{ workspaceId: id, role: 'owner' }])).get(id)!);
  });
}

/** Workspaces where the principal is currently active. */
export async function listWorkspaces(principal: Principal, db: Database): Promise<Workspace[]> {
  if (principal.kind === 'human') {
    const rows = await db.select({ workspace: schema.workspaces, role: schema.workspaceMembers.role })
      .from(schema.workspaceMembers)
      .innerJoin(schema.workspaces, eq(schema.workspaces.id, schema.workspaceMembers.workspaceId))
      .where(eq(schema.workspaceMembers.userId, principal.id))
      .orderBy(asc(schema.workspaces.createdAt), asc(schema.workspaces.id));
    const ai = await workspaceAiViews(db, rows.map((row) => ({ workspaceId: row.workspace.id, role: row.role })));
    return rows.map((row) => toWorkspace(row.workspace, row.role, ai.get(row.workspace.id)!));
  }
  if (principal.kind === 'agent' && isUuid(principal.id)) {
    const [agent] = await db.select({ workspaceId: schema.agents.workspaceId }).from(schema.agents).where(eq(schema.agents.id, principal.id));
    if (!agent) return [];
    const { visible } = await evaluateWorkspace(principal, 'workspace.read', agent.workspaceId, db);
    if (!visible) return [];
    const [row] = await db.select().from(schema.workspaces).where(eq(schema.workspaces.id, agent.workspaceId));
    return row ? [toWorkspace(row, null, (await workspaceAiViews(db, [{ workspaceId: row.id, role: null }])).get(row.id)!)] : [];
  }
  return [];
}

export async function getWorkspace(principal: Principal, workspaceId: string, db: Database): Promise<Workspace> {
  const { actor } = enforce(await evaluateWorkspace(principal, 'workspace.read', workspaceId, db), 'workspace');
  const [row] = await db.select().from(schema.workspaces).where(eq(schema.workspaces.id, workspaceId));
  if (!row) throw new NotFoundError('Workspace', 'WORKSPACE_NOT_FOUND');
  return toWorkspace(row, actor.role, (await workspaceAiViews(db, [{ workspaceId: row.id, role: actor.role }])).get(row.id)!);
}

export async function listMembers(principal: Principal, workspaceId: string, db: Database): Promise<WorkspaceMember[]> {
  enforce(await evaluateWorkspace(principal, 'workspace.read_members', workspaceId, db), 'workspace');
  const rows = await db.select({ member: schema.workspaceMembers, email: schema.authUsers.email, name: schema.authUsers.name })
    .from(schema.workspaceMembers)
    .innerJoin(schema.authUsers, eq(schema.authUsers.id, schema.workspaceMembers.userId))
    .where(eq(schema.workspaceMembers.workspaceId, workspaceId))
    .orderBy(asc(schema.workspaceMembers.createdAt), asc(schema.workspaceMembers.userId));
  return rows.map(({ member, email, name: memberName }) => ({ userId: member.userId, email, name: memberName, role: member.role, createdAt: member.createdAt.toISOString() }));
}

async function ownerCount(tx: Tx, workspaceId: string) {
  const [row] = await tx.select({ count: sql<number>`count(*)::int` }).from(schema.workspaceMembers)
    .where(and(eq(schema.workspaceMembers.workspaceId, workspaceId), eq(schema.workspaceMembers.role, 'owner')));
  return row?.count ?? 0;
}

/** Only an owner may create, change or remove another owner; admins manage admins, members and guests. */
function requireRoleAuthority(actor: Actor, ...roles: WorkspaceRole[]) {
  if (roles.includes('owner') && actor.role !== 'owner') throw new ForbiddenError('Only an owner can grant, change or remove the owner role', 'OWNER_REQUIRED');
}

/** Adds an existing account (by id or e-mail) to the workspace with a role. */
export async function addMember(principal: Principal, workspaceId: string, command: AddMemberCommand, db: Database,
  options: { verifiedEmailOnly?: boolean } = {}): Promise<WorkspaceMember> {
  const role = oneOf(command?.role, ROLES, 'role');
  return db.transaction(async (tx) => {
    await lockWorkspace(tx, workspaceId);
    const { actor } = enforce(await evaluateWorkspace(principal, 'workspace.manage_members', workspaceId, tx, { lock: true }), 'workspace');
    requireRoleAuthority(actor, role);
    const lookup = typeof command.userId === 'string' ? eq(schema.authUsers.id, command.userId)
      : typeof command.email === 'string' ? eq(schema.authUsers.email, command.email.trim().toLowerCase()) : null;
    if (!lookup) throw new InvalidInputError('userId or email is required');
    const [user] = await tx.select().from(schema.authUsers).where(lookup);
    // With a sign-on provider, an address nobody has proved is not a way to find a person: the answer is the one
    // for no account at all, so a squatter on an employee's address is never added in their place (#313).
    if (!user || options.verifiedEmailOnly && typeof command.userId !== 'string' && !user.emailVerified) throw new NotFoundError('Account', 'ACCOUNT_NOT_FOUND');
    const inserted = await tx.insert(schema.workspaceMembers).values({ workspaceId, userId: user.id, role, createdBy: principal.id })
      .onConflictDoNothing().returning();
    const member = inserted[0];
    if (!member) throw new ConflictError('Account is already a member', 'ALREADY_MEMBER');
    await recordEvent(events(tx), principal, workspaceId, 'workspace.member_added.v1', workspaceId, { userId: user.id, role });
    return { userId: user.id, email: user.email, name: user.name, role, createdAt: member.createdAt.toISOString() };
  });
}

// ---------------------------------------------------------------------------------------
// The workspace AI lock (F-029, #614, S2): the switch, its flip and the turn-off sweep.

/** The transaction-bound queue the flip sends its sweep job through, so the job commits with the flip or not at all. */
export type WorkspaceAiSweepQueue = (tx: Executor, job: WorkspaceAiSweepJob) => Promise<void>;

/**
 * Turns AI off or on for a whole workspace (owners and admins, `workspace.manage_ai`). One short transaction, the flip:
 * the policy row `FOR UPDATE` first, then the caller's membership under `lock`, the version check, the new state with the
 * next epoch and version, the sweep job (when turning off) and the event last. It touches no AI work row, so it cannot
 * deadlock with a check that holds one and waits for the policy row. Setting the current state again changes nothing.
 * The caller runs the sweep after the commit too ({@link sweepWorkspaceAi}); the job makes sure a crash cannot skip it.
 */
export async function setWorkspaceAiPolicy(principal: Principal, workspaceId: string, command: SetWorkspaceAiPolicyCommand, db: Database,
  queue: WorkspaceAiSweepQueue): Promise<SetWorkspaceAiPolicyResult & { sweep: WorkspaceAiSweepJob | null }> {
  const state = oneOf(command?.state, ['allowed', 'blocked'] as const, 'state');
  return db.transaction(async (tx) => {
    const p = schema.workspaceAiPolicies;
    const [current] = isUuid(workspaceId) ? await tx.select().from(p).where(eq(p.workspaceId, workspaceId)).for('update') : [];
    const decision = await evaluateWorkspace(principal, 'workspace.manage_ai', workspaceId, tx, { lock: true });
    if (!decision.visible || !current) throw new NotFoundError('Workspace', 'WORKSPACE_NOT_FOUND');
    if (!decision.allowed) throw new ForbiddenError('Only workspace owners and admins can turn AI on or off', 'WORKSPACE_AI_ADMIN_REQUIRED');
    const expected = command.expectedVersion;
    if (expected === undefined || expected === null) throw new PreconditionRequiredError();
    if (typeof expected !== 'number' || !Number.isInteger(expected) || expected < 1) throw new InvalidInputError('expectedVersion must be a positive integer');
    const view = async () => (await workspaceAiViews(tx, [{ workspaceId, role: decision.actor.role }])).get(workspaceId)!;
    if (current.version !== expected) throw new VersionConflictError(current.version, await view());
    if (current.state === state) return { ai: await view(), changed: false, stopped: null, sweep: null };
    const [updated] = await tx.update(p).set({ state, epoch: sql`${p.epoch} + 1`, version: sql`${p.version} + 1`, changedBy: principal.id, changedAt: new Date() })
      .where(eq(p.workspaceId, workspaceId)).returning({ epoch: p.epoch });
    const sweep = state === 'blocked' ? { workspaceId, epoch: updated!.epoch } : null;
    if (sweep) await queue(tx, sweep);
    await recordEvent(events(tx), principal, workspaceId, WORKSPACE_AI_POLICY_CHANGED_EVENT, workspaceId, { state });
    return { ai: await view(), changed: true, stopped: null, sweep };
  });
}

/**
 * The turn-off sweep (F-029): ends or stops every AI work item of the workspace admitted under an epoch older than `epoch`,
 * whatever the policy's current state, and tells each run's owner. Idempotent; the API runs it right after the flip and the
 * worker again from the job. Nothing is deleted.
 */
export async function sweepWorkspaceAi(job: WorkspaceAiSweepJob, db: Database): Promise<WorkspaceAiSwept> {
  if (!isUuid(job.workspaceId) || !Number.isSafeInteger(job.epoch) || job.epoch < 1) throw new InvalidInputError('A workspace and an epoch are required');
  const { workspaceId, epoch } = job;
  type Rows = ReturnType<typeof workspaceAiSweepRows>;
  // One transaction per step: a step that fails (a constraint, a lock timeout) cannot roll the others back or stall the cutover.
  const steps: [Exclude<keyof WorkspaceAiSwept, 'failed'>, (rows: Rows, tx: Executor) => Promise<number>][] = [
    ['runs', async (rows, tx) => {
      const ended = await rows.endQueuedRuns(workspaceId, epoch);
      const stopping = await rows.stopInFlightRuns(workspaceId, epoch);
      // The owner's progress events, as for any other end or stop request of a run (events are written last).
      for (const run of [...ended, ...stopping]) {
        await recordEvent(events(tx), { kind: 'human', id: run.ownerUserId }, run.workspaceId, ASSISTANT_RUN_CHANGED_EVENT, run.id, { status: run.status });
        if (run.status === 'stopped') await recordEvent(events(tx), { kind: 'agent', id: run.agentId }, run.workspaceId, ASSISTANT_WORKING_EVENT, run.projectId,
          { conversationId: run.conversationId });
      }
      return ended.length + stopping.length;
    }],
    ['tokens', (rows) => rows.closeRunTokens(workspaceId, epoch)],
    ['comparisons', (rows) => rows.endComparisons(workspaceId, epoch)],
    ['reactions', (rows) => rows.skipReactionEvents(workspaceId, epoch)],
    ['requests', (rows) => rows.cancelRequests(workspaceId, epoch)],
    ['units', (rows) => rows.stopUnits(workspaceId, epoch)],
    ['sessions', (rows) => rows.revokeSessions(workspaceId, epoch)],
  ];
  const swept: WorkspaceAiSwept = { runs: 0, tokens: 0, comparisons: 0, reactions: 0, requests: 0, units: 0, sessions: 0, failed: [] };
  const errors: unknown[] = [];
  for (const [name, step] of steps) {
    try { swept[name] = await db.transaction((tx) => step(workspaceAiSweepRows(tx), tx)); }
    catch (error) { swept.failed.push(name); errors.push(error); }
  }
  if (errors.length) throw new WorkspaceAiSweepIncomplete(swept, errors);
  return swept;
}

/** Some sweep steps failed; the others committed. The worker's job retries the whole (idempotent) sweep. */
export class WorkspaceAiSweepIncomplete extends AggregateError {
  constructor(readonly swept: WorkspaceAiSwept, errors: unknown[]) {
    super(errors, `The AI sweep did not finish: ${swept.failed.join(', ')}`);
    this.name = 'WorkspaceAiSweepIncomplete';
  }
}

export async function changeRole(principal: Principal, workspaceId: string, userId: string, command: ChangeRoleCommand, db: Database): Promise<WorkspaceMember> {
  const role = oneOf(command?.role, ROLES, 'role');
  return db.transaction(async (tx) => {
    // F-029 lock order: the AI policy row before any membership row (the event below reads it again for agent audiences).
    await workspaceAi(tx, workspaceId, { lock: true });
    await lockWorkspace(tx, workspaceId);
    const { actor } = enforce(await evaluateWorkspace(principal, 'workspace.manage_members', workspaceId, tx, { lock: true }), 'workspace');
    const [target] = await tx.select().from(schema.workspaceMembers)
      .where(and(eq(schema.workspaceMembers.workspaceId, workspaceId), eq(schema.workspaceMembers.userId, userId))).for('update');
    if (!target) throw new NotFoundError('Member', 'MEMBER_NOT_FOUND');
    requireRoleAuthority(actor, target.role, role);
    if (target.role === 'owner' && role !== 'owner' && await ownerCount(tx, workspaceId) <= 1) throw new ConflictError('A workspace needs at least one owner', 'LAST_OWNER');
    const [updated] = await tx.update(schema.workspaceMembers).set({ role, updatedAt: new Date() })
      .where(and(eq(schema.workspaceMembers.workspaceId, workspaceId), eq(schema.workspaceMembers.userId, userId))).returning();
    await recordEvent(events(tx), principal, workspaceId, 'workspace.member_role_changed.v1', workspaceId, { userId, from: target.role, role });
    const [user] = await tx.select().from(schema.authUsers).where(eq(schema.authUsers.id, userId));
    return { userId, email: user!.email, name: user!.name, role, createdAt: updated!.createdAt.toISOString() };
  });
}

/**
 * Removes a membership (and, through the database, the member's project grants). Any
 * member may leave; removing someone else needs workspace.manage_members.
 */
export async function removeMember(principal: Principal, workspaceId: string, userId: string, db: Database): Promise<void> {
  await db.transaction(async (tx) => {
    // F-029 lock order: the AI policy row before any membership row.
    await workspaceAi(tx, workspaceId, { lock: true });
    await lockWorkspace(tx, workspaceId);
    const self = principal.kind === 'human' && principal.id === userId;
    const { actor } = enforce(await evaluateWorkspace(principal, self ? 'workspace.read' : 'workspace.manage_members', workspaceId, tx, { lock: true }), 'workspace');
    const [target] = await tx.select().from(schema.workspaceMembers)
      .where(and(eq(schema.workspaceMembers.workspaceId, workspaceId), eq(schema.workspaceMembers.userId, userId))).for('update');
    if (!target) throw new NotFoundError('Member', 'MEMBER_NOT_FOUND');
    if (!self) requireRoleAuthority(actor, target.role);
    if (target.role === 'owner' && await ownerCount(tx, workspaceId) <= 1) throw new ConflictError('A workspace needs at least one owner', 'LAST_OWNER');
    await tx.delete(schema.workspaceMembers).where(and(eq(schema.workspaceMembers.workspaceId, workspaceId), eq(schema.workspaceMembers.userId, userId)));
    await recordEvent(events(tx), principal, workspaceId, 'workspace.member_removed.v1', workspaceId, { userId });
  });
}

// ---------------------------------------------------------------------------------------
// Projects and grants

export async function createProject(principal: Principal, workspaceId: string, command: CreateProjectCommand, db: Database, eventSink?: DomainEventSink): Promise<Project> {
  const projectName = name(command?.name);
  const visibility = command.visibility === undefined ? 'workspace' : oneOf(command.visibility, PROJECT_VISIBILITIES, 'visibility');
  // Without a template (the API, agents, a promoted sketch) a project shows every view, as every project did before (#351).
  const template = command.template === undefined ? null : oneOf(command.template, PROJECT_TEMPLATES, 'template');
  return db.transaction(async (tx) => {
    enforce(await evaluateWorkspace(principal, 'project.create', workspaceId, tx, { lock: true }), 'workspace');
    const id = randomUUID();
    const [row] = await tx.insert(schema.projects).values({ id, workspaceId, name: projectName, visibility, views: [...(template ? TEMPLATE_VIEWS[template] : PROJECT_VIEWS)], createdBy: principal.id }).returning();
    if (eventSink) await eventSink.record(principal, workspaceId, 'project.created.v1', id, { visibility });
    else await recordEvent(events(tx), principal, workspaceId, 'project.created.v1', id, { visibility });
    return toProject(row!, LEVEL.manager);
  });
}

/** Adds an optional view (Map, Wiki or Agents) to a project; whoever can write there may (#351). */
export async function addProjectView(principal: Principal, projectId: string, command: AddProjectViewCommand, db: Database): Promise<Project> {
  const view = oneOf(command?.view, PROJECT_VIEWS, 'view');
  return db.transaction(async (tx) => {
    // The same exclusive project lock a grant change takes, before the read: two additions then queue and
    // the second reads the first's array, instead of both holding FOR SHARE and deadlocking on the update.
    await lockProjectForGrantChange(tx, projectId);
    const { project, level } = enforce(await evaluateProject(principal, 'project.write', projectId, tx, { lock: true }), 'project');
    const goal = (await shownGoals(tx, [projectId])).get(projectId) ?? null;
    if (project!.views.includes(view)) return toProject(project!, level, goal);
    const [row] = await tx.update(schema.projects).set({ views: [...project!.views, view], version: sql`${schema.projects.version} + 1`, updatedAt: new Date() })
      .where(eq(schema.projects.id, projectId)).returning();
    await recordEvent(events(tx), principal, project!.workspaceId, 'project.view_added.v1', projectId, { view });
    return toProject(row!, level, goal);
  });
}

/** Projects the principal can see, filtered before count and pagination. */
export async function listProjects(principal: Principal, workspaceId: string, query: PageQuery, db: Database): Promise<Page<Project>> {
  const page = parsePage(query);
  const { actor } = enforce(await evaluateWorkspace(principal, 'workspace.read', workspaceId, db), 'workspace');
  const filter = visibleProjectsSql(actor);
  const [counted] = await db.select({ count: sql<number>`count(*)::int` }).from(schema.projects).where(filter);
  const rows = await db.select({ project: schema.projects, level: projectLevelSql(actor, schema.projects.id, schema.projects.visibility).mapWith(Number) })
    .from(schema.projects).where(filter)
    .orderBy(asc(schema.projects.createdAt), asc(schema.projects.id))
    .limit(page.limit).offset(page.offset);
  const goals = await shownGoals(db, rows.map((row) => row.project.id));
  return { items: rows.map((row) => toProject(row.project, row.level, goals.get(row.project.id) ?? null)), total: counted?.count ?? 0, ...page };
}

export async function getProject(principal: Principal, projectId: string, db: Database): Promise<Project> {
  const { project, level } = enforce(await evaluateProject(principal, 'project.read', projectId, db), 'project');
  return toProject(project!, level, (await shownGoals(db, [projectId])).get(projectId) ?? null);
}

export async function listProjectGrants(principal: Principal, projectId: string, db: Database): Promise<ProjectGrant[]> {
  enforce(await evaluateProject(principal, 'project.manage', projectId, db), 'project');
  const rows = await db.select().from(schema.projectGrants).where(and(eq(schema.projectGrants.projectId, projectId), sql`(${schema.projectGrants.agentId} is null or ${visibleAgentIdentity(principal, projectId, sql`${schema.projectGrants.agentId}`)})`))
    .orderBy(asc(schema.projectGrants.createdAt), asc(schema.projectGrants.id));
  return rows.map(toGrant);
}

/**
 * The audience of a project (#117): every person and agent who can read it now. The caller
 * needs `project.read`. Each candidate's level is decided by the access policy itself
 * (`evaluateProject`), never re-derived here, so a deny, a revoked agent or a removed
 * member is left out exactly as on their own next request. The candidates are the
 * workspace's members and agents; a project that nobody else can read lists only its managers.
 */
/** Personal assistant identities are private discovery state; shared message attribution is separate (#522). */
function visibleAgentIdentity(principal: Principal, projectId?: string, agentId: SQL = sql`${schema.agents.id}`): SQL {
  const assistant = schema.assistantSettings, connection = schema.agentConnections, selection = schema.agentConnectionProjects;
  return sql`(not exists (select 1 from ${assistant} where ${assistant.agentId} = ${agentId}
    and ${principal.kind === 'human' ? sql`${assistant.ownerUserId} <> ${principal.id}` : sql`true`})
    or exists (select 1 from ${connection} inner join ${selection} on ${selection.connectionId} = ${connection.id}
      where ${connection.agentId} = ${agentId} and ${connection.computeSource} <> 'owner_assistant'
      and ${connection.revokedAt} is null ${projectId ? sql`and ${selection.projectId} = ${projectId}` : sql``}))`;
}

export async function listProjectPeople(principal: Principal, projectId: string, db: Database): Promise<ProjectPerson[]> {
  const { project } = enforce(await evaluateProject(principal, 'project.read', projectId, db), 'project');
  const workspaceId = project!.workspaceId;
  const humans = await db.select({ id: schema.workspaceMembers.userId, name: schema.authUsers.name })
    .from(schema.workspaceMembers)
    .innerJoin(schema.authUsers, eq(schema.authUsers.id, schema.workspaceMembers.userId))
    .where(eq(schema.workspaceMembers.workspaceId, workspaceId));
  const agents = await db.select({ id: schema.agents.id, name: schema.agents.name, ownerUserId: schema.agents.ownerUserId }).from(schema.agents)
    .where(and(eq(schema.agents.workspaceId, workspaceId), isNull(schema.agents.revokedAt), visibleAgentIdentity(principal, projectId)));
  const candidates = [
    ...humans.map((row) => ({ kind: 'human' as const, id: row.id, name: row.name })),
    ...agents.map((row) => ({ kind: 'agent' as const, id: row.id, name: row.name })),
  ];
  const people: ProjectPerson[] = [];
  for (const candidate of candidates) {
    const decision = await evaluateProject({ kind: candidate.kind, id: candidate.id }, 'project.read', projectId, db);
    const access = decision.allowed ? accessName(decision.level) : null;
    if (access) people.push({ ...candidate, access });
  }
  // Owner names reuse the authorized audience, never the workspace candidate roster.
  const visibleHumans = new Map(people.filter((person) => person.kind === 'human').map((person) => [person.id, person.name]));
  for (const person of people) {
    if (person.kind !== 'agent') continue;
    const agent = agents.find((candidate) => candidate.id === person.id)!;
    if (!agent.ownerUserId) person.agentOwner = { kind: 'workspace' };
    else {
      const name = visibleHumans.get(agent.ownerUserId);
      if (name) person.agentOwner = { kind: 'human', id: agent.ownerUserId, name };
    }
  }
  return people.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) || a.id.localeCompare(b.id) : a.kind === 'human' ? -1 : 1));
}

/**
 * Creates or replaces the grant of one principal on a project. A human grantee must be
 * a member of the project's workspace; an agent must belong to it and not be revoked.
 * Grants that affect an owner need an owner.
 */
export async function grantProject(principal: Principal, projectId: string, command: GrantProjectCommand, db: Database, eventSink?: DomainEventSink): Promise<ProjectGrant> {
  const role = oneOf(command?.role, GRANT_ROLES, 'role');
  const target = command.principal;
  if (!target || (target.kind !== 'human' && target.kind !== 'agent') || typeof target.id !== 'string' || !target.id) throw new InvalidInputError('principal must be { kind: "human" | "agent", id }');
  return db.transaction(async (tx) => {
    await lockProjectForGrantChange(tx, projectId);
    const { actor, project } = enforce(await evaluateProject(principal, 'project.manage', projectId, tx, { lock: true }), 'project');
    const workspaceId = project!.workspaceId;
    if (target.kind === 'human') {
      const [member] = await tx.select().from(schema.workspaceMembers)
        .where(and(eq(schema.workspaceMembers.workspaceId, workspaceId), eq(schema.workspaceMembers.userId, target.id)));
      if (!member) throw new RuleViolationError('Grants can only name members of the project workspace', 'NOT_A_MEMBER');
      if (member.role === 'owner') requireRoleAuthority(actor!, 'owner');
    } else {
      const [agent] = isUuid(target.id) ? await tx.select().from(schema.agents)
        .where(and(eq(schema.agents.id, target.id), eq(schema.agents.workspaceId, workspaceId), isNull(schema.agents.revokedAt))) : [];
      if (!agent) throw new RuleViolationError('Grants can only name active agents of the project workspace', 'AGENT_NOT_IN_WORKSPACE');
    }
    const principalColumn = target.kind === 'human' ? schema.projectGrants.userId : schema.projectGrants.agentId;
    const [existing] = await tx.select().from(schema.projectGrants)
      .where(and(eq(schema.projectGrants.projectId, projectId), eq(principalColumn, target.id))).for('update');
    let row: typeof schema.projectGrants.$inferSelect | undefined;
    try {
      if (existing) {
        [row] = await tx.update(schema.projectGrants).set({ role, createdBy: principal.id, updatedAt: new Date() })
          .where(eq(schema.projectGrants.id, existing.id)).returning();
      } else {
        [row] = await tx.insert(schema.projectGrants).values({
          id: randomUUID(), workspaceId, projectId, role, createdBy: principal.id,
          userId: target.kind === 'human' ? target.id : null,
          agentId: target.kind === 'agent' ? target.id : null,
        }).returning();
      }
    } catch (error) {
      if (pgCode(error) === '23505') throw new ConflictError('A concurrent grant for this principal was created', 'GRANT_CONFLICT');
      // The composite foreign key rejects a grantee whose membership was removed concurrently.
      if (pgCode(error) === '23503') throw new ConflictError('The grantee is no longer part of the workspace', 'GRANTEE_REMOVED');
      throw error;
    }
    const event = { grantId: row!.id, principal: target, role };
    if (eventSink) await eventSink.record(principal, workspaceId, 'project.grant_set.v1', projectId, event);
    else await recordEvent(events(tx), principal, workspaceId, 'project.grant_set.v1', projectId, event);
    return toGrant(row!);
  });
}

export async function revokeProjectGrant(principal: Principal, projectId: string, grantId: string, db: Database): Promise<void> {
  await db.transaction(async (tx) => {
    await lockProjectForGrantChange(tx, projectId);
    const { actor, project } = enforce(await evaluateProject(principal, 'project.manage', projectId, tx, { lock: true }), 'project');
    const [grant] = isUuid(grantId) ? await tx.select().from(schema.projectGrants)
      .where(and(eq(schema.projectGrants.id, grantId), eq(schema.projectGrants.projectId, projectId))).for('update') : [];
    if (!grant) throw new NotFoundError('Grant', 'GRANT_NOT_FOUND');
    if (grant.userId) {
      const [member] = await tx.select({ role: schema.workspaceMembers.role }).from(schema.workspaceMembers)
        .where(and(eq(schema.workspaceMembers.workspaceId, project!.workspaceId), eq(schema.workspaceMembers.userId, grant.userId)));
      if (member?.role === 'owner') requireRoleAuthority(actor!, 'owner');
    }
    await tx.delete(schema.projectGrants).where(eq(schema.projectGrants.id, grantId));
    await recordEvent(events(tx), principal, project!.workspaceId, 'project.grant_revoked.v1', projectId, { grantId });
  });
}

// ---------------------------------------------------------------------------------------
// Agents (identities only; agent authentication is a later task)

export async function createAgent(principal: Principal, workspaceId: string, command: CreateAgentCommand, db: Database): Promise<Agent> {
  const agentName = name(command?.name);
  const owner = oneOf(command.owner, ['self', 'workspace'] as const, 'owner');
  return db.transaction(async (tx) => {
    enforce(await evaluateWorkspace(principal, owner === 'self' ? 'agent.create' : 'workspace.manage_agents', workspaceId, tx, { lock: true }), 'workspace');
    // F-029: no new agent identity while AI is off in the workspace (revoking and listing stay).
    await requireWorkspaceAi(tx, workspaceId, { lock: true });
    const id = randomUUID();
    const [row] = await tx.insert(schema.agents).values({ id, workspaceId, name: agentName, ownerUserId: owner === 'self' ? principal.id : null, createdBy: principal.id }).returning();
    await recordEvent(events(tx), principal, workspaceId, 'agent.created.v1', id, { owner });
    return toAgent(row!);
  });
}

export async function listAgents(principal: Principal, workspaceId: string, db: Database): Promise<Agent[]> {
  enforce(await evaluateWorkspace(principal, 'workspace.read_members', workspaceId, db), 'workspace');
  const rows = await db.select().from(schema.agents).where(and(eq(schema.agents.workspaceId, workspaceId), visibleAgentIdentity(principal)))
    .orderBy(asc(schema.agents.createdAt), asc(schema.agents.id));
  return rows.map(toAgent);
}

/** Revokes an agent identity; its grants stop applying on the next call. The owner or a workspace owner/admin may revoke. */
export async function revokeAgent(principal: Principal, agentId: string, db: Database): Promise<Agent> {
  return db.transaction(async (tx) => {
    const { agent } = enforce(await evaluateAgent(principal, 'agent.revoke', agentId, tx, { lock: true }), 'agent');
    const [row] = await tx.update(schema.agents).set({ revokedAt: agent!.revokedAt ?? new Date(), updatedAt: new Date() })
      .where(eq(schema.agents.id, agentId)).returning();
    await recordEvent(events(tx), principal, agent!.workspaceId, 'agent.revoked.v1', agentId, {});
    return toAgent(row!);
  });
}

// ---------------------------------------------------------------------------------------
// Drafts

/**
 * Resolves a target project for a draft in `workspaceId`: it must be in the same
 * workspace and writable by the principal. A project the caller can see in another
 * workspace is a rule violation; an invisible one is reported as not found.
 */
async function requireTargetProject(principal: Principal, workspaceId: string, projectId: unknown, tx: Tx) {
  if (!isUuid(projectId)) throw new NotFoundError('Project', 'PROJECT_NOT_FOUND');
  const evaluation = await evaluateProject(principal, 'project.write', projectId, tx, { lock: true });
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

async function projectOf(tx: Tx, projectId: string | null) {
  if (!projectId) return null;
  const [row] = await tx.select().from(schema.projects).where(eq(schema.projects.id, projectId));
  return row ?? null;
}

/**
 * Creates a draft that is private to its author inside a writable project. People may
 * omit the project; an agent must name a project where it currently is a contributor.
 */
export async function createDraft(principal: Principal, workspaceId: string, command: CreateDraftCommand, db: Database): Promise<Draft> {
  const title = name(command?.title, 'Title');
  const text = body(command.body);
  return db.transaction(async (tx) => {
    enforce(await evaluateWorkspace(principal, 'draft.create', workspaceId, tx, { lock: true }), 'workspace');
    if (principal.kind === 'agent' && (command.projectId === undefined || command.projectId === null)) {
      throw new RuleViolationError('An agent can only create drafts inside a project it contributes to', 'PROJECT_REQUIRED');
    }
    const projectId = command.projectId === undefined || command.projectId === null ? null
      : (await requireTargetProject(principal, workspaceId, command.projectId, tx)).id;
    const id = randomUUID();
    const [row] = await tx.insert(schema.drafts).values({
      id, workspaceId, projectId, title, body: text, visibility: 'private', createdBy: principal.id,
      ownerUserId: principal.kind === 'human' ? principal.id : null,
      ownerAgentId: principal.kind === 'agent' ? principal.id : null,
    }).returning();
    await recordEvent(events(tx), principal, workspaceId, 'draft.created.v1', id, { projectId, visibility: 'private' });
    return toDraft(row!);
  });
}

export async function getDraft(principal: Principal, draftId: string, db: Database): Promise<Draft> {
  const { draft } = enforce(await evaluateDraft(principal, 'draft.read', draftId, db), 'draft');
  return toDraft(draft!);
}

/** Drafts the principal can read, filtered before count and pagination. */
export async function listDrafts(principal: Principal, workspaceId: string, query: DraftListQuery, db: Database): Promise<Page<Draft>> {
  const page = parsePage(query);
  const { actor } = enforce(await evaluateWorkspace(principal, 'workspace.read', workspaceId, db), 'workspace');
  const conditions: SQL[] = [visibleDraftsSql(actor)];
  if (query.projectId !== undefined) {
    if (!isUuid(query.projectId)) throw new InvalidInputError('projectId must be a UUID');
    conditions.push(eq(schema.drafts.projectId, query.projectId));
  }
  const filter = and(...conditions);
  const [counted] = await db.select({ count: sql<number>`count(*)::int` }).from(schema.drafts).where(filter);
  const rows = await db.select().from(schema.drafts).where(filter)
    .orderBy(desc(schema.drafts.createdAt), desc(schema.drafts.id))
    .limit(page.limit).offset(page.offset);
  return { items: rows.map(toDraft), total: counted?.count ?? 0, ...page };
}

export async function updateDraft(principal: Principal, draftId: string, command: UpdateDraftCommand, db: Database): Promise<Draft> {
  const changes: { title?: string; body?: string } = {};
  if (command?.title !== undefined) changes.title = name(command.title, 'Title');
  if (command?.body !== undefined) changes.body = body(command.body);
  if (!Object.keys(changes).length) throw new InvalidInputError('Nothing to update');
  return db.transaction(async (tx) => {
    const { draft } = enforce(await evaluateDraft(principal, 'draft.write', draftId, tx, { lock: true }), 'draft');
    requireVersion(draft!, command.expectedVersion);
    const [row] = await tx.update(schema.drafts).set({ ...changes, version: sql`${schema.drafts.version} + 1`, updatedAt: new Date() })
      .where(eq(schema.drafts.id, draftId)).returning();
    await recordEvent(events(tx), principal, draft!.workspaceId, 'draft.updated.v1', draftId, { version: row!.version });
    return toDraft(row!);
  });
}

/**
 * Changes a draft's audience: `project` (its own or a named project in the same
 * workspace), `workspace`, or back to `private`.
 */
export async function shareDraft(principal: Principal, draftId: string, command: ShareDraftCommand, db: Database): Promise<Draft> {
  const scope = oneOf(command?.scope, DRAFT_VISIBILITIES, 'scope');
  return db.transaction(async (tx) => {
    const { actor, draft } = enforce(await evaluateDraft(principal, 'draft.share', draftId, tx, { lock: true }), 'draft');
    requireVersion(draft!, command.expectedVersion);
    let projectId = draft!.projectId;
    if (command.projectId !== undefined && command.projectId !== draft!.projectId) {
      if (scope !== 'project') throw new InvalidInputError('projectId applies only to project scope; use move to change the project');
      projectId = (await requireTargetProject(principal, draft!.workspaceId, command.projectId, tx)).id;
    } else if (scope === 'project' && projectId) {
      await requireTargetProject(principal, draft!.workspaceId, projectId, tx);
    }
    requireAudience(actor!, scope, await projectOf(tx, projectId));
    const [row] = await tx.update(schema.drafts).set({ projectId, visibility: scope, version: sql`${schema.drafts.version} + 1`, updatedAt: new Date() })
      .where(eq(schema.drafts.id, draftId)).returning();
    await recordEvent(events(tx), principal, draft!.workspaceId, 'draft.shared.v1', draftId, { from: draft!.visibility, visibility: scope, projectId });
    return toDraft(row!);
  });
}

/**
 * Moves a draft to another project of the same workspace (or out of any project). The
 * caller states the resulting visibility, so a move never silently widens the audience.
 * Moving to another workspace is rejected; that needs a later copy command.
 */
export async function moveDraft(principal: Principal, draftId: string, command: MoveDraftCommand, db: Database): Promise<Draft> {
  const visibility = oneOf(command?.visibility, DRAFT_VISIBILITIES, 'visibility');
  if (command.projectId !== null && typeof command.projectId !== 'string') throw new InvalidInputError('projectId must be a project id or null');
  return db.transaction(async (tx) => {
    const { actor, draft } = enforce(await evaluateDraft(principal, 'draft.move', draftId, tx, { lock: true }), 'draft');
    requireVersion(draft!, command.expectedVersion);
    if (principal.kind === 'agent' && command.projectId === null) {
      throw new RuleViolationError('An agent cannot move a draft outside every project', 'PROJECT_REQUIRED');
    }
    const target = command.projectId === null ? null : await requireTargetProject(principal, draft!.workspaceId, command.projectId, tx);
    requireAudience(actor!, visibility, target);
    const [row] = await tx.update(schema.drafts).set({ projectId: target?.id ?? null, visibility, version: sql`${schema.drafts.version} + 1`, updatedAt: new Date() })
      .where(eq(schema.drafts.id, draftId)).returning();
    await recordEvent(events(tx), principal, draft!.workspaceId, 'draft.moved.v1', draftId, { from: draft!.projectId, projectId: target?.id ?? null, visibility });
    return toDraft(row!);
  });
}

