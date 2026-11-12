import { and, eq, or, sql, type SQL, type SQLWrapper } from 'drizzle-orm';
import type { WorkspaceRole } from '@flux/contracts';
import * as schema from '../schema.js';
import type { DbExecutor } from './push.js';
import { preparedTemplate, queryPrepared } from '../prepared.js';
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

// The two lookups every access decision makes, several times in a request: constant text, prepared, not built by Drizzle (#1178).
const MEMBER_ROLE = 'SELECT role FROM workspace_members WHERE workspace_id = $1 AND user_id = $2';
const MEMBER_ROLE_LOCKED = `${MEMBER_ROLE} FOR SHARE`;
const PROJECT_WORKSPACE = 'SELECT workspace_id AS "workspaceId" FROM projects WHERE id = $1';

async function memberRole(db: DbExecutor, workspaceId: string, userId: string, lock: boolean): Promise<WorkspaceRole | null> {
  const { rows } = await queryPrepared<{ role: WorkspaceRole }>(db, lock ? MEMBER_ROLE_LOCKED : MEMBER_ROLE, [workspaceId, userId]);
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
    // A guest of the company has no AI wherever else they hold a role: the company's role decides, not the agent's own workspace's (#1003).
    // The company's membership row is taken first and the agent's workspace's own after it, the order `createAgent` and a change to guest
    // use, so a role change and a read of an agent in another workspace cannot wait for each other (#1059).
    const companyGuest = await isCompanyGuest(db, agent.ownerUserId, { lock });
    const ownerRole = await memberRole(db, workspaceId, agent.ownerUserId, lock);
    return { ...inactive, agent: { ownerUserId: agent.ownerUserId, ownerRole }, active: ownerRole !== null && ownerRole !== 'guest' && !companyGuest };
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
 * The person whose membership counts for an actor: the person themself, or an agent's owner (an agent has no standing of its own,
 * F-036 AG-3). Null for an agent without a current owner.
 */
function personOf(actor: AccessActor): AccessActor | null {
  if (actor.principal.kind === 'human') return actor;
  if (!actor.agent) return null;
  return { principal: { kind: 'human', id: actor.agent.ownerUserId }, workspaceId: actor.workspaceId, role: actor.agent.ownerRole, agent: null, active: actor.active };
}

/**
 * SQL expression for the actor's access level (0–2) to the project identified by
 * `projectId` whose visibility column/expression is `visibility`. Composable into lists.
 * An agent's level is its owner's current level, never more and never less (F-036 AG-3), in the spaces its owner belongs to: a company
 * owner or admin reaches every space themselves, but their agents work only in the spaces the person was added to (C-15, #934), until
 * the person adds themselves to another with Add me.
 */
export function projectLevelSql(actor: AccessActor, projectId: SQLWrapper, visibility: SQLWrapper): SQL {
  if (!actor.active) return sql`0`;
  if (actor.principal.kind === 'human') return humanLevel(actor.principal.id, actor.role, projectId, visibility);
  const person = personOf(actor);
  if (!person) return sql`0`;
  const level = humanLevel(person.principal.id, person.role, projectId, visibility);
  // Only a company owner or admin has a level in a space they were not added to; for anyone else the level already says "belongs".
  const belongs = isManager(person.role) ? projectMemberSql(person, projectId, visibility) : sql`true`;
  // F-037, AG-10: no agent reads or acts in a space whose AI is off, whatever its owner may do there.
  return sql`(CASE WHEN EXISTS (SELECT 1 FROM project_ai_policies ai WHERE ai.project_id = ${projectId} AND ai.state = 'allowed') AND ${belongs} THEN ${level} ELSE 0 END)`;
}

/**
 * Whether the actor belongs to the space, not only reaches it: a company owner or admin without a grant does not (F-037). An agent
 * belongs where its owner does.
 */
export function projectMemberSql(actor: AccessActor, projectId: SQLWrapper, visibility: SQLWrapper): SQL {
  const person = personOf(actor);
  if (!person || !actor.active) return sql`true`;
  const everyone = person.role === 'guest' ? sql`false` : sql`${visibility} = 'workspace'`;
  // Nested: Drizzle would write a column at the top level of a selected expression without its table, and `id` here would mean the grant's.
  const added = sql`EXISTS (SELECT 1 FROM project_grants g WHERE g.project_id = ${projectId} AND g.user_id = ${person.principal.id})`;
  return sql`(${everyone} OR ${added})`;
}

/** Condition over `projects` rows: the project is in the actor's workspace and at least viewable. */
export function visibleProjectsSql(actor: AccessActor): SQL {
  if (!actor.active) return sql`false`;
  return and(eq(schema.projects.workspaceId, actor.workspaceId), sql`${projectLevelSql(actor, schema.projects.id, schema.projects.visibility)} >= 1`)!;
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
  return and(eq(s.workspaceId, actor.workspaceId), or(project, own))!;
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
export async function visibleFilter(principal: AccessPrincipal, workspaceId: string, kind: 'project' | 'sketch' | 'dm', db: DbExecutor): Promise<SQL> {
  return visibleFilterOf(await loadActor(principal, workspaceId, db), kind);
}

function visibleFilterOf(actor: AccessActor, kind: 'project' | 'sketch' | 'dm'): SQL {
  if (kind === 'sketch') return visibleSketchesSql(actor);
  if (kind === 'dm') return visibleDmsSql(actor);
  return visibleProjectsSql(actor);
}

/**
 * `visibleFilter` limited to the spaces the person belongs to (F-037, coordinator default, #874): search, the Inbox and Needs you
 * show a company owner or admin only what is in spaces they were added to, though they can reach every other space (Settings ›
 * Company lists those). So do their agents (C-15, #934): an agent belongs where its owner does. Sketches outside any
 * space are unchanged; direct messages are not spaces. The actor is loaded once for both parts (#955).
 */
export async function memberFilter(principal: AccessPrincipal, workspaceId: string, kind: 'project' | 'sketch', db: DbExecutor): Promise<SQL> {
  const actor = await loadActor(principal, workspaceId, db);
  const base = visibleFilterOf(actor, kind);
  if (principal.kind !== 'human' && principal.kind !== 'agent') return base;
  if (kind === 'project') return and(base, projectMemberSql(actor, schema.projects.id, schema.projects.visibility))!;
  return and(base, sql`(${schema.sketches.scope} <> 'project' OR ${projectMemberSql(actor, schema.sketches.projectId, sketchProjectVisibility)})`)!;
}

/**
 * Whether the person is a guest of the company (F-037: one company per Flux; C-22 says "a member of the company"; F-036: a guest has no
 * AI). It is the person's role in the company workspace, as the web reads it. Someone who is in no company is not a guest: they have no
 * company to be a guest of, and this is not a place to refuse them. A role in any other workspace does not count, and nor does it undo
 * this one: a guest of the company who is a member of an encrypted space is still a guest (#978). With `lock`, inside a transaction,
 * the membership row is read `FOR SHARE`, so a role change waits for what is being decided on it.
 */
export async function isCompanyGuest(db: DbExecutor, userId: string, options: { lock?: boolean } = {}): Promise<boolean> {
  const result = await db.execute<{ role: string }>(sql`SELECT m.role FROM workspace_members m JOIN workspaces w ON w.id = m.workspace_id
    WHERE m.user_id = ${userId} AND w.company${options.lock ? sql` FOR SHARE OF m` : sql``}`);
  return result.rows[0]?.role === 'guest';
}

/**
 * SQL: the person in `userId` (a column or a value) is a guest of the company. Their agents, API keys and client connections are kept
 * but hidden and refused while they are (#1035, C-50): a statement that lists or finds one of them adds `NOT` this, so the same rows come
 * back when the person is a member again.
 */
export function companyGuestSql(userId: SQLWrapper): SQL {
  return sql`EXISTS (SELECT 1 FROM workspace_members gm JOIN workspaces gw ON gw.id = gm.workspace_id WHERE gm.user_id = ${userId} AND gw.company AND gm.role = 'guest')`;
}

/**
 * A person's read of one space with their level in it (#1178): run several times in every request, so composed once per company role
 * (`humanLevel` with the person and the space as placeholders), not by Drizzle on every call. An agent's read keeps the composed path.
 */
const humanProjectReads = new Map<WorkspaceRole, ReturnType<typeof preparedTemplate<typeof schema.projects.$inferSelect & { level: number }>>>();
function humanProjectRead(role: WorkspaceRole) {
  let read = humanProjectReads.get(role);
  if (!read) {
    read = preparedTemplate(() => sql`SELECT p.id, p.workspace_id AS "workspaceId", p.name, p.visibility, p.created_by AS "createdBy", p.version,
      p.created_at AS "createdAt", p.updated_at AS "updatedAt",
      ${humanLevel(sql.placeholder('user') as unknown as string, role, sql`p.id`, sql`p.visibility`)} AS level
      FROM projects p WHERE p.id = ${sql.placeholder('project')}`);
    humanProjectReads.set(role, read);
  }
  return read;
}

/**
 * SQL (F-039, #1226): the viewer can see the person in `person` (a user id column or value), so the person's photo shows to them. Both
 * are in one workspace, and a guest there sees only the people of the spaces they are added to (guests may not read the roster): those
 * with a grant on one of the guest's spaces, and the members of a space everyone is in. Anyone sees themselves. Someone removed from
 * the company is in none of its workspaces any more, so their photo is hidden with them, and someone who left sees nobody's.
 */
export function personSeenBySql(viewerId: string, person: SQLWrapper): SQL {
  return sql`(${person} = ${viewerId} OR EXISTS (SELECT 1 FROM workspace_members sv JOIN workspace_members sp ON sp.workspace_id = sv.workspace_id
    WHERE sv.user_id = ${viewerId} AND sp.user_id = ${person} AND (sv.role <> 'guest' OR EXISTS (SELECT 1 FROM project_grants gv
      JOIN projects pv ON pv.id = gv.project_id WHERE gv.user_id = ${viewerId} AND gv.workspace_id = sv.workspace_id
      AND ((pv.visibility = 'workspace' AND sp.role <> 'guest') OR EXISTS (SELECT 1 FROM project_grants gp WHERE gp.project_id = gv.project_id AND gp.user_id = ${person}))))))`;
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


    async locateProject(projectId: string) {
      const [located] = (await queryPrepared<{ workspaceId: string }>(db, PROJECT_WORKSPACE, [projectId])).rows;
      return located ?? null;
    },
    lockProjectAccess: (actor: AccessActor, projectId: string) => lockProjectAccess(db, actor, projectId),
    async readProject(actor: AccessActor, projectId: string) {
      const [row] = actor.active && actor.principal.kind === 'human' && actor.role
        ? (await humanProjectRead(actor.role)(db, { user: actor.principal.id, project: projectId })).rows.map(({ level, ...project }) => ({ project, level: Number(level) }))
        : await db.select({ project: schema.projects, level: projectLevelSql(actor, schema.projects.id, schema.projects.visibility).mapWith(Number) })
          .from(schema.projects).where(eq(schema.projects.id, projectId));
      // Reached only for an active member (core loads the actor first), so only a member learns a lock (423).
      return row ? { ...row, project: openRow('projects', row.project, await sealOf(db, row.project.workspaceId, { write: false })) } : null;
    },

    async readAgent(agentId: string) {
      const [agent] = await db.select().from(schema.agents).where(eq(schema.agents.id, agentId));
      return agent ?? null;
    },

    async locateSketch(sketchId: string) {
      const s = schema.sketches;
      const [located] = await db.select({ workspaceId: s.workspaceId, projectId: s.projectId }).from(s).where(eq(s.id, sketchId));
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

    async locateDm(dmId: string) {
      const d = schema.dms;
      const [located] = await db.select({ workspaceId: d.workspaceId }).from(d).where(eq(d.id, dmId));
      return located ?? null;
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
