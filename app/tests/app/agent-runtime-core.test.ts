import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, test } from 'node:test';
import {
  agentRuntimeUseCases, loadAgentRuntimeConfig, parseAgentRuntimeClients, reconcileAgentRuntime, DomainError,
  type AgentRuntimeConfig, type AgentRuntimeStore, type RuntimeBindingRow, type RuntimeManagerPort, type RuntimeSlotRow, type RuntimeSlotSighting,
} from '@flux/core';
import { parseRuntimeSwitch } from '@flux/runtime-protocol';

// F-022 T3: the owner's slot binding and the worker's reconciliation, over an in-memory store and a
// scripted manager. The PostgreSQL adapter runs the same use cases in agent-runtime.test.ts.

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
  const store: AgentRuntimeStore = {
    async ownerView(owner) {
      const binding = live().find((b) => b.ownerUserId === owner) ?? null;
      const last = bindings.filter((b) => b.ownerUserId === owner && b.releasedAt).at(-1);
      const all = [...slots.values()];
      return {
        binding,
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
      return b;
    },
    async recordCommercialTerms() {},
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
  return { store, slots, bindings };
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
  };
  return { manager, state, calls };
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
    assert.deepEqual(await runtime.status('ada'), { enabled: false, clients: { claude_code: 'off', codex: 'off' }, commercialTerms: null, idleReleaseDays: null, pool: 'off', binding: null, lastRelease: null });
    await assert.rejects(runtime.bind('ada'), (error: DomainError) => error.code === 'AGENT_RUNTIME_OFF');
    await assert.rejects(runtime.remove('ada'), (error: DomainError) => error.code === 'AGENT_RUNTIME_OFF');
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
    const report = await reconcileAgentRuntime({ config: on, store, manager: { slots: async () => ({ ok: false, code: 'unreachable' }), bind: async () => ({ ok: false, code: 'x' }), release: async () => ({ ok: false, code: 'x' }) } });
    assert.equal(report.error, 'unreachable');
    assert.equal(slots.size, 0);
  });
});
