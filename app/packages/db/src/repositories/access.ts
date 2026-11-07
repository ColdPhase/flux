import { and, eq, or, sql, type SQL, type SQLWrapper } from 'drizzle-orm';
import type { WorkspaceRole } from '@flux/contracts';
import * as schema from '../schema.js';
import type { DbExecutor } from './push.js';
import { openRow, sealOf } from '../sealing.js';
import { keyGate } from './workspace-encryption.js';

/**
 * The SQL side of the access policy (issues #46, #90). `packages/core/src/access/policy.ts` decides
 * (who may do what, from facts about the actor and the object); this module reads those facts and builds
 * the list conditions, and makes no decision of its own beyond the actor's standing. It satisfies core's
 * `AccessReader` port structurally (this package does not depend on core), so the shapes below mirror
 * core's `Principal`, `Actor` and `SpaceAi`; a mismatch fails to compile where an app passes
 * `accessReader(tx)` to a core function.
 *
 * Every statement here was moved from core's policy: the same locks and the same order of statements inside
 * one method. An agent's level is exactly its owner's (F-036 AG-3, #855): agents have no grants of their own.
 * The order between methods is core's (the evaluators call them in the order documented there). Bind it to
 * the transaction that decides, so a `lock` holds until that transaction commits.
 */

/** Core's `Principal`. */
export interface AccessPrincipal {
  id: string;
  kind: 'fixture' | 'human' | 'agent';
}

/** Core's `Actor`: current facts about one principal in one workspace. */
export interface AccessActor {
  principal: AccessPrincipal;
  workspaceId: string;
  role: WorkspaceRole | null;
  agent: { ownerUserId: string; ownerRole: WorkspaceRole | null } | null;
  active: boolean;
}

/** Core's `SpaceAi`: the AI switch of one space as a check reads it (F-029, #614, AG-10). */
export interface AccessSpaceAi {
  state: 'allowed' | 'blocked';
  epoch: number;
}

/** Core's `LoadOptions`. */
export interface AccessLoadOptions {
  lock?: boolean;
}

// The project access levels the SQL expressions produce; core's `LEVEL` is the same scale.
const LEVEL = { none: 0, contributor: 1, manager: 2 } as const;
// Literals, not parameters: a bare `$n` in a CASE branch has no type for PostgreSQL to infer.
const MANAGER_SQL = sql.raw(String(LEVEL.manager));
const CONTRIBUTOR_SQL = sql.raw(String(LEVEL.contributor));
const MANAGER_ROLES: readonly WorkspaceRole[] = ['owner', 'admin'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NO_AI_POLICY: AccessSpaceAi = { state: 'blocked', epoch: 0 };

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value);
}

function isManager(role: WorkspaceRole | null) {
  return role !== null && MANAGER_ROLES.includes(role);
}

/**
 * The space's AI switch, read fresh (never cached). With `lock` the row is taken `FOR SHARE`, so the decision is ordered
 * strictly before or after a change, which takes `FOR UPDATE`. A missing row reads as blocked (fail closed).
 */
export async function spaceAi(db: DbExecutor, projectId: string, options: { lock?: boolean } = {}): Promise<AccessSpaceAi> {
  if (!isUuid(projectId)) return NO_AI_POLICY;
  const p = schema.projectAiPolicies;
  const query = db.select({ state: p.state, epoch: p.epoch }).from(p).where(eq(p.projectId, projectId));
  const [row] = options.lock ? await query.for('share') : await query;
  return row ?? NO_AI_POLICY;
}

/**
 * Locks the project row and every grant row that can contribute to the actor's level on
 * it (`FOR SHARE`): a person's own grant, or an agent's owner's grant. Grant and revoke take
 * `FOR NO KEY UPDATE` on the project row first and `FOR UPDATE` (or DELETE) on the grant row,
 * so they conflict with these locks: whichever transaction locks first finishes before the other decides.
 */
async function lockProjectAccess(db: DbExecutor, actor: AccessActor, projectId: string): Promise<void> {
  if (!isUuid(projectId)) return;
  // An agent works in a space only while its AI switch is on (AG-10): the policy row is held `FOR SHARE`, so a decision is
  // ordered strictly before or after a flip, which takes it `FOR UPDATE`.
  if (actor.principal.kind === 'agent') await spaceAi(db, projectId, { lock: true });
  // F-030 S2c (delta review P2-A): in an encrypted workspace a write takes the fair key gate before its first row lock,
  // so a rotation's drain (under the exclusive gate) never waits for a project row a writer holds while it queues for
  // the gate, and the project row cannot be skipped forever under load.
  const [located] = (await db.execute<{ workspace_id: string; encrypted: boolean }>(sql`SELECT p.workspace_id, w.encrypted FROM projects p
    JOIN workspaces w ON w.id = p.workspace_id WHERE p.id = ${projectId}`)).rows;
  if (located?.encrypted) await keyGate(db, located.workspace_id, 'shared');
  await db.execute(sql`SELECT 1 FROM projects WHERE id = ${projectId} FOR SHARE`);
  const holder = actor.principal.kind === 'human' && isUuid(actor.principal.id) ? actor.principal.id
    : actor.principal.kind === 'agent' && isUuid(actor.principal.id) ? actor.agent?.ownerUserId ?? null : null;
  if (!holder) return;
  await db.execute(sql`SELECT g.id FROM project_grants g WHERE g.project_id = ${projectId} AND g.user_id = ${holder} ORDER BY g.id FOR SHARE`);
}

async function memberRole(db: DbExecutor, workspaceId: string, userId: string, lock: boolean): Promise<WorkspaceRole | null> {
  const query = db.select({ role: schema.workspaceMembers.role }).from(schema.workspaceMembers)
    .where(and(eq(schema.workspaceMembers.workspaceId, workspaceId), eq(schema.workspaceMembers.userId, userId)));
  const rows = lock ? await query.for('share') : await query;
  return rows[0]?.role ?? null;
}

/** Reads the principal's current standing in a workspace. Never cached. */
export async function loadActor(principal: AccessPrincipal, workspaceId: string, db: DbExecutor, options: AccessLoadOptions = {}): Promise<AccessActor> {
  const lock = options.lock ?? false;
  const inactive: AccessActor = { principal, workspaceId, role: null, agent: null, active: false };
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
    // An agent acts only while its owner is a company member, with exactly the owner's rights (F-036 AG-3). A guest has no AI (AG-2).
    const ownerRole = await memberRole(db, workspaceId, agent.ownerUserId, lock);
    return { ...inactive, agent: { ownerUserId: agent.ownerUserId, ownerRole }, active: ownerRole !== null && ownerRole !== 'guest' };
  }
  return inactive;
}

function grantExists(userId: string, projectId: SQLWrapper, role: 'manager' | 'contributor'): SQL {
  return sql`EXISTS (SELECT 1 FROM project_grants g WHERE g.project_id = ${projectId} AND g.user_id = ${userId} AND g.role = ${role})`;
}

function humanLevel(userId: string, role: WorkspaceRole | null, projectId: SQLWrapper, visibility: SQLWrapper): SQL {
  if (!role) return sql`0`;
  // A company owner or admin reaches every space as its manager, whatever grants they hold: nothing keeps them out (#903).
  if (isManager(role)) return sql`${MANAGER_SQL}`;
  const implicit = role === 'member' ? sql` WHEN ${visibility} = 'workspace' THEN ${CONTRIBUTOR_SQL}` : sql``;
  // F-037: a space admin's `manager` grant gives the manager level, a space member's `contributor` grant the contributor level.
  return sql`(CASE WHEN ${grantExists(userId, projectId, 'manager')} THEN ${MANAGER_SQL} WHEN ${grantExists(userId, projectId, 'contributor')} THEN ${CONTRIBUTOR_SQL}${implicit} ELSE 0 END)`;
}

/**
 * SQL expression for the actor's access level (0–2) to the project identified by
 * `projectId` whose visibility column/expression is `visibility`. Composable into lists.
 * An agent's level is its owner's current level, never more and never less (F-036 AG-3).
 */
export function projectLevelSql(actor: AccessActor, projectId: SQLWrapper, visibility: SQLWrapper): SQL {
  if (!actor.active) return sql`0`;
  if (actor.principal.kind === 'human') return humanLevel(actor.principal.id, actor.role, projectId, visibility);
  if (!actor.agent) return sql`0`;
  const level = humanLevel(actor.agent.ownerUserId, actor.agent.ownerRole, projectId, visibility);
  // F-037, AG-10: no agent reads or acts in a space whose AI is off, whatever its owner may do there.
  return sql`(CASE WHEN EXISTS (SELECT 1 FROM project_ai_policies ai WHERE ai.project_id = ${projectId} AND ai.state = 'allowed') THEN ${level} ELSE 0 END)`;
}

/** Whether the actor belongs to the space, not only reaches it: a company owner or admin without a grant does not (F-037). */
export function projectMemberSql(actor: AccessActor, projectId: SQLWrapper, visibility: SQLWrapper): SQL {
  if (actor.principal.kind !== 'human' || !actor.active) return sql`true`;
  const everyone = actor.role === 'guest' ? sql`false` : sql`${visibility} = 'workspace'`;
  // Nested: Drizzle would write a column at the top level of a selected expression without its table, and `id` here would mean the grant's.
  const added = sql`EXISTS (SELECT 1 FROM project_grants g WHERE g.project_id = ${projectId} AND g.user_id = ${actor.principal.id})`;
  return sql`(${everyone} OR ${added})`;
}

const draftProjectVisibility = sql`(SELECT p.visibility FROM projects p WHERE p.id = ${schema.drafts.projectId})`;

function draftProjectLevel(actor: AccessActor): SQL {
  return sql`(CASE WHEN ${schema.drafts.projectId} IS NULL THEN 0 ELSE ${projectLevelSql(actor, schema.drafts.projectId, draftProjectVisibility)} END)`;
}

function isDraftOwner(actor: AccessActor): SQL {
  return actor.principal.kind === 'agent' ? eq(schema.drafts.ownerAgentId, actor.principal.id) : eq(schema.drafts.ownerUserId, actor.principal.id);
}

/** Condition over `projects` rows: the project is in the actor's workspace and at least viewable. */
export function visibleProjectsSql(actor: AccessActor): SQL {
  if (!actor.active) return sql`false`;
  return and(eq(schema.projects.workspaceId, actor.workspaceId), sql`${projectLevelSql(actor, schema.projects.id, schema.projects.visibility)} >= 1`)!;
}

/** Condition over `drafts` rows: the actor may read the draft. Apply before count/limit. */
export function visibleDraftsSql(actor: AccessActor): SQL {
  if (!actor.active) return sql`false`;
  const d = schema.drafts;
  if (actor.principal.kind === 'agent') {
    // An agent reads only inside its owner's current project access, including its own drafts.
    // The owner's deny or lost access yields level 0, so no separate deny clause is needed.
    return and(eq(d.workspaceId, actor.workspaceId), sql`${draftProjectLevel(actor)} >= 1`,
      or(isDraftOwner(actor), sql`${d.visibility} = 'project'`))!;
  }
  const audiences: SQL[] = [isDraftOwner(actor), sql`(${d.visibility} = 'project' AND ${draftProjectLevel(actor)} >= 1)`];
  if (actor.principal.kind === 'human' && actor.role !== 'guest') audiences.push(sql`${d.visibility} = 'workspace'`);
  return and(eq(d.workspaceId, actor.workspaceId), or(...audiences))!;
}

const sketchProjectVisibility = sql`(SELECT p.visibility FROM projects p WHERE p.id = ${schema.sketches.projectId})`;

function sketchProjectLevel(actor: AccessActor): SQL {
  return sql`(CASE WHEN ${schema.sketches.projectId} IS NULL THEN 0 ELSE ${projectLevelSql(actor, schema.sketches.projectId, sketchProjectVisibility)} END)`;
}

/** Condition over `sketches` rows: the actor may read the sketch. Apply before count/limit. */
export function visibleSketchesSql(actor: AccessActor): SQL {
  if (!actor.active) return sql`false`;
  const s = schema.sketches;
  const project = sql`(${s.scope} = 'project' AND ${sketchProjectLevel(actor)} >= 1)`;
  // Agents never see private sketches, not even their owner's.
  if (actor.principal.kind !== 'human') return and(eq(s.workspaceId, actor.workspaceId), project)!;
  const own = sql`(${s.scope} = 'private' AND ${s.createdByUserId} = ${actor.principal.id})`;
  // A DM sketch is visible to the DM's current participants only (#96). Qualified by hand:
  // Drizzle leaves columns of a single-table select unqualified, and an unqualified `dm_id`
  // inside this subquery would name dm_participants.dm_id.
  const dm = sql`(${s.scope} = 'dm' AND EXISTS (SELECT 1 FROM dm_participants dp WHERE dp.dm_id = "sketches"."dm_id" AND dp.user_id = ${actor.principal.id}))`;
  return and(eq(s.workspaceId, actor.workspaceId), or(project, own, dm))!;
}

/**
 * Condition over `dms` rows: the actor is a current participant. Workspace roles add nothing:
 * owners and admins see only the DMs they are in. Agents see none (no participant grants yet).
 */
export function visibleDmsSql(actor: AccessActor): SQL {
  if (!actor.active || actor.principal.kind !== 'human') return sql`false`;
  const d = schema.dms;
  return and(eq(d.workspaceId, actor.workspaceId),
    sql`EXISTS (SELECT 1 FROM dm_participants dp WHERE dp.dm_id = "dms"."id" AND dp.user_id = ${actor.principal.id})`)!;
}

/**
 * The list filter for a principal in a workspace. Put it in the WHERE clause of the list
 * query and of its count so invisible rows never reach counts, pages or payloads.
 */
export async function visibleFilter(principal: AccessPrincipal, workspaceId: string, kind: 'project' | 'draft' | 'sketch' | 'dm', db: DbExecutor): Promise<SQL> {
  const actor = await loadActor(principal, workspaceId, db);
  if (kind === 'sketch') return visibleSketchesSql(actor);
  if (kind === 'dm') return visibleDmsSql(actor);
  return kind === 'project' ? visibleProjectsSql(actor) : visibleDraftsSql(actor);
}

/**
 * `visibleFilter` limited to the spaces the person belongs to (F-037, coordinator default, #874): search, the Inbox and Needs you
 * show a company owner or admin only what is in spaces they were added to, though they can reach every other space (Settings ›
 * Company lists those). Drafts and sketches outside any space are unchanged; direct messages are not spaces.
 */
export async function memberFilter(principal: AccessPrincipal, workspaceId: string, kind: 'project' | 'draft' | 'sketch', db: DbExecutor): Promise<SQL> {
  const base = await visibleFilter(principal, workspaceId, kind, db);
  if (principal.kind !== 'human') return base;
  const actor = await loadActor(principal, workspaceId, db);
  if (kind === 'project') return and(base, projectMemberSql(actor, schema.projects.id, schema.projects.visibility))!;
  if (kind === 'draft') return and(base, sql`(${schema.drafts.projectId} IS NULL OR ${projectMemberSql(actor, schema.drafts.projectId, draftProjectVisibility)})`)!;
  return and(base, sql`(${schema.sketches.scope} <> 'project' OR ${projectMemberSql(actor, schema.sketches.projectId, sketchProjectVisibility)})`)!;
}

/**
 * Core's `AccessReader` over one executor. One method is one statement (or the single guarded
 * statement pair of `lockProjectAccess`); core's evaluators call them in the documented lock order.
 * The rows it returns are whole table rows, so core's evaluations carry them to callers unchanged.
 */
export function accessReader(db: DbExecutor) {
  return {
    spaceAi: (projectId: string, options: { lock?: boolean } = {}) => spaceAi(db, projectId, options),
    loadActor: (principal: AccessPrincipal, workspaceId: string, options: AccessLoadOptions = {}) => loadActor(principal, workspaceId, db, options),

    /** `draft.create` for an agent: some project of its workspace where it is a contributor now. */
    async hasWritableProject(actor: AccessActor): Promise<boolean> {
      const rows = await db.select({ id: schema.projects.id }).from(schema.projects)
        .where(and(eq(schema.projects.workspaceId, actor.workspaceId), sql`${projectLevelSql(actor, schema.projects.id, schema.projects.visibility)} >= ${LEVEL.contributor}`))
        .limit(1);
      return rows.length > 0;
    },

    async locateProject(projectId: string) {
      const [located] = await db.select({ workspaceId: schema.projects.workspaceId }).from(schema.projects).where(eq(schema.projects.id, projectId));
      return located ?? null;
    },
    lockProjectAccess: (actor: AccessActor, projectId: string) => lockProjectAccess(db, actor, projectId),
    async readProject(actor: AccessActor, projectId: string) {
      const [row] = await db.select({ project: schema.projects, level: projectLevelSql(actor, schema.projects.id, schema.projects.visibility).mapWith(Number) })
        .from(schema.projects).where(eq(schema.projects.id, projectId));
      // Reached only for an active member (core loads the actor first), so only a member learns a lock (423).
      return row ? { ...row, project: openRow('projects', row.project, await sealOf(db, row.project.workspaceId, { write: false })) } : null;
    },
    /** `FOR SHARE` on the project row alone (the promotion scope, before the sketch is evaluated). */
    async lockProjectForShare(projectId: string) {
      await db.select({ id: schema.projects.id }).from(schema.projects).where(eq(schema.projects.id, projectId)).for('share');
    },
    /** `FOR SHARE` on the workspace row (member added, removed or re-roled take it `FOR NO KEY UPDATE`). */
    async lockWorkspaceForShare(workspaceId: string) {
      await db.select({ id: schema.workspaces.id }).from(schema.workspaces).where(eq(schema.workspaces.id, workspaceId)).for('share');
    },

    async locateDraft(draftId: string) {
      const [located] = await db.select({ workspaceId: schema.drafts.workspaceId }).from(schema.drafts).where(eq(schema.drafts.id, draftId));
      return located ?? null;
    },
    /** Locks the draft row first, so its project cannot change; returns the project it is in. */
    async lockDraftForUpdate(draftId: string) {
      const [locked] = await db.select({ projectId: schema.drafts.projectId }).from(schema.drafts).where(eq(schema.drafts.id, draftId)).for('update');
      return locked ?? null;
    },
    async readDraft(actor: AccessActor, draftId: string, options: { lock: boolean }) {
      const query = db.select({
        draft: schema.drafts,
        readable: visibleDraftsSql(actor).mapWith(Boolean),
        level: draftProjectLevel(actor).mapWith(Number),
        isOwner: isDraftOwner(actor).mapWith(Boolean),
      }).from(schema.drafts).where(eq(schema.drafts.id, draftId));
      const [row] = options.lock ? await query.for('update') : await query;
      // Opened only for a reader of the draft (an active member who may read it), so only they learn a lock.
      if (!row || !row.readable) return row ?? null;
      return { ...row, draft: openRow('drafts', row.draft, await sealOf(db, row.draft.workspaceId, { write: options.lock })) };
    },

    async readAgent(agentId: string) {
      const [agent] = await db.select().from(schema.agents).where(eq(schema.agents.id, agentId));
      return agent ?? null;
    },

    async locateSketch(sketchId: string) {
      const s = schema.sketches;
      const [located] = await db.select({ workspaceId: s.workspaceId, projectId: s.projectId, dmId: s.dmId }).from(s).where(eq(s.id, sketchId));
      return located ?? null;
    },
    async lockSketchForNoKeyUpdate(sketchId: string) {
      const s = schema.sketches;
      await db.select({ id: s.id }).from(s).where(eq(s.id, sketchId)).for('no key update');
    },
    async readSketch(actor: AccessActor, sketchId: string) {
      const s = schema.sketches;
      const [row] = await db.select({ sketch: s, readable: visibleSketchesSql(actor).mapWith(Boolean), level: sketchProjectLevel(actor).mapWith(Number) })
        .from(s).where(eq(s.id, sketchId));
      return row ?? null;
    },
    /** The workspace of a sketch, for the promotion scope. */
    async sketchWorkspace(sketchId: string) {
      const [sketch] = await db.select({ workspaceId: schema.sketches.workspaceId }).from(schema.sketches).where(eq(schema.sketches.id, sketchId));
      return sketch?.workspaceId ?? null;
    },

    async locateDm(dmId: string) {
      const d = schema.dms;
      const [located] = await db.select({ workspaceId: d.workspaceId }).from(d).where(eq(d.id, dmId));
      return located ?? null;
    },
    async lockDmForShare(dmId: string) {
      await db.select({ id: schema.dms.id }).from(schema.dms).where(eq(schema.dms.id, dmId)).for('share');
    },
    async lockDmForNoKeyUpdate(dmId: string) {
      const d = schema.dms;
      await db.select({ id: d.id }).from(d).where(eq(d.id, dmId)).for('no key update');
    },
    /** One participant's row `FOR SHARE`. */
    async lockParticipantForShare(dmId: string, userId: string) {
      await db.select({ userId: schema.dmParticipants.userId }).from(schema.dmParticipants)
        .where(and(eq(schema.dmParticipants.dmId, dmId), eq(schema.dmParticipants.userId, userId))).for('share');
    },
    /** Every participant row `FOR SHARE`, in user id order; returns the participants. */
    async lockParticipantsForShare(dmId: string): Promise<string[]> {
      const rows = await db.select({ userId: schema.dmParticipants.userId }).from(schema.dmParticipants)
        .where(eq(schema.dmParticipants.dmId, dmId)).orderBy(schema.dmParticipants.userId).for('share');
      return rows.map((row) => row.userId);
    },
    async readDm(actor: AccessActor, dmId: string) {
      const d = schema.dms;
      const [row] = await db.select({ dm: d, readable: visibleDmsSql(actor).mapWith(Boolean) }).from(d).where(eq(d.id, dmId));
      return row ?? null;
    },
    /** The facts `dmClosedFor` decides on: a DM's kind and pair key. */
    async dmPair(dmId: string) {
      const [dm] = await db.select({ kind: schema.dms.kind, pairKey: schema.dms.pairKey, workspaceId: schema.dms.workspaceId }).from(schema.dms).where(eq(schema.dms.id, dmId));
      return dm ?? null;
    },
    async isParticipant(dmId: string, userId: string): Promise<boolean> {
      const [present] = await db.select({ userId: schema.dmParticipants.userId }).from(schema.dmParticipants)
        .where(and(eq(schema.dmParticipants.dmId, dmId), eq(schema.dmParticipants.userId, userId)));
      return !!present;
    },
    async userName(userId: string): Promise<string | null> {
      const [user] = await db.select({ name: schema.authUsers.name }).from(schema.authUsers).where(eq(schema.authUsers.id, userId));
      return user?.name ?? null;
    },

    async readAssistantRun(runId: string) {
      const r = schema.personalRuns;
      const [run] = await db.select({ id: r.id, workspaceId: r.workspaceId, ownerUserId: r.ownerUserId }).from(r).where(eq(r.id, runId));
      return run ?? null;
    },
  };
}
