import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { describe, test } from 'node:test';
import {
  agentRuntimeUseCases, loadAgentRuntimeConfig, parseAgentRuntimeClients, reconcileAgentRuntime, runtimePayer, DomainError,
  type AgentRuntimeConfig, type AgentRuntimeStore, type RuntimeBindingRow, type RuntimeClientStatus, type RuntimeConnectionRow, type RuntimeManagerPort,
  type RuntimeSlotRow, type RuntimeSlotSighting, type RuntimeAuthOperation, type AgentRuntimeUseCases,
} from '@flux/core';
import { parseRuntimeSwitch } from '@flux/runtime-protocol';

// F-022 T3: the owner's slot binding and the worker's reconciliation, over an in-memory store and a
// scripted manager. The PostgreSQL adapter runs the same use cases in agent-runtime.test.ts. T4 (#279):
// recording a sign-in only from the CLI's status, the account-change notice and sign-out.

const secret = 'm'.repeat(40);
const on: AgentRuntimeConfig = { clients: ['claude_code'], commercialTermsAgreedOn: '2026-10-01', idleDays: null, manager: { url: 'http://runtime-manager-control:7600', secret } };

describe('operator configuration', () => {
  test('off by default; on needs the manager secret and, for Claude Code, the Commercial Terms date', () => {
    assert.deepEqual(loadAgentRuntimeConfig({}), { clients: [], commercialTermsAgreedOn: null, idleDays: null, manager: null });
    assert.throws(() => loadAgentRuntimeConfig({ FLUX_AGENT_RUNTIME: 'claude_code' }), /FLUX_RUNTIME_MANAGER_SECRET/);
    assert.throws(() => loadAgentRuntimeConfig({ FLUX_AGENT_RUNTIME: 'claude_code', FLUX_RUNTIME_MANAGER_SECRET: secret }), /COMMERCIAL_TERMS/);
    for (const bad of ['yes', '2026-13-01', '2026-02-30', '01.10.2026', '2099-01-01', '2019-01-01']) {
      assert.throws(() => loadAgentRuntimeConfig({ FLUX_AGENT_RUNTIME: 'claude_code', FLUX_RUNTIME_MANAGER_SECRET: secret, FLUX_AGENT_RUNTIME_COMMERCIAL_TERMS: bad }, new Date('2026-10-06')), /COMMERCIAL_TERMS/, bad);
    }
    const config = loadAgentRuntimeConfig({ FLUX_AGENT_RUNTIME: 'claude_code', FLUX_RUNTIME_MANAGER_SECRET: secret, FLUX_AGENT_RUNTIME_COMMERCIAL_TERMS: '2026-10-01', FLUX_AGENT_RUNTIME_IDLE_DAYS: '30' }, new Date('2026-10-06'));
    assert.deepEqual(config, { ...on, idleDays: 30 });
    assert.equal(loadAgentRuntimeConfig({ FLUX_AGENT_RUNTIME: 'codex', FLUX_RUNTIME_MANAGER_SECRET: secret }).commercialTermsAgreedOn, null);
    for (const bad of ['0', '366', '-1', 'x', '1.5']) assert.throws(() => loadAgentRuntimeConfig({ FLUX_AGENT_RUNTIME_IDLE_DAYS: bad }), /IDLE_DAYS/, bad);
  });

  test('the API and the runtime services read FLUX_AGENT_RUNTIME the same way', () => {
    for (const value of ['', 'claude_code', 'codex', 'codex,claude_code', ' claude_code , codex ', 'x', 'codex,codex', 'claude_code,']) {
      let core: string[] | string; let protocol: string[] | string;
      try { core = parseAgentRuntimeClients(value); } catch { core = 'refused'; }
      try { protocol = parseRuntimeSwitch(value); } catch { protocol = 'refused'; }
      assert.deepEqual(core, protocol, value);
    }
  });
});

/** The database as the use cases see it, in memory. */
function memoryStore() {
  const slots = new Map<string, RuntimeSlotRow>();
  const bindings: (RuntimeBindingRow & { releasedAt: Date | null })[] = [];
  const live = () => bindings.filter((b) => b.state !== ('released' as string));
  type Connection = RuntimeConnectionRow & { ownerUserId: string; fingerprint: string | null; revoked: boolean };
  const connections: Connection[] = [];
  const revoke = (bindingId: string) => { for (const c of connections) if (c.bindingId === bindingId && !c.revoked) Object.assign(c, { revoked: true, state: 'signed_out', signedInAt: null }); };
  const view = (c: Connection): RuntimeConnectionRow => ({ client: c.client, bindingId: c.bindingId, state: c.state, signInMethod: c.signInMethod,
    authMethod: c.authMethod, plan: c.plan, accountLabel: c.accountLabel, signedInAt: c.signedInAt, accountChangedAt: c.accountChangedAt,
    previousAccountLabel: c.previousAccountLabel, signedOutAt: c.signedOutAt, signOutFailed: c.signOutFailed });
  // A deterministic port fixture; cross-process clock/CAS behavior is tested with real PostgreSQL.
  const operations = new Map<string, RuntimeAuthOperation>();
  const valid = (op: RuntimeAuthOperation) => operations.get(op.bindingId + op.client)?.operationId === op.operationId
    && bindings.some(b => b.id === op.bindingId && b.ownerUserId === op.ownerUserId && b.state === 'active')
    && slots.get(bindings.find(b => b.id === op.bindingId)?.slot ?? '')?.bootId === op.bootId;
  const store: AgentRuntimeStore = {
    async claimAuth(input) {
      const b = bindings.find(b => b.id === input.bindingId && b.ownerUserId === input.ownerUserId && b.state === 'active');
      if (!b) return { kind: 'superseded' };
      const key = b.id + input.client;
      if (operations.has(key)) {
        if (input.kind === 'logout') { await store.requestRelease({ ownerUserId: b.ownerUserId }, 'auth_recovery'); return { kind: 'recovery' }; }
        return { kind: 'busy' };
      }
      const operation: RuntimeAuthOperation = { ...input, operationId: randomUUID(), revision: 1,
        bootId: slots.get(b.slot)!.bootId!, leaseEndsAt: new Date(Date.now()+input.leaseMs), hardEndsAt: new Date(Date.now()+input.lifetimeMs) };
      operations.set(key, operation);
      if (input.kind === 'logout') for (const c of connections) if (c.bindingId === b.id && c.client === input.client) Object.assign(c, { state: 'signed_out', signedInAt: null });
      return { kind: 'claimed', operation };
    },
    async renewAuth(op) { return valid(op); },
    async recoverAuth(op) {
      if (!valid(op)) return false;
      await store.requestRelease({ ownerUserId: op.ownerUserId }, 'auth_recovery');
      return true;
    },
    async recoverAbandonedAuth() { return 0; },
    async ownerView(owner) {
      const binding = live().find((b) => b.ownerUserId === owner) ?? null;
      const last = bindings.filter((b) => b.ownerUserId === owner && b.releasedAt).at(-1);
      const all = [...slots.values()];
      return {
        binding,
        auth: [...operations.values()].filter(op => valid(op)).map(op => ({ client: op.client, kind: op.kind })),
        lastRelease: last ? { reason: last.releaseReason!, at: last.releasedAt!, signOutFailed: false } : null,
        slots: { ready: all.filter((s) => s.state === 'ready' && !live().some((b) => b.slot === s.slot)).length, held: live().length,
          total: all.filter((s) => s.state !== 'out_of_pool').length },
        commercialTerms: null,
      };
    },
    async reserve(owner, id) {
      const existing = live().find((b) => b.ownerUserId === owner);
      if (existing) return { kind: 'existing', binding: existing };
      const free = [...slots.values()].find((s) => s.state === 'ready' && !live().some((b) => b.slot === s.slot));
      if (!free) return [...slots.values()].filter((s) => s.state !== 'out_of_pool').length && live().length >= [...slots.values()].filter((s) => s.state !== 'out_of_pool').length ? { kind: 'full' } : { kind: 'starting' };
      const binding = { id, ownerUserId: owner, slot: free.slot, state: 'binding' as const, createdAt: new Date(), lastUsedAt: null, releaseReason: null, releasedAt: null };
      bindings.push(binding);
      free.state = 'held';
      return { kind: 'reserved', binding };
    },
    async activate(id) { const b = bindings.find((x) => x.id === id && ['binding', 'sign_in_again'].includes(x.state)); if (b) b.state = 'active'; },
    async abandon(id, slot) {
      const index = bindings.findIndex((b) => b.id === id && b.state === 'binding');
      if (index < 0) return;
      const [b] = bindings.splice(index, 1);
      Object.assign(slots.get(b!.slot)!, slot.state === 'out_of_pool' ? { state: 'out_of_pool', outOfPoolReason: slot.reason } : { state: 'unknown' });
    },
    async requestRelease(target, reason) {
      const b = live().find((x) => ('ownerUserId' in target ? x.ownerUserId === target.ownerUserId : x.slot === target.slot) && x.state !== 'releasing');
      if (!b) return null;
      b.state = 'releasing'; b.releaseReason = reason;
      revoke(b.id);
      return b;
    },
    async recordCommercialTerms() {},
    async connections(owner) { return connections.filter((c) => c.ownerUserId === owner && !c.revoked).map(view); },
    async recordSignIn(record) {
      if (!valid(record.operation)) return false;
      operations.delete(record.bindingId + record.client);
      let row = connections.find((c) => c.ownerUserId === record.ownerUserId && c.client === record.client && !c.revoked);
      if (!row) {
        row = { ownerUserId: record.ownerUserId, client: record.client, bindingId: record.bindingId, state: 'signed_out', signInMethod: null, authMethod: null, plan: null,
          accountLabel: null, signedInAt: null, accountChangedAt: null, previousAccountLabel: null, signedOutAt: null, signOutFailed: null, fingerprint: null, revoked: false };
        connections.push(row);
      }
      row.signInMethod = record.method ?? row.signInMethod;
      if (!record.signedIn || !record.facts) {
        Object.assign(row, { state: row.state === 'signed_out' ? 'signed_out' : 'sign_in_again', signedInAt: null });
        return true;
      }
      const before = [row, ...connections.filter((c) => c.revoked).reverse()].find((c) => c.ownerUserId === record.ownerUserId && c.client === record.client && (c.accountLabel || c.fingerprint));
      const changed = Boolean(before) && (before!.fingerprint && record.fingerprint ? before!.fingerprint !== record.fingerprint : (before!.accountLabel ?? '') !== (record.facts.accountLabel ?? ''));
      Object.assign(row, { state: 'signed_in', signedInAt: new Date(), authMethod: record.facts.authMethod, plan: record.facts.plan, accountLabel: record.facts.accountLabel,
        fingerprint: record.fingerprint, signedOutAt: null, signOutFailed: null,
        ...(changed ? { accountChangedAt: new Date(), previousAccountLabel: before!.accountLabel } : {}) });
      return true;
    },
    async recordSignOut(operation, failed) {
      if (!valid(operation)) return false;
      const { ownerUserId: owner, bindingId, client } = operation;
      operations.delete(bindingId + client);
      let row = connections.find((c) => c.ownerUserId === owner && c.client === client && !c.revoked);
      if (!row) {
        row = { ownerUserId: owner, client, bindingId, state: 'signed_out', signInMethod: null, authMethod: null, plan: null, accountLabel: null, signedInAt: null,
          accountChangedAt: null, previousAccountLabel: null, signedOutAt: null, signOutFailed: null, fingerprint: null, revoked: false };
        connections.push(row);
      }
      Object.assign(row, { state: 'signed_out', signedInAt: null, signedOutAt: new Date(), signOutFailed: failed });
      return true;
    },
    async dismissAccountNotice(owner, client) {
      for (const c of connections) if (c.ownerUserId === owner && c.client === client && !c.revoked) Object.assign(c, { accountChangedAt: null, previousAccountLabel: null });
    },
    async slotsWithBindings() { return [...slots.values()].map((slot) => ({ slot: { ...slot }, binding: live().find((b) => b.slot === slot.slot) ?? null })); },
    async saveSlot(slot) { slots.set(slot.slot, { ...slot }); },
    async markSignInAgain(id) { const b = bindings.find((x) => x.id === id && x.state === 'active'); if (b) b.state = 'sign_in_again'; },
    async completeRelease(id, slot) {
      const b = bindings.find((x) => x.id === id && x.state === 'releasing');
      if (b) { (b as { state: string }).state = 'released'; b.releasedAt = new Date(); }
      slots.set(slot.slot, { ...slot });
    },
    async dropStaleReservation(id, olderThan) {
      const index = bindings.findIndex((b) => b.id === id && b.state === 'binding' && b.createdAt < olderThan);
      if (index < 0) return false;
      const [b] = bindings.splice(index, 1);
      slots.get(b!.slot)!.state = 'unknown';
      return true;
    },
    async idleBindings(before) { return live().filter((b) => b.state === 'active' && (b.lastUsedAt ?? b.createdAt) < before); },
  };
  return { store, slots, bindings, connections };
}

/** A scripted runtime-manager: each slot holds directories and a boot id; release empties it and "restarts" it. */
function fakeManager(names: string[]) {
  const state = new Map(names.map((slot) => [slot, { bootId: randomUUID(), dirs: [] as string[], other: 0, reachable: true }]));
  const calls: string[] = [];
  const manager: RuntimeManagerPort = {
    async slots() {
      return { ok: true, value: [...state.entries()].map(([slot, s]): RuntimeSlotSighting => s.reachable
        ? { slot, reachable: true, bootId: s.bootId, bindings: [...s.dirs], other: s.other } : { slot, reachable: false, error: 'unreachable' }) };
    },
    async bind(slot, id) {
      calls.push(`bind ${slot}`);
      const s = state.get(slot)!;
      if (s.dirs.length || s.other) return s.dirs.length === 1 && s.dirs[0] === id ? { ok: true, value: undefined } : { ok: false, code: 'data_not_empty' };
      s.dirs.push(id);
      return { ok: true, value: undefined };
    },
    async release(slot, id) {
      calls.push(`release ${slot}`);
      const s = state.get(slot)!;
      s.dirs = s.dirs.filter((dir) => dir !== id);
      const dataEmpty = !s.dirs.length && !s.other;
      if (dataEmpty) s.bootId = randomUUID(); // the supervisor exited and restarted
      return { ok: true, value: { dataEmpty, logoutFailed: false } };
    },
    async status(slot, id, client) {
      calls.push(`status ${slot} ${client}`);
      if (!reported.reachable) return { ok: false, code: 'unreachable' };
      return { ok: true, value: { ...reported.status, bootId: state.get(slot)!.bootId } };
    },
    async logout(slot, id, client) {
      calls.push(`logout ${slot} ${client}`);
      if (!reported.reachable) return { ok: false, code: 'unreachable' };
      return { ok: true, value: { logout: reported.logout, bootId: state.get(slot)!.bootId } };
    },
  };
  /** What the slot's CLI reports next (T4): its status and the outcome of its own logout. */
  const reported: { reachable: boolean; status: RuntimeClientStatus; logout: string } = { reachable: true, status: { signedIn: false, facts: null }, logout: 'ok' };
  return { manager, state, calls, reported };
}

describe('binding a slot to its owner', () => {
  test('two owners get two slots; a third sees the pool full; binding is idempotent', async () => {
    const { store } = memoryStore();
    const { manager, state } = fakeManager(['runtime-1', 'runtime-2']);
    const runtime = agentRuntimeUseCases(on, store, manager);
    assert.equal((await runtime.status('ada')).pool, 'starting', 'nothing is bindable before the worker saw the slots');
    await reconcileAgentRuntime({ config: on, store, manager });
    assert.equal((await runtime.status('ada')).pool, 'available');
    const ada = await runtime.bind('ada');
    assert.equal(ada.binding?.state, 'active');
    assert.deepEqual(await runtime.bind('ada'), ada);
    assert.equal((await runtime.bind('jonas')).binding?.state, 'active');
    const slotsOf = [...state.values()].map((s) => s.dirs.length);
    assert.deepEqual(slotsOf, [1, 1]);
    await assert.rejects(runtime.bind('mia'), (error: DomainError) => error.code === 'AGENT_RUNTIME_POOL_FULL' && error.status === 409);
    const mia = await runtime.status('mia');
    assert.equal(mia.pool, 'full');
    assert.equal(mia.binding, null);
  });

  test('off: status says so and every command answers AGENT_RUNTIME_OFF', async () => {
    const { store } = memoryStore();
    const runtime = agentRuntimeUseCases({ clients: [], commercialTermsAgreedOn: null, idleDays: null, manager: null }, store, null);
    assert.deepEqual(await runtime.status('ada'), { enabled: false, clients: { claude_code: 'off', codex: 'off' }, commercialTerms: null, idleReleaseDays: null, pool: 'off', binding: null, lastRelease: null,
      connections: { claude_code: null, codex: null } });
    await assert.rejects(runtime.bind('ada'), (error: DomainError) => error.code === 'AGENT_RUNTIME_OFF');
    await assert.rejects(runtime.remove('ada'), (error: DomainError) => error.code === 'AGENT_RUNTIME_OFF');
    // T4: the sign-in commands answer the same way.
    for (const command of [() => runtime.consoleTarget('ada', 'claude_code'), () => runtime.signOut('ada', 'claude_code', 'ada-session'), () => runtime.check('ada', 'claude_code', 'ada-session'),
      () => runtime.dismissAccountNotice('ada', 'claude_code'), () => runtime.recordSignIn('ada', { operation: {} as RuntimeAuthOperation, method: 'sso' }, { signedIn: true, facts: null, bootId: randomUUID() })]) {
      await assert.rejects(command(), (error: DomainError) => error.code === 'AGENT_RUNTIME_OFF');
    }
  });

  test('Codex is pending in this version even when the operator lists it', async () => {
    const runtime = agentRuntimeUseCases({ ...on, clients: ['claude_code', 'codex'] }, memoryStore().store, fakeManager([]).manager);
    assert.deepEqual((await runtime.status('ada')).clients, { claude_code: 'available', codex: 'pending' });
  });

  test('a slot that refuses the bind (stray entry) leaves the pool and the owner may try again', async () => {
    const { store, slots } = memoryStore();
    const { manager, state } = fakeManager(['runtime-1', 'runtime-2']);
    await reconcileAgentRuntime({ config: on, store, manager });
    state.get('runtime-1')!.other = 1; // appeared after the report
    const runtime = agentRuntimeUseCases(on, store, manager);
    await assert.rejects(runtime.bind('ada'), (error: DomainError) => error.code === 'AGENT_RUNTIME_UNAVAILABLE');
    assert.equal(slots.get('runtime-1')!.state, 'out_of_pool');
    assert.equal((await runtime.bind('ada')).binding?.state, 'active', 'the next attempt uses another slot');
  });
});

describe('release and reuse', () => {
  test('remove → sign out, delete, exit; the slot is bound again only after a new boot id and an empty /data', async () => {
    const { store, slots } = memoryStore();
    const { manager, state, calls } = fakeManager(['runtime-1']);
    const runtime = agentRuntimeUseCases(on, store, manager);
    await reconcileAgentRuntime({ config: on, store, manager });
    await runtime.bind('ada');
    const bootBefore = state.get('runtime-1')!.bootId;
    assert.equal((await runtime.remove('ada')).binding?.state, 'releasing');
    await assert.rejects(runtime.bind('jonas'), (error: DomainError) => error.code === 'AGENT_RUNTIME_POOL_FULL');
    // The supervisor exits after the release, but its old boot id answers once more (the restart is slower).
    const release = manager.release.bind(manager);
    manager.release = async (slot, id) => { const out = await release(slot, id); state.get(slot)!.bootId = bootBefore; return out; };
    const first = await reconcileAgentRuntime({ config: on, store, manager });
    assert.equal(first.released.length, 1);
    assert.equal(slots.get('runtime-1')!.state, 'wiping');
    await reconcileAgentRuntime({ config: on, store, manager });
    assert.equal(slots.get('runtime-1')!.state, 'wiping', 'the same boot id is not a fresh process');
    await assert.rejects(runtime.bind('jonas'), (error: DomainError) => error.code === 'AGENT_RUNTIME_UNAVAILABLE');
    state.get('runtime-1')!.bootId = randomUUID(); // the restart policy started a new supervisor
    await reconcileAgentRuntime({ config: on, store, manager });
    assert.equal(slots.get('runtime-1')!.state, 'ready');
    assert.equal((await runtime.bind('jonas')).binding?.state, 'active');
    assert.deepEqual((await runtime.status('ada')).lastRelease?.reason, 'owner');
    assert.deepEqual(calls.filter((c) => c.startsWith('release')), ['release runtime-1']);
  });

  test('after a restore: a binding without a directory shows Sign in again; a directory without a binding is released', async () => {
    const { store, bindings, slots } = memoryStore();
    const { manager, state } = fakeManager(['runtime-1', 'runtime-2']);
    const runtime = agentRuntimeUseCases(on, store, manager);
    await reconcileAgentRuntime({ config: on, store, manager });
    await runtime.bind('ada');
    await runtime.bind('jonas');
    const adaSlot = bindings.find((b) => b.ownerUserId === 'ada')!.slot;
    const jonasSlot = bindings.find((b) => b.ownerUserId === 'jonas')!.slot;
    // The restored database: Ada's directory is gone (volume newer than the backup), and Jonas's binding
    // is not in it although his directory is.
    state.get(adaSlot)!.dirs = [];
    bindings.splice(bindings.findIndex((b) => b.ownerUserId === 'jonas'), 1);
    const report = await reconcileAgentRuntime({ config: on, store, manager });
    assert.equal(report.orphans, 1);
    assert.equal((await runtime.status('ada')).binding?.state, 'sign_in_again');
    assert.deepEqual(state.get(jonasSlot)!.dirs, []);
    assert.equal(slots.get(jonasSlot)!.state, 'wiping');
    // Signing in again binds the same slot afresh.
    assert.equal((await runtime.bind('ada')).binding?.state, 'active');
    assert.deepEqual(state.get(adaSlot)!.dirs.length, 1);
  });

  test('stray entries put a slot out of the pool until the operator fixes it and the supervisor restarts', async () => {
    const { store, slots } = memoryStore();
    const { manager, state } = fakeManager(['runtime-1']);
    state.get('runtime-1')!.other = 2;
    const first = await reconcileAgentRuntime({ config: on, store, manager });
    assert.deepEqual(first.outOfPool, ['runtime-1']);
    state.get('runtime-1')!.other = 0;
    await reconcileAgentRuntime({ config: on, store, manager });
    assert.equal(slots.get('runtime-1')!.state, 'out_of_pool', 'still the same process');
    state.get('runtime-1')!.bootId = randomUUID();
    await reconcileAgentRuntime({ config: on, store, manager });
    assert.equal(slots.get('runtime-1')!.state, 'ready');
  });

  test('a slot removed from Compose leaves the pool; an unreachable one is not offered', async () => {
    const { store, slots } = memoryStore();
    const { manager, state } = fakeManager(['runtime-1', 'runtime-2']);
    await reconcileAgentRuntime({ config: on, store, manager });
    state.get('runtime-1')!.reachable = false;
    state.delete('runtime-2');
    await reconcileAgentRuntime({ config: on, store, manager });
    assert.equal(slots.get('runtime-1')!.state, 'unknown');
    assert.deepEqual([slots.get('runtime-2')!.state, slots.get('runtime-2')!.outOfPoolReason], ['out_of_pool', 'missing']);
  });

  test('the idle policy releases a binding unused for that many days; the owner sees the date first', async () => {
    const { store, bindings } = memoryStore();
    const { manager } = fakeManager(['runtime-1']);
    const config = { ...on, idleDays: 30 };
    const runtime = agentRuntimeUseCases(config, store, manager);
    await reconcileAgentRuntime({ config, store, manager });
    const status = await runtime.bind('ada');
    assert.ok(status.binding?.idleReleaseAt && Date.parse(status.binding.idleReleaseAt) > Date.now() + 29 * 86_400_000);
    await reconcileAgentRuntime({ config, store, manager });
    assert.equal(bindings[0]!.state, 'active');
    const later = () => new Date(Date.now() + 31 * 86_400_000);
    const report = await reconcileAgentRuntime({ config, store, manager, now: later });
    assert.equal(report.idle, 1);
    assert.equal(report.released.length, 1);
    assert.equal((await runtime.status('ada')).lastRelease?.reason, 'idle');
  });

  test('a manager that cannot be reached changes nothing', async () => {
    const { store, slots } = memoryStore();
    const report = await reconcileAgentRuntime({ config: on, store, manager: { slots: async () => ({ ok: false, code: 'unreachable' }), bind: async () => ({ ok: false, code: 'x' }), release: async () => ({ ok: false, code: 'x' }),
      status: async () => ({ ok: false, code: 'x' }), logout: async () => ({ ok: false, code: 'x' }) } });
    assert.equal(report.error, 'unreachable');
    assert.equal(slots.size, 0);
  });
});

describe('sign-in to Claude Code (T4 #279)', () => {
  const facts = (account: string, authMethod = 'claude.ai', plan: string | null = 'max') =>
    ({ signedIn: true, facts: { authMethod, plan, accountLabel: `${account[0]}***@${account.split('@')[1]}`, accountDigest: createHash('sha256').update(account).digest('hex') } });
  async function owned(fingerprint = true) {
    const { store, slots, connections } = memoryStore();
    const { manager, reported, calls } = fakeManager(['runtime-1', 'runtime-2']);
    await reconcileAgentRuntime({ config: on, store, manager });
    const runtime = agentRuntimeUseCases(on, store, manager, fingerprint ? { accountFingerprint: (digest) => `k${digest}`.slice(0, 64) } : {});
    const target = await runtime.consoleTarget('ada', 'claude_code');
    return { runtime, store, slots, connections, manager, reported, calls, target };
  }

  const actor = { ownerUserId: 'ada', sessionId: 'ada-session' };
  async function consoleOperation(runtime: AgentRuntimeUseCases) {
    return (await runtime.beginConsole(actor, 'claude_code', { digest: createHash('sha256').update(randomUUID()).digest('hex'), expiresAt: new Date(Date.now()+60_000) })).operation;
  }
  async function record(runtime: AgentRuntimeUseCases, method: 'sso' | 'console' | 'claude_account' | null, reported: RuntimeClientStatus) {
    const operation = await consoleOperation(runtime);
    return (await runtime.recordSignIn('ada', { operation, method }, { ...reported, bootId: operation.bootId })).status;
  }

  test('the console runs in the owner\'s own slot, bound first; off, Codex and a removed runtime are refused', async () => {
    const { runtime, target } = await owned();
    assert.equal(target.slot, 'runtime-1');
    assert.equal((await runtime.status('ada')).binding?.state, 'active');
    assert.deepEqual(await runtime.consoleTarget('ada', 'claude_code'), target, 'idempotent');
    await assert.rejects(runtime.consoleTarget('ada', 'codex'), (error: DomainError) => error.code === 'AGENT_RUNTIME_CLIENT_UNAVAILABLE');
    const offRuntime = agentRuntimeUseCases({ ...on, clients: [] }, memoryStore().store, fakeManager([]).manager);
    await assert.rejects(offRuntime.consoleTarget('ada', 'claude_code'), (error: DomainError) => error.code === 'AGENT_RUNTIME_OFF');
    await runtime.remove('ada');
    await assert.rejects(runtime.consoleTarget('ada', 'claude_code'), (error: DomainError) => error.code === 'AGENT_RUNTIME_RELEASING');
  });

  test('only the CLI\'s own status signs a connection in; a console that ended without it leaves it signed out', async () => {
    const { runtime } = await owned();
    const notYet = await record(runtime, 'sso', { signedIn: false, facts: null });
    assert.equal(notYet.connections.claude_code?.state, 'signed_out');
    assert.equal(notYet.connections.claude_code?.signInMethod, 'sso');
    // Negative control: the status reports a login, so the same call signs in.
    const signedIn = await record(runtime, 'sso', facts('ada@example.org'));
    assert.deepEqual({ ...signedIn.connections.claude_code, signedInAt: null }, { state: 'signed_in', signInMethod: 'sso', authMethod: 'claude.ai', plan: 'max',
      accountLabel: 'a***@example.org', signedInAt: null, payer: 'claude_plan', accountChange: null, signOut: null });
    // A status that no longer reports the login: Sign in again, never silently signed in.
    const lost = await record(runtime, null, { signedIn: false, facts: null });
    assert.equal(lost.connections.claude_code?.state, 'sign_in_again');
    assert.equal(lost.connections.claude_code?.payer, null);
  });

  test('a later sign-in to a different account shows a notice until dismissed; the same account does not', async () => {
    const { runtime } = await owned();
    const observe = (account: string) => record(runtime, 'claude_account', facts(account));
    assert.equal((await observe('ada@example.org')).connections.claude_code?.accountChange, null, 'the first account is no change');
    assert.equal((await observe('ada@example.org')).connections.claude_code?.accountChange, null, 'the same account again is no change');
    await runtime.signOut('ada', 'claude_code', 'ada-session');
    const other = await observe('mallory@example.net');
    assert.equal(other.connections.claude_code?.accountChange?.previousLabel, 'a***@example.org', 'compared across a sign-out');
    assert.equal(other.connections.claude_code?.accountLabel, 'm***@example.net');
    // Same masked label, different account: the keyed fingerprint still tells them apart.
    await runtime.dismissAccountNotice('ada', 'claude_code');
    assert.equal((await runtime.status('ada')).connections.claude_code?.accountChange, null);
    const twin = await observe('mx@example.net');
    assert.equal(twin.connections.claude_code?.accountLabel, 'm***@example.net');
    assert.ok(twin.connections.claude_code?.accountChange, 'a different account behind the same label is a change');
  });

  test('without a fingerprint, accounts are compared by their masked label', async () => {
    const { runtime } = await owned(false);
    const observe = (account: string) => record(runtime, 'claude_account', { signedIn: true, facts: { ...facts(account).facts, accountDigest: null } });
    await observe('ada@example.org');
    assert.equal((await observe('ab@example.org')).connections.claude_code?.accountChange, null, 'same label');
    assert.ok((await observe('bob@example.org')).connections.claude_code?.accountChange);
  });

  test('after Remove runtime, the next sign-in is still compared with the last account', async () => {
    const { runtime, target, store, manager } = await owned();
    await record(runtime, 'claude_account', facts('ada@example.org'));
    const oldOperation = await consoleOperation(runtime);
    await runtime.remove('ada');
    assert.equal((await runtime.status('ada')).connections.claude_code, null, 'a removed runtime has no connection');
    await reconcileAgentRuntime({ config: on, store, manager });
    await reconcileAgentRuntime({ config: on, store, manager });
    const again = await runtime.consoleTarget('ada', 'claude_code');
    assert.notEqual(again.bindingId, target.bindingId);
    const other = await record(runtime, 'claude_account', facts('mallory@example.net'));
    assert.equal(other.connections.claude_code?.accountChange?.previousLabel, 'a***@example.org');
    // A sign-in recorded for a binding that is no longer the owner's live one changes nothing.
    const stale = await runtime.recordSignIn('ada', { operation: oldOperation, method: 'sso' }, { ...facts('eve@example.com'), bootId: oldOperation.bootId });
    assert.equal(stale.disposition, 'superseded');
    assert.equal(stale.signedIn, false, 'a newer owner view is never this old operation success');
    assert.equal(stale.status.connections.claude_code?.accountLabel, 'm***@example.net');
  });

  test('sign-out disables authority on unknown effects and resumes only after verified recovery', async () => {
    const { runtime, reported, calls, store, manager } = await owned();
    await record(runtime, 'console', facts('ada@example.org', 'api_key', null));
    assert.equal((await runtime.status('ada')).connections.claude_code?.payer, 'anthropic_console');
    reported.reachable = false;
    await assert.rejects(runtime.signOut('ada', 'claude_code', 'ada-session'), (error: DomainError) => error.code === 'AGENT_RUNTIME_UNAVAILABLE');
    assert.equal((await runtime.status('ada')).binding?.state, 'releasing');
    assert.equal((await runtime.status('ada')).connections.claude_code, null, 'unknown logout cannot retain runtime authority');
    await assert.rejects(runtime.beginConsole(actor, 'claude_code', { digest: 'a'.repeat(64), expiresAt: new Date(Date.now()+60_000) }));
    reported.reachable = true;
    await reconcileAgentRuntime({ config: on, store, manager });
    await reconcileAgentRuntime({ config: on, store, manager });
    await runtime.bind('ada');
    reported.logout = 'failed';
    const out = await runtime.signOut('ada', 'claude_code', 'ada-session');
    assert.equal(out.connections.claude_code?.state, 'signed_out');
    assert.equal(out.connections.claude_code?.signOut?.failed, true);
    assert.ok(calls.includes('logout runtime-1 claude_code'));
    reported.logout = 'ok';
    await record(runtime, 'console', facts('ada@example.org', 'api_key', null));
    assert.equal((await runtime.signOut('ada', 'claude_code', 'ada-session')).connections.claude_code?.signOut?.failed, false);
  });

  for (const outcome of ['ok', 'failed', 'timeout', 'not_installed', 'skipped'] as const) {
    test(`completed ${outcome} sign-out preserves the honest vendor-session warning`, async () => {
      const { runtime, reported } = await owned();
      await record(runtime, 'claude_account', facts('ada@example.org'));
      reported.logout = outcome;
      const after = await runtime.signOut('ada', 'claude_code', 'ada-session');
      assert.equal(after.connections.claude_code?.state, 'signed_out');
      assert.equal(after.connections.claude_code?.signOut?.failed, outcome !== 'ok');
    });
  }

  test('check reads the CLI\'s status again', async () => {
    const { runtime, reported } = await owned();
    reported.status = facts('ada@example.org');
    assert.equal((await runtime.check('ada', 'claude_code', 'ada-session')).connections.claude_code?.state, 'signed_in');
    reported.reachable = false;
    await assert.rejects(runtime.check('ada', 'claude_code', 'ada-session'), (error: DomainError) => error.code === 'AGENT_RUNTIME_UNAVAILABLE');
  });

  test('the payer comes from the reported method only, never guessed', () => {
    assert.equal(runtimePayer('claude.ai'), 'claude_plan');
    assert.equal(runtimePayer('api_key'), 'anthropic_console');
    for (const method of ['unknown', 'oauth_token', 'third_party', 'api_key_helper', null]) assert.equal(runtimePayer(method), 'unknown');
  });
});
