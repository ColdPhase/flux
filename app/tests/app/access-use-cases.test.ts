import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, test } from 'node:test';
import type { WorkspaceRole } from '@flux/contracts';
import { accessPorts } from '@flux/db';
import {
  addMember,
  ConflictError,
  changeRole,
  createAgent,
  createDraft,
  createWorkspace,
  ForbiddenError,
  grantProject,
  InvalidInputError,
  NotFoundError,
  PreconditionRequiredError,
  removeMember,
  revokeProjectGrant,
  setWorkspaceAiPolicy,
  sweepWorkspaceAi,
  updateDraft,
  VersionConflictError,
  WorkspaceAiBlockedError,
  WorkspaceAiSweepIncomplete,
  type AccessPorts,
  type Actor,
  type Database,
  type DraftRecord,
  type GrantRecord,
  type GrantWrite,
  type MemberRecord,
  type Principal,
  type ProjectRecord,
} from '@flux/core';

// The workspace, project, grant, agent and draft use cases over in-memory repositories: no database, no SQL (issues #46, #91).
// The repositories and the access reader record each call, so a test pins the order of the statements (which lock comes first, that
// the version precondition follows the authorization, that the event is the last write) and that one mutation is one transaction.
// What the SQL does behind the real repositories is exercised against PostgreSQL by access-policy.test.ts and its siblings.

// The SQL adapters satisfy core's ports: a mismatch fails to compile here and at every call site.
const adapters: AccessPorts = accessPorts;

const WS = randomUUID();
const PROJECT = randomUUID();
const DRAFT = randomUUID();
const GRANT = randomUUID();
const OWNER = 'owner-user';
const TARGET = 'target-user';
const now = new Date('2026-10-27T10:00:00.000Z');
const human = (id: string): Principal => ({ kind: 'human', id });

const project: ProjectRecord = { id: PROJECT, workspaceId: WS, name: 'Lamp', visibility: 'workspace', views: [], version: 1, createdAt: now };
const draftRow = (over: Partial<DraftRecord> = {}): DraftRecord => ({ id: DRAFT, workspaceId: WS, projectId: null, ownerUserId: OWNER, ownerAgentId: null,
  title: 'Notes', body: '', visibility: 'private', version: 3, createdAt: now, updatedAt: now, ...over });
const memberRow = (role: WorkspaceRole, userId = TARGET): MemberRecord => ({ workspaceId: WS, userId, role, createdAt: now });
const grantRow = (userId: string | null = TARGET): GrantRecord => ({ id: GRANT, projectId: PROJECT, userId, agentId: null, role: 'contributor', createdBy: OWNER, createdAt: now });

interface Scene {
  role?: WorkspaceRole;
  aiState?: 'allowed' | 'blocked';
  sealed?: boolean;
  targetRole?: WorkspaceRole;
  ownerCount?: number;
  /** What `dropUnlockPassword` answers. */
  drop?: 'none' | 'deleted' | 'last';
  grantWrite?: GrantWrite;
  existingGrant?: GrantRecord | null;
  draft?: DraftRecord;
  failStep?: string;
}

/** Ports whose every call lands in `calls`; a method a use case should not reach is missing, so calling it throws. */
function scene(options: Scene = {}) {
  const calls: string[] = [];
  const log = (call: string) => calls.push(call);
  const actor = (principal: Principal, workspaceId: string): Actor => ({ principal, workspaceId, role: principal.kind === 'human' ? options.role ?? 'owner' : null, agent: null, active: true });
  const access = {
    loadActor: async (principal: Principal, workspaceId: string, o?: { lock?: boolean }) => { log(`access.loadActor${o?.lock ? '(lock)' : ''}`); return actor(principal, workspaceId); },
    workspaceAi: async (_workspaceId: string, o?: { lock?: boolean }) => { log(`access.workspaceAi${o?.lock ? '(lock)' : ''}`); return { state: options.aiState ?? 'allowed', epoch: 4, version: 2 }; },
    locateProject: async () => { log('access.locateProject'); return { workspaceId: WS }; },
    lockProjectAccess: async () => { log('access.lockProjectAccess'); },
    readProject: async () => { log('access.readProject'); return { project, level: 3 }; },
    locateDraft: async () => { log('access.locateDraft'); return { workspaceId: WS }; },
    lockDraftForUpdate: async () => { log('access.lockDraftForUpdate'); return { projectId: null }; },
    readDraft: async (_actor: Actor, _id: string, o: { lock: boolean }) => {
      log(`access.readDraft${o.lock ? '(lock)' : ''}`);
      return { draft: options.draft ?? draftRow(), readable: true, level: 0, isOwner: true };
    },
  };
  const workspaces = {
    createWithOwner: async (row: { id: string; name: string }) => { log('workspaces.createWithOwner'); return { id: row.id, name: row.name, version: 1, encrypted: false, createdAt: now }; },
    aiPolicies: async () => { log('workspaces.aiPolicies'); return []; },
    lock: async () => { log('workspaces.lock'); },
    lockAiPolicy: async () => { log('workspaces.lockAiPolicy'); return { state: 'allowed' as const, epoch: 3, version: 1 }; },
    updateAiPolicy: async () => { log('workspaces.updateAiPolicy'); return { epoch: 4 }; },
    findAccount: async (lookup: unknown) => { log(`workspaces.findAccount(${'userId' in (lookup as object) ? 'id' : 'email'})`); return { id: TARGET, email: 'target@example.test', name: 'Target', emailVerified: true }; },
    insertMember: async (row: { role: WorkspaceRole }) => { log('workspaces.insertMember'); return memberRow(row.role); },
    lockMember: async () => { log('workspaces.lockMember'); return memberRow(options.targetRole ?? 'member'); },
    ownerCount: async () => { log('workspaces.ownerCount'); return options.ownerCount ?? 2; },
    setRole: async (_w: string, _u: string, role: WorkspaceRole) => { log('workspaces.setRole'); return memberRow(role); },
    deleteMember: async () => { log('workspaces.deleteMember'); },
  };
  const encryption = {
    sealed: async () => { log('encryption.sealed'); return options.sealed ?? false; },
    memberRole: async () => { log('encryption.memberRole'); return options.targetRole ?? 'member'; },
    keys: async () => { log('encryption.keys(update)'); return {}; },
    dropUnlockPassword: async () => { log('encryption.dropUnlockPassword'); return options.drop ?? 'deleted'; },
  };
  const projects = {
    lockForGrantChange: async () => { log('projects.lockForGrantChange'); },
    member: async () => { log('projects.member'); return memberRow('member'); },
    lockGrantOf: async () => { log('projects.lockGrantOf'); return options.existingGrant ?? null; },
    insertGrant: async () => { log('projects.insertGrant'); return options.grantWrite ?? { grant: grantRow() }; },
    updateGrant: async () => { log('projects.updateGrant'); return options.grantWrite ?? { grant: grantRow() }; },
    lockGrant: async () => { log('projects.lockGrant'); return grantRow(); },
    memberRole: async () => { log('projects.memberRole'); return 'member' as const; },
    deleteGrant: async () => { log('projects.deleteGrant'); },
    get: async () => { log('projects.get'); return project; },
  };
  const agents = {
    insert: async (row: { id: string; workspaceId: string; name: string; ownerUserId: string | null }) => {
      log('agents.insert');
      return { id: row.id, workspaceId: row.workspaceId, name: row.name, ownerUserId: row.ownerUserId, revokedAt: null, createdAt: now };
    },
  };
  const drafts = {
    insert: async (row: { id: string; workspaceId: string; projectId: string | null; title: string; body: string; ownerUserId: string | null; ownerAgentId: string | null }) => {
      log('drafts.insert');
      return draftRow({ ...row, version: 1, visibility: 'private' });
    },
    updateText: async (_id: string, changes: { title?: string; body?: string }) => { log('drafts.updateText'); return draftRow({ ...changes, version: 4 }); },
  };
  const aiSweep = Object.fromEntries(['endQueuedRuns', 'stopInFlightRuns', 'closeRunTokens', 'endComparisons', 'skipReactionEvents', 'cancelRequests', 'stopUnits', 'revokeSessions']
    .map((step) => [step, async () => {
      log(`aiSweep.${step}`);
      if (options.failStep === step) throw new Error(`${step} failed`);
      return step.endsWith('Runs') ? [] : 2;
    }]));
  const events = {
    candidates: async () => { log('events.candidates'); return []; },
    insert: async () => { log('events.insert'); },
  };
  const ports = { workspaces: () => workspaces, projects: () => projects, agents: () => agents, drafts: () => drafts, encryption: () => encryption,
    aiSweep: () => aiSweep, access: () => access, events: () => events } as unknown as AccessPorts;
  const db = {
    transaction: async <T>(work: (tx: unknown) => Promise<T>): Promise<T> => {
      log('begin');
      try { const result = await work({}); log('commit'); return result; } catch (error) { log('rollback'); throw error; }
    },
  } as unknown as Database;
  return { calls, ports, db };
}

const EVENT_LAST = ['events.candidates', 'events.insert'];

describe('workspace and membership use cases over in-memory repositories', () => {
  test('createWorkspace: the workspace and owner, then the event, in one transaction; agents cannot create one', async () => {
    const s = scene();
    const created = await createWorkspace(human(OWNER), { name: ' Lamp shop ' }, s.db, s.ports);
    assert.equal(created.name, 'Lamp shop');
    assert.equal(created.role, 'owner');
    assert.deepEqual(s.calls, ['begin', 'workspaces.createWithOwner', ...EVENT_LAST, 'workspaces.aiPolicies', 'commit']);
    const agent = scene();
    await assert.rejects(createWorkspace({ kind: 'agent', id: randomUUID() }, { name: 'No' }, agent.db, agent.ports), ForbiddenError);
    assert.deepEqual(agent.calls, [], 'no transaction opens for a refused caller');
  });

  test('addMember: the workspace row first, the actor under lock, the lookup, the insert, the event last', async () => {
    const s = scene();
    const member = await addMember(human(OWNER), WS, { email: ' Target@Example.test ', role: 'member' }, s.db, s.ports);
    assert.deepEqual(member, { userId: TARGET, email: 'target@example.test', name: 'Target', role: 'member', createdAt: now.toISOString() });
    assert.deepEqual(s.calls, ['begin', 'workspaces.lock', 'access.loadActor(lock)', 'workspaces.findAccount(email)', 'workspaces.insertMember', ...EVENT_LAST, 'commit']);
  });

  test('addMember: bad input opens no transaction, an admin cannot add an owner, a missing account and a duplicate are typed', async () => {
    const bad = scene();
    await assert.rejects(addMember(human(OWNER), WS, { userId: TARGET, role: 'root' as 'owner' }, bad.db, bad.ports), InvalidInputError);
    assert.deepEqual(bad.calls, []);
    const admin = scene({ role: 'admin' });
    await assert.rejects(addMember(human(OWNER), WS, { userId: TARGET, role: 'owner' }, admin.db, admin.ports), (error: unknown) => error instanceof ForbiddenError && error.code === 'OWNER_REQUIRED');
    assert.deepEqual(admin.calls, ['begin', 'workspaces.lock', 'access.loadActor(lock)', 'rollback']);
    const nobody = scene();
    await assert.rejects(addMember(human(OWNER), WS, { role: 'member' }, nobody.db, nobody.ports), InvalidInputError);
    const verified = scene();
    verified.ports.workspaces = () => ({ lock: async () => undefined, findAccount: async () => ({ id: TARGET, email: 'a@b.test', name: 'A', emailVerified: false }) }) as never;
    await assert.rejects(addMember(human(OWNER), WS, { email: 'a@b.test', role: 'member' }, verified.db, verified.ports, { verifiedEmailOnly: true }),
      (error: unknown) => error instanceof NotFoundError && error.code === 'ACCOUNT_NOT_FOUND');
    const twice = scene();
    twice.ports.workspaces = () => ({ lock: async () => undefined, findAccount: async () => ({ id: TARGET, email: 'a@b.test', name: 'A', emailVerified: true }), insertMember: async () => null }) as never;
    await assert.rejects(addMember(human(OWNER), WS, { userId: TARGET, role: 'member' }, twice.db, twice.ports), (error: unknown) => error instanceof ConflictError && error.code === 'ALREADY_MEMBER');
  });

  test('changeRole: the AI policy row before the workspace row before the member row; the event, then the account, last', async () => {
    const s = scene({ targetRole: 'member' });
    const changed = await changeRole(human(OWNER), WS, TARGET, { role: 'admin' }, s.db, s.ports);
    assert.equal(changed.role, 'admin');
    assert.deepEqual(s.calls, ['begin', 'encryption.sealed', 'access.workspaceAi(lock)', 'workspaces.lock', 'access.loadActor(lock)', 'workspaces.lockMember', 'workspaces.setRole',
      ...EVENT_LAST, 'workspaces.findAccount(id)', 'commit']);
  });

  test('changeRole: the last owner cannot step down', async () => {
    const s = scene({ targetRole: 'owner', ownerCount: 1 });
    await assert.rejects(changeRole(human(OWNER), WS, TARGET, { role: 'member' }, s.db, s.ports), (error: unknown) => error instanceof ConflictError && error.code === 'LAST_OWNER');
    assert.ok(!s.calls.includes('workspaces.setRole') && !s.calls.includes('events.insert'));
  });

  test('changeRole in a sealed workspace: the key row is locked before the F-029 order, the password dropped before the role changes', async () => {
    const s = scene({ sealed: true, targetRole: 'admin' });
    await changeRole(human(OWNER), WS, TARGET, { role: 'member' }, s.db, s.ports);
    assert.deepEqual(s.calls, ['begin', 'encryption.sealed', 'encryption.memberRole', 'encryption.keys(update)', 'access.workspaceAi(lock)', 'workspaces.lock', 'access.loadActor(lock)',
      'workspaces.lockMember', 'encryption.dropUnlockPassword', 'workspaces.setRole', ...EVENT_LAST, 'workspaces.findAccount(id)', 'commit']);
  });

  test('changeRole in a sealed workspace: the last unlock password is refused before anything changes', async () => {
    const s = scene({ sealed: true, targetRole: 'admin', drop: 'last' });
    await assert.rejects(changeRole(human(OWNER), WS, TARGET, { role: 'guest' }, s.db, s.ports), (error: unknown) => error instanceof ConflictError && error.code === 'LAST_UNLOCK_PASSWORD');
    assert.ok(!s.calls.includes('workspaces.setRole') && !s.calls.includes('events.insert'));
    assert.equal(s.calls.at(-1), 'rollback');
  });

  test('removeMember: a person leaving needs only workspace.read; the same locks; the event last', async () => {
    const s = scene({ role: 'guest', targetRole: 'guest' });
    await removeMember(human(TARGET), WS, TARGET, s.db, s.ports);
    assert.deepEqual(s.calls, ['begin', 'encryption.sealed', 'access.workspaceAi(lock)', 'workspaces.lock', 'access.loadActor(lock)', 'workspaces.lockMember', 'workspaces.deleteMember', ...EVENT_LAST, 'commit']);
    const other = scene({ role: 'guest', targetRole: 'member' });
    await assert.rejects(removeMember(human(OWNER), WS, TARGET, other.db, other.ports), ForbiddenError, 'a guest cannot remove someone else');
  });

  test('setWorkspaceAiPolicy: the policy row first, the actor under lock, the update, the sweep job, then the event', async () => {
    const s = scene();
    const queued: unknown[] = [];
    const result = await setWorkspaceAiPolicy(human(OWNER), WS, { state: 'blocked', expectedVersion: 1 }, s.db, s.ports, async (_tx, job) => { s.calls.push('queue'); queued.push(job); });
    assert.deepEqual(queued, [{ workspaceId: WS, epoch: 4 }]);
    assert.equal(result.changed, true);
    assert.deepEqual(s.calls, ['begin', 'workspaces.lockAiPolicy', 'access.loadActor(lock)', 'encryption.sealed', 'workspaces.updateAiPolicy', 'queue', ...EVENT_LAST, 'workspaces.aiPolicies', 'commit']);
  });

  test('setWorkspaceAiPolicy: a sealed workspace answers before the permission or the version, a stale version is a conflict', async () => {
    const sealed = scene({ sealed: true, role: 'member' });
    await assert.rejects(setWorkspaceAiPolicy(human(OWNER), WS, { state: 'allowed' }, sealed.db, sealed.ports, async () => undefined),
      (error: unknown) => error instanceof ConflictError && error.code === 'WORKSPACE_ENCRYPTED_AI_OFF');
    const nobody = scene({ role: 'member' });
    await assert.rejects(setWorkspaceAiPolicy(human(OWNER), WS, { state: 'allowed', expectedVersion: 1 }, nobody.db, nobody.ports, async () => undefined),
      (error: unknown) => error instanceof ForbiddenError && error.code === 'WORKSPACE_AI_ADMIN_REQUIRED');
    const missing = scene();
    await assert.rejects(setWorkspaceAiPolicy(human(OWNER), WS, { state: 'blocked' }, missing.db, missing.ports, async () => undefined), PreconditionRequiredError);
    const stale = scene();
    await assert.rejects(setWorkspaceAiPolicy(human(OWNER), WS, { state: 'blocked', expectedVersion: 9 }, stale.db, stale.ports, async () => undefined), VersionConflictError);
    assert.ok(!stale.calls.includes('workspaces.updateAiPolicy'));
  });

  test('sweepWorkspaceAi: one transaction per step; a failing step is reported and the others still commit', async () => {
    const ok = scene();
    const swept = await sweepWorkspaceAi({ workspaceId: WS, epoch: 2 }, ok.db, ok.ports);
    assert.deepEqual(swept, { runs: 0, tokens: 2, comparisons: 2, reactions: 2, requests: 2, units: 2, sessions: 2, failed: [] });
    assert.equal(ok.calls.filter((call) => call === 'begin').length, 7);
    const broken = scene({ failStep: 'cancelRequests' });
    await assert.rejects(sweepWorkspaceAi({ workspaceId: WS, epoch: 2 }, broken.db, broken.ports), (error: unknown) => error instanceof WorkspaceAiSweepIncomplete
      && error.swept.failed.join() === 'requests' && error.swept.units === 2 && error.swept.sessions === 2);
    await assert.rejects(sweepWorkspaceAi({ workspaceId: 'not-a-uuid', epoch: 2 }, ok.db, ok.ports), InvalidInputError);
  });
});

describe('grant, agent and draft use cases over in-memory repositories', () => {
  test('grantProject: the project row for the change, then the actor and grant rows under lock, the write, the event last', async () => {
    const s = scene();
    const granted = await grantProject(human(OWNER), PROJECT, { principal: { kind: 'human', id: TARGET }, role: 'contributor' }, s.db, s.ports);
    assert.deepEqual(granted, { id: GRANT, projectId: PROJECT, principal: { kind: 'human', id: TARGET }, role: 'contributor', createdBy: OWNER, createdAt: now.toISOString() });
    assert.deepEqual(s.calls, ['begin', 'projects.lockForGrantChange', 'access.locateProject', 'access.loadActor(lock)', 'access.lockProjectAccess', 'access.readProject', 'projects.member',
      'projects.lockGrantOf', 'projects.insertGrant', ...EVENT_LAST, 'commit']);
    const again = scene({ existingGrant: grantRow() });
    await grantProject(human(OWNER), PROJECT, { principal: { kind: 'human', id: TARGET }, role: 'viewer' }, again.db, again.ports);
    assert.ok(again.calls.includes('projects.updateGrant') && !again.calls.includes('projects.insertGrant'), 'an existing grant is replaced, not inserted');
  });

  test('grantProject: the constraint violations PostgreSQL reports become ConflictError, with no event', async () => {
    for (const [conflict, message] of [['GRANT_CONFLICT', 'A concurrent grant for this principal was created'], ['GRANTEE_REMOVED', 'The grantee is no longer part of the workspace']] as const) {
      const s = scene({ grantWrite: { conflict } });
      await assert.rejects(grantProject(human(OWNER), PROJECT, { principal: { kind: 'human', id: TARGET }, role: 'viewer' }, s.db, s.ports),
        (error: unknown) => error instanceof ConflictError && error.code === conflict && error.message === message);
      assert.ok(!s.calls.includes('events.insert'));
      assert.equal(s.calls.at(-1), 'rollback');
    }
  });

  test('grantProject: only an owner may grant to an owner, and the grantee must be a member; revoke needs the grant', async () => {
    const s = scene({ role: 'admin' });
    s.ports.projects = () => ({ lockForGrantChange: async () => undefined, member: async () => memberRow('owner') }) as never;
    await assert.rejects(grantProject(human(OWNER), PROJECT, { principal: { kind: 'human', id: TARGET }, role: 'viewer' }, s.db, s.ports),
      (error: unknown) => error instanceof ForbiddenError && error.code === 'OWNER_REQUIRED');
    const stranger = scene();
    stranger.ports.projects = () => ({ lockForGrantChange: async () => undefined, member: async () => null }) as never;
    await assert.rejects(grantProject(human(OWNER), PROJECT, { principal: { kind: 'human', id: TARGET }, role: 'viewer' }, stranger.db, stranger.ports),
      (error: unknown) => error instanceof Error && 'code' in error && error.code === 'NOT_A_MEMBER');
    const gone = scene();
    gone.ports.projects = () => ({ lockForGrantChange: async () => undefined, lockGrant: async () => null }) as never;
    await assert.rejects(revokeProjectGrant(human(OWNER), PROJECT, GRANT, gone.db, gone.ports), (error: unknown) => error instanceof NotFoundError && error.code === 'GRANT_NOT_FOUND');
  });

  test('revokeProjectGrant: the project row, the grant row under lock, the deletion, the event last', async () => {
    const s = scene();
    await revokeProjectGrant(human(OWNER), PROJECT, GRANT, s.db, s.ports);
    assert.deepEqual(s.calls, ['begin', 'projects.lockForGrantChange', 'access.locateProject', 'access.loadActor(lock)', 'access.lockProjectAccess', 'access.readProject', 'projects.lockGrant',
      'projects.memberRole', 'projects.deleteGrant', ...EVENT_LAST, 'commit']);
  });

  test('createAgent: the actor under lock, the AI policy under lock, the insert, the event last; AI off refuses before the insert', async () => {
    const s = scene();
    const agent = await createAgent(human(OWNER), WS, { name: 'Helper', owner: 'self' }, s.db, s.ports);
    assert.deepEqual(agent.owner, { kind: 'human', id: OWNER });
    assert.deepEqual(s.calls, ['begin', 'access.loadActor(lock)', 'access.workspaceAi(lock)', 'agents.insert', ...EVENT_LAST, 'commit']);
    const off = scene({ aiState: 'blocked' });
    await assert.rejects(createAgent(human(OWNER), WS, { name: 'Helper', owner: 'self' }, off.db, off.ports), WorkspaceAiBlockedError);
    assert.ok(!off.calls.includes('agents.insert'));
  });

  test('createDraft: the workspace under lock, the target project under lock, the insert, the event last', async () => {
    const s = scene();
    const created = await createDraft(human(OWNER), WS, { title: 'Notes', projectId: PROJECT }, s.db, s.ports);
    assert.equal(created.projectId, PROJECT);
    assert.deepEqual(s.calls, ['begin', 'access.loadActor(lock)', 'access.locateProject', 'access.loadActor(lock)', 'access.lockProjectAccess', 'access.readProject', 'drafts.insert', ...EVENT_LAST, 'commit']);
    const agent = scene();
    agent.ports.access = () => ({ loadActor: async (principal: Principal, workspaceId: string) => ({ principal, workspaceId, role: null, agent: null, active: true }),
      hasWritableProject: async () => true }) as never;
    await assert.rejects(createDraft({ kind: 'agent', id: randomUUID() }, WS, { title: 'No project' }, agent.db, agent.ports),
      (error: unknown) => error instanceof Error && 'code' in error && error.code === 'PROJECT_REQUIRED');
  });

  test('updateDraft: the version precondition follows authorization and precedes the write; the event is last', async () => {
    const decide = ['begin', 'access.locateDraft', 'access.loadActor(lock)', 'access.lockDraftForUpdate', 'access.readDraft(lock)'];
    const missing = scene();
    await assert.rejects(updateDraft(human(OWNER), DRAFT, { title: 'New' }, missing.db, missing.ports), PreconditionRequiredError);
    assert.deepEqual(missing.calls, [...decide, 'rollback']);
    const stale = scene();
    await assert.rejects(updateDraft(human(OWNER), DRAFT, { title: 'New', expectedVersion: 2 }, stale.db, stale.ports), (error: unknown) => error instanceof VersionConflictError);
    assert.ok(!stale.calls.includes('drafts.updateText'));
    const ok = scene();
    const updated = await updateDraft(human(OWNER), DRAFT, { title: 'New', expectedVersion: 3 }, ok.db, ok.ports);
    assert.equal(updated.version, 4);
    assert.deepEqual(ok.calls, [...decide, 'drafts.updateText', ...EVENT_LAST, 'commit']);
    const nothing = scene();
    await assert.rejects(updateDraft(human(OWNER), DRAFT, {}, nothing.db, nothing.ports), InvalidInputError);
    assert.deepEqual(nothing.calls, []);
  });
});

void adapters;
