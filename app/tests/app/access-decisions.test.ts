import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, test } from 'node:test';
import type { WorkspaceRole } from '@flux/contracts';
import {
  authorize,
  assertAuthorized,
  authorizeEvent,
  enforce,
  evaluateProject,
  eventResource,
  ForbiddenError,
  NotFoundError,
  policyEventPorts,
  recordEvents,
  requireSpaceAi,
  visibleWorkspaceOf,
  SpaceAiOffError,
  type AccessReader,
  type Actor,
  type EventRepository,
  type Principal,
  type ProjectFacts,
  type SketchFacts,
  type SpaceAi,
} from '@flux/core';

// The access policy's decisions over an in-memory `AccessReader`: no database, no SQL (issues #46, #90).
// The facts (who is active, which level, who owns what) are given by the test; the policy turns them into
// allowed/visible and chooses which statements to run, and in which order. The SQL behind the real reader
// is exercised against PostgreSQL by access-policy.test.ts and its siblings.

const WS = randomUUID();
const key = (principal: Principal) => `${principal.kind}:${principal.id}`;
const human = (id: string): Principal => ({ kind: 'human', id });
const agentOf = (id: string): Principal => ({ kind: 'agent', id });

interface World {
  actors: Record<string, Actor>;
  ai: SpaceAi;
  projects: Record<string, { project: ProjectFacts; levels: Record<string, number> }>;
  agents: Record<string, { id: string; workspaceId: string; ownerUserId: string; revokedAt: Date | null }>;
  sketches: Record<string, { sketch: SketchFacts; readable: string[]; levels: Record<string, number> }>;
  dms: Record<string, { id: string; workspaceId: string; kind: 'pair' | 'group'; pairKey: string | null; readable: string[]; participants: string[] }>;
  runs: Record<string, { id: string; workspaceId: string; ownerUserId: string }>;
  names: Record<string, string>;
}

const member = (principal: Principal, role: WorkspaceRole): Actor => ({ principal, workspaceId: WS, role, agent: null, active: true });
const emptyWorld = (): World => ({
  actors: {}, ai: { state: 'allowed', epoch: 1 }, projects: {}, agents: {}, sketches: {}, dms: {}, runs: {}, names: {},
});

/** An `AccessReader` over `world` that records every call, so a test can pin the statement order. */
function memoryReader(world: World) {
  const calls: string[] = [];
  const lock = (options?: { lock?: boolean }) => (options?.lock ? '(lock)' : '');
  const reader: AccessReader = {
    async loadActor(principal, workspaceId, options) {
      calls.push(`loadActor${lock(options)}`);
      return world.actors[key(principal)] ?? { principal, workspaceId, role: null, agent: null, active: false };
    },
    async spaceAi(_projectId, options) {
      calls.push(`spaceAi${lock(options)}`);
      return world.ai;
    },
    async locateProject(projectId) {
      calls.push('locateProject');
      const found = world.projects[projectId];
      return found ? { workspaceId: found.project.workspaceId } : null;
    },
    async lockProjectAccess() {
      calls.push('lockProjectAccess');
    },
    async readProject(actor, projectId) {
      calls.push('readProject');
      const found = world.projects[projectId];
      return found ? { project: found.project, level: found.levels[key(actor.principal)] ?? 0 } : null;
    },
    async readAgent(agentId) {
      calls.push('readAgent');
      return world.agents[agentId] ?? null;
    },
    async locateSketch(sketchId) {
      calls.push('locateSketch');
      const found = world.sketches[sketchId];
      return found ? { workspaceId: found.sketch.workspaceId, projectId: found.sketch.projectId } : null;
    },
    async lockSketchForNoKeyUpdate() {
      calls.push('lockSketchForNoKeyUpdate');
    },
    async readSketch(actor, sketchId) {
      calls.push('readSketch');
      const found = world.sketches[sketchId];
      const who = key(actor.principal);
      return found ? { sketch: found.sketch, readable: found.readable.includes(who), level: found.levels[who] ?? 0 } : null;
    },
    async locateDm(dmId) {
      calls.push('locateDm');
      const found = world.dms[dmId];
      return found ? { workspaceId: found.workspaceId } : null;
    },
    async lockDmForNoKeyUpdate() {
      calls.push('lockDmForNoKeyUpdate');
    },
    async lockParticipantForShare() {
      calls.push('lockParticipantForShare');
    },
    async readDm(actor, dmId) {
      calls.push('readDm');
      const found = world.dms[dmId];
      return found ? { dm: { id: found.id, workspaceId: found.workspaceId }, readable: found.readable.includes(actor.principal.id) } : null;
    },
    async dmPair(dmId) {
      calls.push('dmPair');
      const found = world.dms[dmId];
      return found ? { kind: found.kind, pairKey: found.pairKey, workspaceId: found.workspaceId } : null;
    },
    async isParticipant(dmId, userId) {
      calls.push('isParticipant');
      return world.dms[dmId]?.participants.includes(userId) ?? false;
    },
    async userName(userId) {
      calls.push('userName');
      return world.names[userId] ?? null;
    },
    async readAssistantRun(runId) {
      calls.push('readAssistantRun');
      return world.runs[runId] ?? null;
    },
  };
  return { reader, calls };
}

/** Every agent belongs to one person (F-036); these decisions read only the facts the reader returns, so any owner id will do. */
const OWNER_OF_AGENTS = 'agent-owner';
const WORKSPACE_ACTIONS = ['workspace.read', 'workspace.read_members', 'workspace.manage_members', 'workspace.rename', 'workspace.manage_encryption', 'project.create', 'agent.create', 'sketch.create', 'dm.create'] as const;
const workspaceRef = { type: 'workspace', id: WS } as const;

async function workspaceDecisions(principal: Principal, actor: Actor | undefined) {
  const world = emptyWorld();
  if (actor) world.actors[key(principal)] = actor;
  const { reader } = memoryReader(world);
  const allowed: string[] = [];
  for (const action of WORKSPACE_ACTIONS) if ((await authorize(principal, action, workspaceRef, reader)).allowed) allowed.push(action);
  return { allowed, visible: (await authorize(principal, 'workspace.read', workspaceRef, reader)).visible };
}

describe('workspace decisions (pure)', () => {
  test('each role is allowed exactly its workspace actions', async () => {
    const ownerId = human('owner');
    const everything = [...WORKSPACE_ACTIONS];
    assert.deepEqual((await workspaceDecisions(ownerId, member(ownerId, 'owner'))).allowed, everything);
    assert.deepEqual((await workspaceDecisions(ownerId, member(ownerId, 'admin'))).allowed, everything);
    // F-037: everyone in the company but a guest starts spaces; only owners and admins rename the company.
    assert.deepEqual((await workspaceDecisions(ownerId, member(ownerId, 'member'))).allowed,
      ['workspace.read', 'workspace.read_members', 'project.create', 'agent.create', 'sketch.create', 'dm.create']);
    assert.deepEqual((await workspaceDecisions(ownerId, member(ownerId, 'guest'))).allowed, ['workspace.read', 'sketch.create']);
  });

  test('a person who is not active in the workspace sees nothing and may do nothing', async () => {
    const outsider = human('outsider');
    assert.deepEqual(await workspaceDecisions(outsider, undefined), { allowed: [], visible: false });
  });

  test('an agent reads the workspace and does nothing else in it', async () => {
    const bot = agentOf(randomUUID());
    const active: Actor = { principal: bot, workspaceId: WS, role: null, agent: { ownerUserId: OWNER_OF_AGENTS, ownerRole: 'member' }, active: true };
    assert.deepEqual((await workspaceDecisions(bot, active)).allowed, ['workspace.read']);
    assert.deepEqual(await workspaceDecisions(bot, { ...active, active: false }), { allowed: [], visible: false });
  });

  test('enforce answers 404 for an invisible object and 403 for a visible one the action is not allowed on', async () => {
    assert.throws(() => enforce({ allowed: false, visible: false }, 'project'), (error) => error instanceof NotFoundError && error.code === 'PROJECT_NOT_FOUND');
    assert.throws(() => enforce({ allowed: false, visible: true }, 'agent'), ForbiddenError);
    assert.deepEqual(enforce({ allowed: true, visible: true }, 'sketch'), { allowed: true, visible: true });
  });
});

describe('project decisions (pure)', () => {
  const projectId = randomUUID();
  const project: ProjectFacts = { id: projectId, workspaceId: WS, visibility: 'restricted' };
  const person = human('person');
  const world = (level: number) => {
    const w = emptyWorld();
    w.actors[key(person)] = member(person, 'member');
    w.projects[projectId] = { project, levels: { [key(person)]: level } };
    return w;
  };

  test('the level the reader reports sets what is allowed: contributor reads and writes, manager manages', async () => {
    const expected: [number, { read: boolean; write: boolean; manage: boolean }][] = [
      [1, { read: true, write: true, manage: false }],
      [2, { read: true, write: true, manage: true }],
    ];
    for (const [level, want] of expected) {
      const { reader } = memoryReader(world(level));
      const got = {
        read: (await evaluateProject(person, 'project.read', projectId, reader)).allowed,
        write: (await evaluateProject(person, 'project.write', projectId, reader)).allowed,
        manage: (await evaluateProject(person, 'project.manage', projectId, reader)).allowed,
      };
      assert.deepEqual(got, want, `level ${level}`);
    }
  });

  test('level 0, an unknown project, a malformed id and an inactive person are all not found', async () => {
    const { reader } = memoryReader(world(0));
    assert.equal((await evaluateProject(person, 'project.read', projectId, reader)).visible, false);
    assert.equal((await evaluateProject(person, 'project.read', randomUUID(), reader)).visible, false);
    assert.equal((await evaluateProject(person, 'project.read', 'not-a-uuid', reader)).visible, false);
    await assert.rejects(assertAuthorized(person, 'project.read', { type: 'project', id: projectId }, reader), NotFoundError);
    const stranger = human('stranger');
    assert.equal((await evaluateProject(stranger, 'project.read', projectId, memoryReader(world(2)).reader)).visible, false);
  });

  test('a visible project with a forbidden action is 403 and carries the row and level the reader loaded', async () => {
    const { reader } = memoryReader(world(1));
    await assert.rejects(assertAuthorized(person, 'project.manage', { type: 'project', id: projectId }, reader), ForbiddenError);
    const evaluation = await evaluateProject(person, 'project.read', projectId, reader);
    assert.equal(evaluation.project, project);
    assert.equal(evaluation.level, 1);
  });

  test('visibleWorkspaceOf reveals the workspace of a visible object only', async () => {
    assert.equal(await visibleWorkspaceOf(person, { type: 'project', id: projectId }, memoryReader(world(1)).reader), WS);
    assert.equal(await visibleWorkspaceOf(person, { type: 'project', id: projectId }, memoryReader(world(0)).reader), null);
    assert.equal(await visibleWorkspaceOf(person, workspaceRef, memoryReader(world(0)).reader), WS);
  });
});

describe('agent, sketch, direct message and assistant run decisions (pure)', () => {
  const owner = human('owner');
  const guest = human('guest');
  const admin = human('admin');
  const botId = randomUUID();
  const bot = agentOf(botId);
  const agentWorld = (revokedAt: Date | null = null): World => {
    const w = emptyWorld();
    w.actors[key(owner)] = member(owner, 'member');
    w.actors[key(guest)] = member(guest, 'guest');
    w.actors[key(admin)] = member(admin, 'admin');
    w.actors[key(bot)] = { principal: bot, workspaceId: WS, role: null, agent: { ownerUserId: owner.id, ownerRole: 'member' }, active: true };
    w.agents[botId] = { id: botId, workspaceId: WS, ownerUserId: owner.id, revokedAt };
    return w;
  };
  const agentRef = { type: 'agent', id: botId } as const;
  const allowedFor = async (principal: Principal, action: 'agent.read' | 'agent.revoke' | 'agent.invoke', world: World) =>
    authorize(principal, action, agentRef, memoryReader(world).reader);

  test('agents are visible to people other than guests and to themselves; only their owner invokes them', async () => {
    const w = agentWorld();
    assert.deepEqual(await allowedFor(owner, 'agent.invoke', w), { allowed: true, visible: true });
    assert.deepEqual(await allowedFor(admin, 'agent.invoke', w), { allowed: false, visible: true }, 'a workspace role does not lend someone else\'s assistant');
    assert.deepEqual(await allowedFor(admin, 'agent.revoke', w), { allowed: true, visible: true });
    assert.deepEqual(await allowedFor(guest, 'agent.read', w), { allowed: false, visible: false });
    assert.deepEqual(await allowedFor(bot, 'agent.read', w), { allowed: true, visible: true });
    assert.deepEqual(await allowedFor(bot, 'agent.revoke', w), { allowed: false, visible: true });
  });

  test('a revoked agent cannot be invoked; an agent belongs to its person, so no space\'s switch stops the owner invoking it', async () => {
    assert.equal((await allowedFor(owner, 'agent.invoke', agentWorld(new Date()))).allowed, false);
    const off = agentWorld();
    off.ai = { state: 'blocked', epoch: 2 };
    assert.deepEqual(await allowedFor(owner, 'agent.invoke', off), { allowed: true, visible: true }, 'the switch of a space is checked where the agent works');
    assert.equal((await allowedFor(owner, 'agent.read', off)).allowed, true, 'reading the agent is not AI use');
  });

  const sketchId = randomUUID();
  const dmId = randomUUID();
  const projectId = randomUUID();
  const sketchWorld = (sketch: Partial<SketchFacts>, readable: Principal[], level = 0) => {
    const w = agentWorld();
    w.sketches[sketchId] = { sketch: { id: sketchId, workspaceId: WS, scope: 'project', projectId, ...sketch }, readable: readable.map(key), levels: { [key(owner)]: level } };
    return w;
  };

  test('a private sketch is changed by whoever can read it; a project sketch needs contributor level', async () => {
    const sketch = { type: 'sketch', id: sketchId } as const;
    const priv = sketchWorld({ scope: 'private', projectId: null }, [owner]);
    assert.deepEqual(await authorize(owner, 'sketch.write', sketch, memoryReader(priv).reader), { allowed: true, visible: true });
    assert.deepEqual(await authorize(admin, 'sketch.read', sketch, memoryReader(priv).reader), { allowed: false, visible: false });
    assert.equal((await authorize(owner, 'sketch.write', sketch, memoryReader(sketchWorld({}, [owner], 0)).reader)).allowed, false);
    assert.deepEqual(await authorize(owner, 'sketch.read', sketch, memoryReader(sketchWorld({}, [owner], 0)).reader), { allowed: true, visible: true });
    assert.equal((await authorize(owner, 'sketch.write', sketch, memoryReader(sketchWorld({}, [owner], 1)).reader)).allowed, true);
  });

  test('a DM is for its current participants and for people only', async () => {
    const w = agentWorld();
    w.dms[dmId] = { id: dmId, workspaceId: WS, kind: 'group', pairKey: null, readable: [owner.id], participants: [owner.id] };
    const ref = { type: 'dm', id: dmId } as const;
    assert.deepEqual(await authorize(owner, 'dm.write', ref, memoryReader(w).reader), { allowed: true, visible: true });
    assert.deepEqual(await authorize(admin, 'dm.read', ref, memoryReader(w).reader), { allowed: false, visible: false }, 'owners and admins who are not in it never see it');
    assert.deepEqual(await authorize(bot, 'dm.read', ref, memoryReader(w).reader), { allowed: false, visible: false }, 'agents never do');
  });

  test('an assistant run is known only to its owner', async () => {
    const runId = randomUUID();
    const w = agentWorld();
    w.runs[runId] = { id: runId, workspaceId: WS, ownerUserId: owner.id };
    const ref = { type: 'assistant_run', id: runId } as const;
    assert.deepEqual(await authorize(owner, 'assistant_run.read', ref, memoryReader(w).reader), { allowed: true, visible: true });
    assert.deepEqual(await authorize(admin, 'assistant_run.read', ref, memoryReader(w).reader), { allowed: false, visible: false });
    assert.deepEqual(await authorize(bot, 'assistant_run.read', ref, memoryReader(w).reader), { allowed: false, visible: false });
  });
});

describe('event and AI decisions (pure)', () => {
  const owner = human('owner');
  const botId = randomUUID();
  const bot = agentOf(botId);
  const projectId = randomUUID();
  const world = () => {
    const w = emptyWorld();
    w.actors[key(owner)] = member(owner, 'owner');
    w.actors[key(bot)] = { principal: bot, workspaceId: WS, role: null, agent: { ownerUserId: OWNER_OF_AGENTS, ownerRole: 'member' }, active: true };
    w.projects[projectId] = { project: { id: projectId, workspaceId: WS, visibility: 'workspace' }, levels: { [key(owner)]: 2, [key(bot)]: 1 } };
    return w;
  };

  test('an event reaches a principal who can read its object in the event\'s workspace, and nobody else', async () => {
    const { reader } = memoryReader(world());
    const event = { kind: 'project.renamed.v1', workspaceId: WS, objectId: projectId };
    assert.equal(await authorizeEvent(owner, event, reader), true);
    assert.equal(await authorizeEvent(bot, event, reader), true);
    assert.equal(await authorizeEvent(owner, { ...event, workspaceId: randomUUID() }, reader), false, 'the object must belong to the event\'s workspace');
    assert.equal(await authorizeEvent(owner, { ...event, workspaceId: null }, reader), false);
    assert.equal(await authorizeEvent(owner, { ...event, kind: 'unknown.thing.v1' }, reader), false);
    assert.equal(await authorizeEvent(human('stranger'), event, reader), false);
  });

  test('the AI switch change is for people: no agent receives it', async () => {
    const { reader } = memoryReader(world());
    const event = { kind: 'project.ai_policy_changed.v1', workspaceId: WS, objectId: projectId };
    assert.equal(await authorizeEvent(owner, event, reader), true);
    assert.equal(await authorizeEvent(bot, event, reader), false);
  });

  test('an event names its object from its kind; a workspace event only its own workspace', () => {
    assert.deepEqual(eventResource({ kind: 'project.ai_policy_changed.v1', workspaceId: WS, objectId: 'p' }), { type: 'project', id: 'p' });
    assert.deepEqual(eventResource({ kind: 'workspace.member_added.v1', workspaceId: WS, objectId: WS }), { type: 'workspace', id: WS });
    assert.equal(eventResource({ kind: 'workspace.member_added.v1', workspaceId: WS, objectId: 'other' }), null);
    assert.equal(eventResource({ kind: 'comment.added.v1', workspaceId: WS, objectId: 'c' }), null);
  });

  test('AI is required allowed, and at the epoch a queued item was admitted under', async () => {
    const allowed = memoryReader(world());
    assert.deepEqual(await requireSpaceAi(allowed.reader, WS, { lock: true }), { state: 'allowed', epoch: 1 });
    assert.deepEqual(allowed.calls, ['spaceAi(lock)']);
    await assert.rejects(requireSpaceAi(allowed.reader, WS, { epoch: 2 }), SpaceAiOffError);
    const off = world();
    off.ai = { state: 'blocked', epoch: 1 };
    await assert.rejects(requireSpaceAi(memoryReader(off).reader, WS), SpaceAiOffError);
  });
});

describe('the order of the policy\'s reads and locks (pure)', () => {
  // These sequences are the lock order of the SQL adapter (docs/development/access-policy.md, Concurrency): a
  // change to them is a change to which rows a decision locks first, so it needs a deliberate edit here.
  const owner = human('owner');
  const projectId = randomUUID();
  const sketchId = randomUUID();
  const dmId = randomUUID();
  const world = () => {
    const w = emptyWorld();
    w.actors[key(owner)] = member(owner, 'member');
    w.projects[projectId] = { project: { id: projectId, workspaceId: WS, visibility: 'workspace' }, levels: { [key(owner)]: 1 } };
    w.sketches[sketchId] = { sketch: { id: sketchId, workspaceId: WS, scope: 'project', projectId }, readable: [key(owner)], levels: { [key(owner)]: 1 } };
    w.dms[dmId] = { id: dmId, workspaceId: WS, kind: 'group', pairKey: null, readable: [owner.id], participants: [owner.id, 'other'] };
    return w;
  };

  test('a project check takes the membership, then the project and grants, then reads', async () => {
    const { reader, calls } = memoryReader(world());
    await evaluateProject(owner, 'project.write', projectId, reader, { lock: true });
    assert.deepEqual(calls, ['locateProject', 'loadActor(lock)', 'lockProjectAccess', 'readProject']);
    calls.length = 0;
    await evaluateProject(owner, 'project.read', projectId, reader);
    assert.deepEqual(calls, ['locateProject', 'loadActor', 'readProject'], 'an unlocked check takes no lock');
  });

  test('a sketch check takes the membership, the sketch row, then its project', async () => {
    const { reader, calls } = memoryReader(world());
    await authorize(owner, 'sketch.write', { type: 'sketch', id: sketchId }, reader, { lock: true });
    assert.deepEqual(calls, ['locateSketch', 'loadActor(lock)', 'lockSketchForNoKeyUpdate', 'lockProjectAccess', 'readSketch']);
  });

  test('a DM check takes the membership, the DM row, then the participant row', async () => {
    const { reader, calls } = memoryReader(world());
    await authorize(owner, 'dm.write', { type: 'dm', id: dmId }, reader, { lock: true });
    assert.deepEqual(calls, ['locateDm', 'loadActor(lock)', 'lockDmForNoKeyUpdate', 'lockParticipantForShare', 'readDm']);
  });

  test('the event audience takes the space\'s AI switch once, before the first agent candidate, and before any insert', async () => {
    const w = world();
    const botA = agentOf(randomUUID());
    const botB = agentOf(randomUUID());
    for (const bot of [botA, botB]) {
      w.actors[key(bot)] = { principal: bot, workspaceId: WS, role: null, agent: { ownerUserId: OWNER_OF_AGENTS, ownerRole: 'member' }, active: true };
      w.projects[projectId]!.levels[key(bot)] = 1;
    }
    const { reader, calls } = memoryReader(w);
    const stored: string[] = [];
    const repository: EventRepository = {
      async candidates() { calls.push('candidates'); return [owner, botA, botB]; },
      async insert(event, recipients) { calls.push('insert'); stored.push(...recipients); assert.equal(event.workspaceId, WS); },
    };
    await recordEvents(policyEventPorts(reader, repository), [{ principal: owner, workspaceId: WS, kind: 'project.renamed.v1', objectId: projectId, data: {} }]);
    assert.deepEqual(calls.filter((call) => call === 'candidates' || call === 'spaceAi(lock)' || call === 'insert'), ['candidates', 'spaceAi(lock)', 'insert']);
    assert.equal(calls.filter((call) => call === 'spaceAi(lock)').length, 1, 'one lock per space, however many agents');
    assert.deepEqual(stored.sort(), [key(owner), key(botA), key(botB)].sort());
  });
});
