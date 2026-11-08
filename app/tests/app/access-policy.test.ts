import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, test } from 'node:test';
import { count, eq } from 'drizzle-orm';
import { accessPorts, schema, visibleFilter, accessReader, type Database } from '@flux/db';
import {
  addMember,
  authorize,
  changeRole,
  assertAuthorized,
  createAgent,
  createProject,
  createWorkspace,
  ForbiddenError,
  getProject,
  grantProject,
  listProjectGrants,
  listProjects,
  listWorkspaces,
  NotFoundError,
  removeMember,
  revokeAgent,
  revokeProjectGrant,
  type Principal,
} from '@flux/core';
import { sketchUseCases } from '../../apps/server/src/sketches/adapters.js';
import { db, insertedHuman, pool } from './support/db.js';
import { interleave as interleaveOn } from './support/locks.js';

// Policy contract and agent principals exercised directly against PostgreSQL (issue #29).
// Agent authentication is a later task, so agents are driven through core methods here.
function agentPrincipal(id: string): Principal {
  return { id, kind: 'agent' };
}

function pgCode(error: unknown) {
  const candidate = error as { code?: string; cause?: { code?: string } };
  return candidate.code ?? candidate.cause?.code;
}

// F-036 AG-3 (#855): an agent has exactly its owner's current rights. There are no agent grants: its project level is
// its owner's, read live on every call, so it never exceeds its owner and loses access the moment its owner does.
describe('an agent has exactly its owner\'s rights', () => {
  test('a member\'s agent reads and writes exactly where its owner does', async () => {
    const admin = await insertedHuman('rights-admin');
    const human = await insertedHuman('rights-member');
    const ws = await createWorkspace(admin, { name: 'Owner rights' }, db, accessPorts);
    await addMember(admin, ws.id, { userId: human.id, role: 'member' }, db, accessPorts);
    const open = await createProject(admin, ws.id, { name: 'Open', visibility: 'workspace' }, db, accessPorts);
    const board = await createProject(admin, ws.id, { name: 'Board', visibility: 'restricted' }, db, accessPorts);
    const hidden = await createProject(admin, ws.id, { name: 'Hidden', visibility: 'restricted' }, db, accessPorts);
    await grantProject(admin, board.id, { principal: { kind: 'human', id: human.id }, role: 'contributor' }, db, accessPorts);
    const maps = sketchUseCases(db);
    const inOpen = await maps.create(admin, ws.id, { title: 'in open', scope: 'project', projectId: open.id });
    const minutes = await maps.create(admin, ws.id, { title: 'Board minutes', scope: 'project', projectId: board.id });
    const secret = await maps.create(admin, ws.id, { title: 'hidden', scope: 'project', projectId: hidden.id });
    const adminOwn = await maps.create(admin, ws.id, { title: 'admin private', scope: 'private' });

    const agent = await createAgent(human, ws.id, { name: 'Personal helper' }, db, accessPorts);
    assert.deepEqual(agent.owner, { kind: 'human', id: human.id });
    const bot = agentPrincipal(agent.id);
    assert.deepEqual((await listProjects(bot, ws.id, {}, db, accessPorts)).items.map((p) => [p.name, p.access]).sort(),
      [['Board', 'contributor'], ['Open', 'contributor']], 'the owner\'s projects at the owner\'s levels, and nothing else');
    assert.equal((await maps.get(bot, minutes.id)).id, minutes.id);
    assert.equal((await maps.rename(bot, minutes.id, { title: 'x', expectedVersion: minutes.version })).title, 'x', 'the owner writes here, so its agent does');
    assert.equal((await maps.rename(bot, inOpen.id, { title: 'agent edit', expectedVersion: inOpen.version })).title, 'agent edit');
    for (const id of [secret.id, adminOwn.id]) await assert.rejects(maps.get(bot, id), NotFoundError);
    await assert.rejects(getProject(bot, hidden.id, db, accessPorts), NotFoundError, 'never more than its owner');
    const own = await maps.create(bot, ws.id, { title: 'agent map', scope: 'project', projectId: open.id });
    assert.equal(own.createdBy.id, agent.id);
    await assert.rejects(maps.create(bot, ws.id, { title: 'agent private', scope: 'private' }), ForbiddenError, 'agents never own a private map');
    await assert.rejects(createWorkspace(bot, { name: 'Agent workspace' }, db, accessPorts), ForbiddenError);

    await revokeAgent(human, agent.id, db, accessPorts);
    await assert.rejects(maps.get(bot, inOpen.id), NotFoundError, 'revoked agent');
    assert.deepEqual(await listWorkspaces(bot, db, accessPorts), []);
  });

  test('a manager can no longer give an agent its own project access', async () => {
    const owner = await insertedHuman('no-agent-grants');
    const ws = await createWorkspace(owner, { name: 'No agent grants' }, db, accessPorts);
    const room = await createProject(owner, ws.id, { name: 'Room', visibility: 'restricted' }, db, accessPorts);
    const agent = await createAgent(owner, ws.id, { name: 'Helper' }, db, accessPorts);
    await assert.rejects(grantProject(owner, room.id, { principal: { kind: 'agent', id: agent.id }, role: 'contributor' } as never, db, accessPorts),
      (error: unknown) => (error as { code?: string }).code === 'INVALID_INPUT');
    await assert.rejects(createAgent(owner, ws.id, { name: 'Workspace bot', owner: 'workspace' } as never, db, accessPorts),
      (error: unknown) => (error as { code?: string }).code === 'INVALID_INPUT', 'every agent belongs to one person');
    const columns = await pool.query("SELECT column_name FROM information_schema.columns WHERE table_name = 'project_grants' AND column_name = 'agent_id'");
    assert.equal(columns.rowCount, 0, 'the data has no agent grants');
  });

  for (const [loss, lose] of [
    ['the owner is removed from the project', async (admin: Principal, _ws: string, project: string, human: string) => {
      const added = (await listProjectGrants(admin, project, db, accessPorts)).find((item) => item.principal.id === human);
      await revokeProjectGrant(admin, project, added!.id, db, accessPorts);
    }],
    // With a grant a guest still works in the space by hand, so only the role can stop the agent: a guest has no AI (AG-2).
    ['the owner becomes a guest with a grant on the project', async (admin: Principal, ws: string, project: string, human: string) => {
      await grantProject(admin, project, { principal: { kind: 'human', id: human }, role: 'contributor' }, db, accessPorts);
      await changeRole(admin, ws, human, { role: 'guest' }, db, accessPorts);
    }],
    ['the owner leaves the workspace', (admin: Principal, ws: string, _project: string, human: string) =>
      removeMember(admin, ws, human, db, accessPorts)],
  ] as const) {
    test(`the agent loses what its owner loses: ${loss}`, async () => {
      const admin = await insertedHuman('loss-admin');
      const human = await insertedHuman('loss-member');
      const ws = await createWorkspace(admin, { name: `Loss: ${loss}` }, db, accessPorts);
      await addMember(admin, ws.id, { userId: human.id, role: 'member' }, db, accessPorts);
      const open = await createProject(admin, ws.id, { name: 'Open', visibility: 'restricted' }, db, accessPorts);
      await grantProject(admin, open.id, { principal: { kind: 'human', id: human.id }, role: 'contributor' }, db, accessPorts);
      const maps = sketchUseCases(db);
      const item = await maps.create(admin, ws.id, { title: 'Plan', scope: 'project', projectId: open.id });
      const bot = agentPrincipal((await createAgent(human, ws.id, { name: 'Helper' }, db, accessPorts)).id);
      const own = await maps.create(bot, ws.id, { title: 'agent own', scope: 'project', projectId: open.id });
      assert.equal((await maps.rename(bot, item.id, { title: 'before', expectedVersion: item.version })).title, 'before');

      await lose(admin, ws.id, open.id, human.id);
      await assert.rejects(maps.rename(bot, item.id, { title: 'after', expectedVersion: item.version + 1 }), NotFoundError, 'it no longer sees the project at all');
      await assert.rejects(maps.get(bot, own.id), NotFoundError, 'not even its own map');
      assert.deepEqual(await authorize(bot, 'project.read', { type: 'project', id: open.id }, accessReader(db)), { allowed: false, visible: false });
      assert.equal((await listProjects(bot, ws.id, {}, db, accessPorts).catch(() => ({ items: [] }))).items.length, 0);
      assert.equal((await sketchRow(item.id)).title, 'before', 'nothing was written after the loss');
    });
  }

});

/** Two real sessions (`support/locks.ts`): `first` stays uncommitted while `second` runs on another connection and waits for it. */
const interleave = <A, B>(first: (tx: Database) => Promise<A>, second: () => Promise<B>) => interleaveOn(db, pool, first, second);

interface RaceCase {
  writer: Principal;
  sketchId: string;
  change: (db: Database) => Promise<unknown>;
  refused: typeof NotFoundError | typeof ForbiddenError;
}

async function sketchRow(id: string) {
  const [row] = await db.select().from(schema.sketches).where(eq(schema.sketches.id, id));
  return row!;
}

/** Access change committed while the write had already decided: the write commits, the change waits. */
async function writeThenChange({ writer, sketchId, change, refused }: RaceCase) {
  const { version } = await sketchRow(sketchId);
  const { firstResult, secondResult } = await interleave(
    (tx) => sketchUseCases(tx).rename(writer, sketchId, { title: 'decided under the old access', expectedVersion: version }),
    () => change(db));
  assert.equal(firstResult.title, 'decided under the old access');
  assert.equal(secondResult.error, null, 'the access change completes after the write');
  assert.equal((await sketchRow(sketchId)).title, 'decided under the old access');
  await assert.rejects(sketchUseCases(db).rename(writer, sketchId, { title: 'after the change', expectedVersion: version + 1 }), refused, 'the next write sees the change');
}

/** Access change uncommitted when the write starts: the write waits and is then refused. */
async function changeThenWrite({ writer, sketchId, change, refused }: RaceCase) {
  const before = await sketchRow(sketchId);
  const { secondResult } = await interleave(
    (tx) => change(tx),
    () => sketchUseCases(db).rename(writer, sketchId, { title: 'must not commit', expectedVersion: before.version }));
  assert.ok(secondResult.error instanceof refused, `the write is refused with ${refused.name}, got ${String(secondResult.error)}`);
  const after = await sketchRow(sketchId);
  assert.equal(after.title, before.title);
  assert.equal(after.version, before.version, 'no write committed under stale access');
}

describe('access changes are serialized with map writes (two connections)', () => {
  /** A member's agent writes in a restricted project through its owner's grant: changing the owner's access is what changes the agent's. */
  async function agentCase(label: string) {
    const owner = await insertedHuman(`${label}-owner`);
    const member = await insertedHuman(`${label}-member`);
    const ws = await createWorkspace(owner, { name: label }, db, accessPorts);
    await addMember(owner, ws.id, { userId: member.id, role: 'member' }, db, accessPorts);
    const room = await createProject(owner, ws.id, { name: 'Room', visibility: 'restricted' }, db, accessPorts);
    const grant = await grantProject(owner, room.id, { principal: { kind: 'human', id: member.id }, role: 'contributor' }, db, accessPorts);
    const agent = await createAgent(member, ws.id, { name: 'Racer' }, db, accessPorts);
    const bot = agentPrincipal(agent.id);
    const item = await sketchUseCases(db).create(bot, ws.id, { title: 'race', scope: 'project', projectId: room.id });
    return { owner, member, ws, room, bot, grant, item };
  }

  /** A member edits an owner's project map through implicit contributor access (no grant row). */
  async function memberCase(label: string) {
    const owner = await insertedHuman(`${label}-owner`);
    const member = await insertedHuman(`${label}-member`);
    const ws = await createWorkspace(owner, { name: label }, db, accessPorts);
    await addMember(owner, ws.id, { userId: member.id, role: 'member' }, db, accessPorts);
    const open = await createProject(owner, ws.id, { name: 'Open', visibility: 'workspace' }, db, accessPorts);
    const item = await sketchUseCases(db).create(owner, ws.id, { title: 'member race', scope: 'project', projectId: open.id });
    assert.equal((await sketchUseCases(db).rename(member, item.id, { title: 'implicit access works', expectedVersion: item.version })).version, item.version + 1);
    return { owner, member, ws, open, item };
  }

  for (const [order, run] of [['write first', writeThenChange], ['change first', changeThenWrite]] as const) {
    test(`(a) revoking the agent's owner's contributor grant — ${order}`, async () => {
      const { owner, room, bot, grant, item } = await agentCase(`revoke-${order}`);
      await run({ writer: bot, sketchId: item.id, refused: NotFoundError, change: (tx) => revokeProjectGrant(owner, room.id, grant.id, tx, accessPorts) });
      await assert.rejects(sketchUseCases(db).get(bot, item.id), NotFoundError);
    });

    test(`(c) removing the agent's owner from the workspace — ${order}`, async () => {
      const { owner, member, ws, bot, item } = await agentCase(`agent-remove-${order}`);
      await run({ writer: bot, sketchId: item.id, refused: NotFoundError, change: (tx) => removeMember(owner, ws.id, member.id, tx, accessPorts) });
    });

    test(`(c) changing a member to guest removes default project access — ${order}`, async () => {
      const { owner, member, ws, item } = await memberCase(`guest-${order}`);
      await run({ writer: member, sketchId: item.id, refused: NotFoundError, change: (tx) => changeRole(owner, ws.id, member.id, { role: 'guest' }, tx, accessPorts) });
    });

    test(`(c) removing the member — ${order}`, async () => {
      const { owner, member, ws, item } = await memberCase(`remove-${order}`);
      await run({ writer: member, sketchId: item.id, refused: NotFoundError, change: (tx) => removeMember(owner, ws.id, member.id, tx, accessPorts) });
    });
  }
});

describe('policy contract', () => {
  test('authorize distinguishes invisible from forbidden and visibleFilter matches list results', async () => {
    const owner = await insertedHuman('contract-owner');
    const reader = await insertedHuman('contract-reader');
    const stranger = await insertedHuman('contract-stranger');
    const ws = await createWorkspace(owner, { name: 'Contract' }, db, accessPorts);
    await addMember(owner, ws.id, { userId: reader.id, role: 'member' }, db, accessPorts);
    const room = await createProject(owner, ws.id, { name: 'Room', visibility: 'restricted' }, db, accessPorts);
    await grantProject(owner, room.id, { principal: { kind: 'human', id: reader.id }, role: 'contributor' }, db, accessPorts);
    const item = await sketchUseCases(db).create(owner, ws.id, { title: 'Contract map', scope: 'project', projectId: room.id });
    const mine = await sketchUseCases(db).create(owner, ws.id, { title: 'owner private', scope: 'private' });

    assert.deepEqual(await authorize(stranger, 'sketch.read', { type: 'sketch', id: item.id }, accessReader(db)), { allowed: false, visible: false });
    assert.deepEqual(await authorize(reader, 'sketch.read', { type: 'sketch', id: item.id }, accessReader(db)), { allowed: true, visible: true });
    assert.deepEqual(await authorize(reader, 'sketch.read', { type: 'sketch', id: mine.id }, accessReader(db)), { allowed: false, visible: false });
    assert.deepEqual(await authorize(reader, 'project.manage', { type: 'project', id: room.id }, accessReader(db)), { allowed: false, visible: true });
    assert.deepEqual(await authorize(owner, 'project.manage', { type: 'project', id: room.id }, accessReader(db)), { allowed: true, visible: true });
    assert.deepEqual(await authorize(reader, 'workspace.manage_members', { type: 'workspace', id: ws.id }, accessReader(db)), { allowed: false, visible: true });
    assert.deepEqual(await authorize(stranger, 'workspace.read', { type: 'workspace', id: ws.id }, accessReader(db)), { allowed: false, visible: false });
    await assert.rejects(assertAuthorized(stranger, 'sketch.read', { type: 'sketch', id: item.id }, accessReader(db)), NotFoundError);
    await assert.rejects(assertAuthorized(reader, 'project.manage', { type: 'project', id: room.id }, accessReader(db)), ForbiddenError);

    const filter = await visibleFilter(reader, ws.id, 'sketch', db);
    const rows = await db.select({ id: schema.sketches.id }).from(schema.sketches).where(filter);
    assert.deepEqual(rows.map((r) => r.id), [item.id]);
    const strangerFilter = await visibleFilter(stranger, ws.id, 'sketch', db);
    assert.equal((await db.select({ n: count() }).from(schema.sketches).where(strangerFilter))[0]!.n, 0);
    const projectFilter = await visibleFilter(reader, ws.id, 'project', db);
    assert.deepEqual((await db.select({ id: schema.projects.id }).from(schema.projects).where(projectFilter)).map((r) => r.id), [room.id]);
  });
});

describe('database integrity', () => {
  test('composite foreign keys reject cross-workspace links', async () => {
    const owner = await insertedHuman('integrity-owner');
    const stranger = await insertedHuman('integrity-stranger');
    const a = await createWorkspace(owner, { name: 'A' }, db, accessPorts);
    const b = await createWorkspace(owner, { name: 'B' }, db, accessPorts);
    const projectB = await createProject(owner, b.id, { name: 'B project' }, db, accessPorts);
    // F-037: the creator's own admin grant would answer the inserts below with a duplicate first; only the keys are tested.
    await pool.query('DELETE FROM project_grants WHERE project_id = $1', [projectB.id]);
    const sketchA = await sketchUseCases(db).create(owner, a.id, { title: 'A map', scope: 'private' });
    const projectA = await createProject(owner, a.id, { name: 'A project' }, db, accessPorts);
    const agentB = await createAgent(owner, b.id, { name: 'B agent' }, db, accessPorts);

    const attempts: [string, () => Promise<unknown>, string][] = [
      ['map links a project of another workspace', () => pool.query(
        "INSERT INTO sketches (id, workspace_id, scope, project_id, title, created_by_user_id) VALUES ($1, $2, 'project', $3, 'x', $4)",
        [randomUUID(), a.id, projectB.id, owner.id]), '23503'],
      ['existing map is moved to another workspace project', () => pool.query("UPDATE sketches SET scope = 'project', project_id = $1 WHERE id = $2", [projectB.id, sketchA.id]), '23503'],
      ['grant names a project of another workspace', () => pool.query(
        "INSERT INTO project_grants (id, workspace_id, project_id, user_id, role, created_by) VALUES ($1, $2, $3, $4, 'contributor', $4)",
        [randomUUID(), a.id, projectB.id, owner.id]), '23503'],
      ['grant names a person who is not a member', () => pool.query(
        "INSERT INTO project_grants (id, workspace_id, project_id, user_id, role, created_by) VALUES ($1, $2, $3, $4, 'contributor', $4)",
        [randomUUID(), b.id, projectB.id, stranger.id]), '23503'],
      ['map is made by an agent of another workspace', () => pool.query(
        "INSERT INTO sketches (id, workspace_id, scope, project_id, title, created_by_agent_id) VALUES ($1, $2, 'project', $3, 'x', $4)",
        [randomUUID(), a.id, projectA.id, agentB.id]), '23503'],
      ['a project map without a project', () => pool.query("UPDATE sketches SET scope = 'project' WHERE id = $1", [sketchA.id]), '23514'],
      ['a second private map for one person', () => pool.query(
        "INSERT INTO sketches (id, workspace_id, scope, title, created_by_user_id) VALUES ($1, $2, 'private', 'x', $3)",
        [randomUUID(), a.id, owner.id]), '23505'],
      ['unknown workspace role', () => pool.query("UPDATE workspace_members SET role = 'superuser' WHERE workspace_id = $1", [a.id]), '23514'],
    ];
    for (const [label, attempt, code] of attempts) {
      await assert.rejects(attempt(), (error: unknown) => pgCode(error) === code, label);
    }
    const [row] = await db.select().from(schema.sketches).where(eq(schema.sketches.id, sketchA.id));
    assert.equal(row!.projectId, null);
    assert.equal(row!.scope, 'private');
  });
});
