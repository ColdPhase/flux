import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { describe, test } from 'node:test';
import {
  agentRuntimeUseCases, loadAgentRuntimeConfig, parseAgentRuntimeClients, reconcileAgentRuntime, runtimePayer, DomainError,
  type AgentRuntimeConfig, type AgentRuntimeStore, type RuntimeBindingRow, type RuntimeClientStatus, type RuntimeConnectionRow, type RuntimeManagerPort,
  type RuntimeSlotRow, type RuntimeSlotSighting, type RuntimeAuthOperation, type AgentRuntimeUseCases,
} from '@flux/core';
import type { PlanModelEntry, PlanModels } from '@flux/contracts';
import { parseRuntimeSwitch } from '@flux/runtime-protocol';

// F-022 T3: the owner's slot binding and the worker's reconciliation, over an in-memory store and a
// scripted manager. The PostgreSQL adapter runs the same use cases in agent-runtime.test.ts. T4 (#279):
// recording a sign-in only from the CLI's status, the account-change notice and sign-out.

const secret = 'm'.repeat(40);
const on: AgentRuntimeConfig = { clients: ['claude_code'], commercialTermsAgreedOn: '2026-10-01', idleDays: null, manager: { url: 'http://runtime-manager-control:7600', secret } };

describe('operator configuration', () => {
  test('off by default; on needs the manager secret and, for Claude Code, the Commercial Terms date', () => {
    assert.deepEqual(loadAgentRuntimeConfig({}), { clients: [], commercialTermsAgreedOn: null, idleDays: null, manager: null, offReason: null });
    // #1438: the launcher's one line about a host that cannot run it, only while it is off, in one bounded line.
    assert.equal(loadAgentRuntimeConfig({ FLUX_AGENT_RUNTIME_OFF_REASON: '  the Docker engine\n is not a Linux engine ' }).offReason, 'the Docker engine is not a Linux engine');
    assert.equal(loadAgentRuntimeConfig({ FLUX_AGENT_RUNTIME_OFF_REASON: 'x'.repeat(400) }).offReason?.length, 300);
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
  const bindings: (RuntimeBindingRow & { releasedAt: Date | null; logoutFailed?: boolean })[] = [];
  const live = () => bindings.filter((b) => b.state !== ('released' as string));
  type Connection = RuntimeConnectionRow & { ownerUserId: string; fingerprint: string | null; revoked: boolean; modelsCheckedAt?: Date | null; models?: PlanModels | null };
  const connections: Connection[] = [];
  const revoke = (bindingId: string) => { for (const c of connections) if (c.bindingId === bindingId && !c.revoked) Object.assign(c, { revoked: true, state: 'signed_out', signedInAt: null }); };
  const view = (c: Connection): RuntimeConnectionRow => ({ client: c.client, bindingId: c.bindingId, state: c.state, signInMethod: c.signInMethod,
    authMethod: c.authMethod, plan: c.plan, accountLabel: c.accountLabel, signedInAt: c.signedInAt, accountChangedAt: c.accountChangedAt,
    previousAccountLabel: c.previousAccountLabel, signedOutAt: c.signedOutAt, signOutFailed: c.signOutFailed, modelsStatus: c.models?.state ?? null });
  // A deterministic port fixture; cross-process clock/CAS behavior is tested with real PostgreSQL.
  const operations = new Map<string, RuntimeAuthOperation>();
  // The durable client history (migration 0118): "bindingId client" while a login may exist for that client.
  const history = new Set<string>();
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
      if (input.kind === 'console') history.add(key);
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
        lastRelease: last ? { reason: last.releaseReason!, at: last.releasedAt!, signOutFailed: last.logoutFailed === true } : null,
        slots: { ready: all.filter((s) => s.state === 'ready').length },
        commercialTerms: null,
      };
    },
    async reserve(owner, id) {
      const existing = live().find((b) => b.ownerUserId === owner);
      if (existing) return { kind: 'existing', binding: existing };
      const ready = [...slots.values()].filter((s) => s.state === 'ready').sort((a, b) => live().filter((x) => x.slot === a.slot).length - live().filter((x) => x.slot === b.slot).length)[0];
      if (!ready) return { kind: 'starting' };
      const binding = { id, ownerUserId: owner, slot: ready.slot, state: 'binding' as const, createdAt: new Date(), lastUsedAt: null, idleSince: new Date(), releaseReason: null, releasedAt: null };
      bindings.push(binding);
      return { kind: 'reserved', binding };
    },
    async activate(id) { const b = bindings.find((x) => x.id === id && ['binding', 'sign_in_again'].includes(x.state)); if (b) b.state = 'active'; },
    async abandon(id) {
      const index = bindings.findIndex((b) => b.id === id && b.state === 'binding');
      if (index >= 0) bindings.splice(index, 1);
    },
    async requestRelease(target, reason) {
      const b = live().find((x) => ('ownerUserId' in target ? x.ownerUserId === target.ownerUserId : x.id === target.bindingId) && x.state !== 'releasing');
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
      if (record.signedIn && record.facts) history.add(record.bindingId + record.client);
      if (!record.signedIn || !record.facts) {
        Object.assign(row, { state: row.state === 'signed_out' ? 'signed_out' : 'sign_in_again', signedInAt: null });
        return true;
      }
      const before = [row, ...connections.filter((c) => c.revoked).reverse()].find((c) => c.ownerUserId === record.ownerUserId && c.client === record.client && (c.accountLabel || c.fingerprint));
      const changed = Boolean(before) && (before!.fingerprint && record.fingerprint ? before!.fingerprint !== record.fingerprint : (before!.accountLabel ?? '') !== (record.facts.accountLabel ?? ''));
      // A new sign-in or another account has other models: the list is read again (#1332).
      if (changed || row.state !== 'signed_in') Object.assign(row, { models: null, modelsCheckedAt: null });
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
      Object.assign(row, { state: 'signed_out', signedInAt: null, signedOutAt: new Date(), signOutFailed: failed, models: null, modelsCheckedAt: null });
      if (!failed) history.delete(bindingId + client);
      return true;
    },
    async loginPossible(bindingId) { return (['claude_code', 'codex'] as const).filter((client) => history.has(bindingId + client)); },
    async dismissAccountNotice(owner, client) {
      for (const c of connections) if (c.ownerUserId === owner && c.client === client && !c.revoked) Object.assign(c, { accountChangedAt: null, previousAccountLabel: null });
    },
    async slotsWithBindings() { return [...slots.values()].map((slot) => ({ slot: { ...slot }, bindings: live().filter((b) => b.slot === slot.slot) })); },
    async saveSlot(slot) { slots.set(slot.slot, { ...slot }); },
    async markSignInAgain(id) { const b = bindings.find((x) => x.id === id && x.state === 'active'); if (b) b.state = 'sign_in_again'; },
    async completeRelease(id, logoutFailed) {
      const b = bindings.find((x) => x.id === id && x.state === 'releasing');
      if (b) { (b as { state: string }).state = 'released'; b.releasedAt = new Date(); b.logoutFailed = logoutFailed; }
    },
    async dropStaleReservation(id, olderThan) {
      const index = bindings.findIndex((b) => b.id === id && b.state === 'binding' && b.createdAt < olderThan);
      if (index < 0) return false;
      bindings.splice(index, 1);
      return true;
    },
    async idleBindings(before) { return live().filter((b) => b.state === 'active' && (b.lastUsedAt ?? b.createdAt) < before); },
    async modelsDue({ clients, refreshBefore, retryBefore, limit }) {
      return connections.filter((c) => c.state === 'signed_in' && !c.revoked && clients.includes(c.client) && bindings.some((b) => b.id === c.bindingId && b.state === 'active')
        && (!c.modelsCheckedAt || c.modelsCheckedAt < (c.models?.state === 'listed' ? refreshBefore : retryBefore)))
        .sort((a, b) => (a.modelsCheckedAt?.getTime() ?? 0) - (b.modelsCheckedAt?.getTime() ?? 0)).slice(0, limit)
        .map((c) => ({ bindingId: c.bindingId, slot: bindings.find((b) => b.id === c.bindingId)!.slot, client: c.client }));
    },
    async saveModels(bindingId, client, read, at) {
      const row = connections.find((c) => c.bindingId === bindingId && c.client === client && c.state === 'signed_in' && !c.revoked);
      if (!row) return;
      const day = at.toISOString().slice(0, 10);
      row.modelsCheckedAt = at;
      row.models = read ? { listed: [...read], retired: [], state: 'listed', checkedOn: day } : { listed: row.models?.listed ?? [], retired: row.models?.retired ?? [], state: 'unavailable', checkedOn: day };
    },
  };
  return { store, slots, bindings, connections, history };
}

/** The in-memory store and a scripted manager together, for tests that need several owners (#1332). */
function memoryStore2() {
  const stored = memoryStore();
  return { ...stored, ...fakeManager(['runtime-1', 'runtime-2']) };
}

/** A scripted runtime-manager: each runtime holds people's directories and a boot id. */
function fakeManager(names: string[]) {
  const state = new Map(names.map((slot) => [slot, { bootId: randomUUID(), dirs: [] as string[], other: 0, reachable: true, running: [] as string[] }]));
  const calls: string[] = [];
  const manager: RuntimeManagerPort = {
    async slots() {
      return { ok: true, value: [...state.entries()].map(([slot, s]): RuntimeSlotSighting => s.reachable
        ? { slot, reachable: true, bootId: s.bootId, bindings: [...s.dirs], other: s.other, capacity: 2, running: [...s.running] } : { slot, reachable: false, error: 'unreachable' }) };
    },
    async bind(slot, id) {
      calls.push(`bind ${slot}`);
      const s = state.get(slot)!;
      if (!s.reachable) return { ok: false, code: 'unreachable' };
      if (!s.dirs.includes(id)) s.dirs.push(id);
      return { ok: true, value: undefined };
    },
    async release(slot, id) {
      calls.push(`release ${slot}`);
      const s = state.get(slot)!;
      s.dirs = s.dirs.filter((dir) => dir !== id);
      return { ok: true, value: { deleted: true, logoutFailed: false, notInstalled: [] } };
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
    async models(slot, id, client) {
      calls.push(`models ${slot} ${client}`);
      if (!reported.reachable || !reported.models) return { ok: false, code: reported.reachable ? 'busy' : 'unreachable' };
      return { ok: true, value: { models: [...reported.models], bootId: state.get(slot)!.bootId } };
    },
  };
  /** What the slot's CLI reports next (T4): its status and the outcome of its own logout; `models` (#1332): the list it gives, or null when it cannot be read. */
  const reported: { reachable: boolean; status: RuntimeClientStatus; logout: string; models: PlanModelEntry[] | null } = { reachable: true, status: { signedIn: false, facts: null }, logout: 'ok', models: null };
  return { manager, state, calls, reported };
}

describe('a place in the runtime', () => {
  test('there is no fixed number of people: everyone gets a place in the one runtime; binding is idempotent (#860)', async () => {
    const { store, slots } = memoryStore();
    const { manager, state } = fakeManager(['runtime-1']);
    const runtime = agentRuntimeUseCases(on, store, manager);
    assert.equal((await runtime.status('ada')).pool, 'starting', 'nothing is bindable before the worker saw the runtime');
    await reconcileAgentRuntime({ config: on, store, manager });
    assert.equal((await runtime.status('ada')).pool, 'available');
    assert.equal(slots.get('runtime-1')!.capacity, 2, 'the worker records how many agents it runs at once');
    const ada = await runtime.bind('ada');
    assert.equal(ada.binding?.state, 'active');
    assert.deepEqual(await runtime.bind('ada'), ada);
    for (let person = 0; person < 20; person += 1) assert.equal((await runtime.bind(`person-${person}`)).binding?.state, 'active');
    assert.equal(state.get('runtime-1')!.dirs.length, 21);
    assert.equal((await runtime.status('person-19')).pool, 'available');
  });

  test('off: status says so and every command answers AGENT_RUNTIME_OFF', async () => {
    const { store } = memoryStore();
    const runtime = agentRuntimeUseCases({ clients: [], commercialTermsAgreedOn: null, idleDays: null, manager: null }, store, null);
    assert.deepEqual(await runtime.status('ada'), { enabled: false, clients: { claude_code: 'off', codex: 'off' }, commercialTerms: null, idleReleaseDays: null, pool: 'off', binding: null, lastRelease: null,
      connections: { claude_code: null, codex: null }, offReason: null });
    const reasoned = agentRuntimeUseCases({ clients: [], commercialTermsAgreedOn: null, idleDays: null, manager: null, offReason: 'the Docker engine is not a Linux engine' }, store, null);
    assert.equal((await reasoned.status('ada')).offReason, 'the Docker engine is not a Linux engine', 'Settings › AI can say why (#1438)');
    await assert.rejects(runtime.bind('ada'), (error: DomainError) => error.code === 'AGENT_RUNTIME_OFF');
    await assert.rejects(runtime.remove('ada'), (error: DomainError) => error.code === 'AGENT_RUNTIME_OFF');
    // T4: the sign-in commands answer the same way.
    for (const command of [() => runtime.consoleTarget('ada', 'claude_code'), () => runtime.signOut('ada', 'claude_code', 'ada-session'), () => runtime.check('ada', 'claude_code', 'ada-session'),
      () => runtime.dismissAccountNotice('ada', 'claude_code'), () => runtime.recordSignIn('ada', { operation: {} as RuntimeAuthOperation, method: 'sso' }, { signedIn: true, facts: null, bootId: randomUUID() })]) {
      await assert.rejects(command(), (error: DomainError) => error.code === 'AGENT_RUNTIME_OFF');
    }
  });

  test('Codex is available when the operator lists it (F-022 T6, #281); a client the operator did not list is off', async () => {
    const runtime = agentRuntimeUseCases({ ...on, clients: ['claude_code', 'codex'] }, memoryStore().store, fakeManager([]).manager);
    assert.deepEqual((await runtime.status('ada')).clients, { claude_code: 'available', codex: 'available' });
    const claudeOnly = agentRuntimeUseCases(on, memoryStore().store, fakeManager([]).manager);
    assert.equal((await claudeOnly.status('ada')).clients.codex, 'off');
  });

  test('a runtime that cannot prepare a place drops the reservation and the owner may try again', async () => {
    const { store, bindings } = memoryStore();
    const { manager, state } = fakeManager(['runtime-1']);
    await reconcileAgentRuntime({ config: on, store, manager });
    state.get('runtime-1')!.reachable = false;
    const runtime = agentRuntimeUseCases(on, store, manager);
    await assert.rejects(runtime.bind('ada'), (error: DomainError) => error.code === 'AGENT_RUNTIME_UNAVAILABLE');
    assert.equal(bindings.length, 0);
    state.get('runtime-1')!.reachable = true;
    assert.equal((await runtime.bind('ada')).binding?.state, 'active');
  });
});

describe('release and reuse', () => {
  test('#860: reconciling ends the runs no runtime has, only when every runtime answered', async () => {
    const { manager, state } = fakeManager(['runtime-1']);
    state.get('runtime-1')!.running = ['run-a'];
    const seen: string[][] = [];
    const endLostRuns = async (running: string[]) => { seen.push(running); return 0; };
    await reconcileAgentRuntime({ config: on, store: memoryStore().store, manager, endLostRuns });
    assert.deepEqual(seen, [['run-a']]);
    state.get('runtime-1')!.reachable = false;
    await reconcileAgentRuntime({ config: on, store: memoryStore().store, manager, endLostRuns });
    assert.equal(seen.length, 1, 'a runtime that did not answer may still have its runs');
  });

  test('remove → sign out and delete that person only; nobody else is touched and the runtime stays ready (#860)', async () => {
    const { store, slots } = memoryStore();
    const { manager, state, calls } = fakeManager(['runtime-1']);
    const runtime = agentRuntimeUseCases(on, store, manager);
    await reconcileAgentRuntime({ config: on, store, manager });
    await runtime.bind('ada');
    await runtime.bind('jonas');
    const boot = state.get('runtime-1')!.bootId;
    assert.equal((await runtime.remove('ada')).binding?.state, 'releasing');
    assert.equal((await runtime.bind('mia')).binding?.state, 'active', 'a release holds nobody else back');
    const report = await reconcileAgentRuntime({ config: on, store, manager });
    assert.equal(report.released.length, 1);
    assert.equal(slots.get('runtime-1')!.state, 'ready');
    assert.equal(state.get('runtime-1')!.bootId, boot, 'the runtime does not restart');
    assert.equal(state.get('runtime-1')!.dirs.length, 2);
    assert.equal((await runtime.status('jonas')).binding?.state, 'active');
    assert.deepEqual((await runtime.status('ada')).lastRelease?.reason, 'owner');
    assert.deepEqual(calls.filter((c) => c.startsWith('release')), ['release runtime-1']);
  });

  test('a release that could not delete everything stays pending and is tried again', async () => {
    const { store } = memoryStore();
    const { manager } = fakeManager(['runtime-1']);
    const runtime = agentRuntimeUseCases(on, store, manager);
    await reconcileAgentRuntime({ config: on, store, manager });
    await runtime.bind('ada');
    await runtime.remove('ada');
    const release = manager.release.bind(manager);
    manager.release = async () => ({ ok: true, value: { deleted: false, logoutFailed: false, notInstalled: [] } });
    assert.deepEqual((await reconcileAgentRuntime({ config: on, store, manager })).released, []);
    assert.equal((await runtime.status('ada')).binding?.state, 'releasing');
    manager.release = release;
    assert.equal((await reconcileAgentRuntime({ config: on, store, manager })).released.length, 1);
  });

  test('after a restore: a binding without a directory shows Sign in again; a directory without a binding is released', async () => {
    const { store, bindings, slots } = memoryStore();
    const { manager, state } = fakeManager(['runtime-1']);
    const runtime = agentRuntimeUseCases(on, store, manager);
    await reconcileAgentRuntime({ config: on, store, manager });
    await runtime.bind('ada');
    await runtime.bind('jonas');
    await runtime.bind('mia');
    const dirs = state.get('runtime-1')!;
    const adaDir = bindings.find((b) => b.ownerUserId === 'ada')!.id;
    const jonasDir = bindings.find((b) => b.ownerUserId === 'jonas')!.id;
    const miaDir = bindings.find((b) => b.ownerUserId === 'mia')!.id;
    // The restored database: Ada's directory is gone (volume newer than the backup), and Jonas's binding
    // is not in it although his directory is.
    dirs.dirs = dirs.dirs.filter((dir) => dir !== adaDir);
    bindings.splice(bindings.findIndex((b) => b.ownerUserId === 'jonas'), 1);
    const report = await reconcileAgentRuntime({ config: on, store, manager });
    assert.equal(report.orphans, 1);
    assert.equal((await runtime.status('ada')).binding?.state, 'sign_in_again');
    assert.deepEqual(dirs.dirs, [miaDir], 'only his directory went');
    assert.equal(slots.get('runtime-1')!.state, 'ready');
    assert.ok(jonasDir);
    // Signing in again makes her place afresh.
    assert.equal((await runtime.bind('ada')).binding?.state, 'active');
    assert.equal(dirs.dirs.length, 2);
  });

  test('a directory made while the worker reconciles is not taken for an orphan (#331 m8)', async () => {
    const { store } = memoryStore();
    const { manager, state } = fakeManager(['runtime-1']);
    const runtime = agentRuntimeUseCases(on, store, manager);
    await reconcileAgentRuntime({ config: on, store, manager });
    const sightings = manager.slots.bind(manager);
    manager.slots = async () => { const seen = await sightings(); await runtime.bind('ada'); return seen; };
    const report = await reconcileAgentRuntime({ config: on, store, manager });
    assert.equal(report.orphans, 0);
    assert.equal(state.get('runtime-1')!.dirs.length, 1);
    assert.equal((await runtime.status('ada')).binding?.state, 'active');
  });

  test('a binding that activated after the sightings were taken is not sent to Sign in again (#331 m8)', async () => {
    const { store } = memoryStore();
    const { manager } = fakeManager(['runtime-1']);
    const runtime = agentRuntimeUseCases(on, store, manager);
    await reconcileAgentRuntime({ config: on, store, manager });
    await runtime.bind('ada');
    const real = manager.slots.bind(manager);
    let first = true;
    manager.slots = async () => {
      const out = await real();
      if (!first || !out.ok) return out;
      first = false;
      return { ok: true, value: out.value.map((sighting) => (sighting.reachable ? { ...sighting, bindings: [] } : sighting)) };
    };
    const report = await reconcileAgentRuntime({ config: on, store, manager });
    assert.deepEqual(report.signInAgain, []);
    assert.equal((await runtime.status('ada')).binding?.state, 'active');
  });

  test('a stray entry takes the runtime out of use until the operator removes it', async () => {
    const { store, slots } = memoryStore();
    const { manager, state } = fakeManager(['runtime-1']);
    state.get('runtime-1')!.other = 2;
    const first = await reconcileAgentRuntime({ config: on, store, manager });
    assert.deepEqual(first.outOfPool, ['runtime-1']);
    assert.equal(slots.get('runtime-1')!.outOfPoolReason, 'data_not_empty');
    state.get('runtime-1')!.other = 0;
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
      status: async () => ({ ok: false, code: 'x' }), logout: async () => ({ ok: false, code: 'x' }), models: async () => ({ ok: false, code: 'x' }) } });
    assert.equal(report.error, 'unreachable');
    assert.equal(slots.size, 0);
  });
});

describe('sign-in to Claude Code (T4 #279)', () => {
  const facts = (account: string, authMethod = 'claude.ai', plan: string | null = 'max') =>
    ({ signedIn: true, facts: { authMethod, plan, accountLabel: `${account[0]}***@${account.split('@')[1]}`, accountDigest: createHash('sha256').update(account).digest('hex') } });
  async function owned(fingerprint = true) {
    const { store, slots, connections, bindings } = memoryStore();
    const { manager, reported, calls } = fakeManager(['runtime-1', 'runtime-2']);
    await reconcileAgentRuntime({ config: on, store, manager });
    const runtime = agentRuntimeUseCases(on, store, manager, fingerprint ? { accountFingerprint: (digest) => `k${digest}`.slice(0, 64) } : {});
    const target = await runtime.consoleTarget('ada', 'claude_code');
    return { runtime, store, slots, connections, bindings, manager, reported, calls, target };
  }

  const actor = { ownerUserId: 'ada', sessionId: 'ada-session' };
  async function consoleOperation(runtime: AgentRuntimeUseCases) {
    return (await runtime.beginConsole(actor, 'claude_code', { digest: createHash('sha256').update(randomUUID()).digest('hex'), expiresAt: new Date(Date.now()+60_000) })).operation;
  }
  async function record(runtime: AgentRuntimeUseCases, method: 'sso' | 'console' | 'claude_account' | null, reported: RuntimeClientStatus) {
    const operation = await consoleOperation(runtime);
    return (await runtime.recordSignIn('ada', { operation, method }, { ...reported, bootId: operation.bootId })).status;
  }

  test('the console runs in the owner\'s own slot, bound first; off, a client the operator did not list and a removed runtime are refused', async () => {
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
      accountLabel: 'a***@example.org', signedInAt: null, payer: 'claude_plan', accountChange: null, signOut: null, usage: null });
    // A status that no longer reports the login: Sign in again, never silently signed in.
    const lost = await record(runtime, null, { signedIn: false, facts: null });
    assert.equal(lost.connections.claude_code?.state, 'sign_in_again');
    assert.equal(lost.connections.claude_code?.payer, null);
  });

  test('a guest of the company is shown none of their place or sign-ins; they are kept and shown again as a member (#1059)', async () => {
    const { runtime } = await owned();
    const shown = await record(runtime, 'claude_account', facts('ada@example.org'));
    assert.equal(shown.binding?.state, 'active');
    assert.equal(shown.connections.claude_code?.state, 'signed_in');
    const hidden = await runtime.status('ada', { hidden: true });
    assert.deepEqual([hidden.binding, hidden.lastRelease, hidden.connections, hidden.auth], [null, null, { claude_code: null, codex: null }, {}]);
    assert.deepEqual([hidden.enabled, hidden.pool, hidden.clients], [shown.enabled, shown.pool, shown.clients], 'what is the instance\'s stays');
    const back = await runtime.status('ada');
    assert.deepEqual([back.binding, back.connections], [shown.binding, shown.connections], 'nothing was removed: the same place and sign-in are back');
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

  describe('a plan\'s models are read from its CLI (#1332)', () => {
    const entry = (id: string, extra: Partial<PlanModelEntry> = {}): PlanModelEntry => ({ id, name: id.toUpperCase(), note: '', default: false, seesPictures: true, ...extra });
    const list = [entry('opus', { default: true }), entry('sonnet')];
    const modelsOf = (connections: { client: string; models?: unknown }[], client = 'claude_code') => connections.find((c) => c.client === client)?.models;

    test('they are read right after a sign-in, and a status check of a sign-in that has its list reads nothing again', async () => {
      const { runtime, connections, reported, calls } = await owned();
      reported.models = list;
      await record(runtime, 'claude_account', facts('ada@example.org'));
      assert.deepEqual(calls.filter((call) => call.startsWith('models')), ['models runtime-1 claude_code']);
      assert.deepEqual(modelsOf(connections), { listed: list, retired: [], state: 'listed', checkedOn: new Date().toISOString().slice(0, 10) });
      reported.status = facts('ada@example.org');
      await runtime.check('ada', 'claude_code', 'ada-session');
      assert.equal(calls.filter((call) => call.startsWith('models')).length, 1, 'the check did not read them again');
    });

    test('a reading that fails at sign-in leaves the list unread and the worker\'s next tick reads it; a list read is not read again', async () => {
      const { runtime, store, manager, connections, reported, calls } = await owned();
      reported.models = null;
      await record(runtime, 'claude_account', facts('ada@example.org'));
      assert.equal(modelsOf(connections), null, 'nothing is made up while the CLI cannot say');
      reported.models = list;
      const first = await reconcileAgentRuntime({ config: on, store, manager });
      assert.deepEqual([first.modelsRead, first.modelsFailed], [1, 0]);
      assert.deepEqual((modelsOf(connections) as { listed: unknown }).listed, list);
      const second = await reconcileAgentRuntime({ config: on, store, manager });
      assert.deepEqual([second.modelsRead, second.modelsFailed], [0, 0], 'not due again for hours');
      assert.equal(calls.filter((call) => call.startsWith('models')).length, 2);
    });

    test('about every six hours; a failed reading is tried again after five minutes and the last list stays', async () => {
      const { runtime, store, manager, connections, reported, calls } = await owned();
      reported.models = list;
      await record(runtime, 'claude_account', facts('ada@example.org'));
      const start = Date.now();
      const tick = (afterMs: number) => reconcileAgentRuntime({ config: on, store, manager, now: () => new Date(start + afterMs) });
      const reads = () => calls.filter((call) => call.startsWith('models')).length;
      assert.equal((await tick(5 * 3600_000)).modelsRead, 0, 'five hours after: not yet');
      reported.models = null;
      const late = await tick(6 * 3600_000 + 60_000);
      assert.deepEqual([late.modelsRead, late.modelsFailed], [0, 1], 'six hours after it is read again, and the CLI cannot be reached');
      assert.deepEqual(modelsOf(connections), { listed: list, retired: [], state: 'unavailable', checkedOn: new Date(start + 6 * 3600_000 + 60_000).toISOString().slice(0, 10) }, 'the last list stays');
      const before = reads();
      await tick(6 * 3600_000 + 2 * 60_000);
      assert.equal(reads(), before, 'a minute later: not tried again');
      reported.models = [entry('opus')];
      const retry = await tick(6 * 3600_000 + 7 * 60_000);
      assert.equal(retry.modelsRead, 1, 'five minutes later it is');
      assert.deepEqual((modelsOf(connections) as { listed: unknown; state: string }).listed, [entry('opus')]);
    });

    test('one plan per tick, the oldest first, and only a CLI the operator listed', async () => {
      const { store, manager, connections, bindings, reported, calls } = memoryStore2();
      reported.models = list;
      const runtime = agentRuntimeUseCases(on, store, manager);
      await reconcileAgentRuntime({ config: on, store, manager });
      for (const owner of ['ada', 'bob']) await runtime.bind(owner);
      for (const [owner, client] of [['ada', 'claude_code'], ['bob', 'claude_code'], ['bob', 'codex']] as const) {
        const binding = bindings.find((b) => b.ownerUserId === owner)!;
        connections.push({ ownerUserId: owner, client, bindingId: binding.id, state: 'signed_in', signInMethod: null, authMethod: null, plan: null, accountLabel: null, signedInAt: new Date(),
          accountChangedAt: null, previousAccountLabel: null, signedOutAt: null, signOutFailed: null, fingerprint: null, revoked: false });
      }
      for (const expected of [1, 1, 0]) assert.equal((await reconcileAgentRuntime({ config: on, store, manager })).modelsRead, expected);
      assert.deepEqual(calls.filter((call) => call.startsWith('models')).map((call) => call.split(' ')[2]), ['claude_code', 'claude_code'], 'Codex is not on, so it is not read');
    });

    test('a plan whose slot does not answer does not keep the others waiting behind it', async () => {
      const { store, manager, connections, bindings, reported, calls, state } = memoryStore2();
      reported.models = list;
      const runtime = agentRuntimeUseCases(on, store, manager);
      await reconcileAgentRuntime({ config: on, store, manager });
      for (const owner of ['ada', 'bob']) await runtime.bind(owner);
      for (const owner of ['ada', 'bob']) {
        const binding = bindings.find((b) => b.ownerUserId === owner)!;
        connections.push({ ownerUserId: owner, client: 'claude_code', bindingId: binding.id, state: 'signed_in', signInMethod: null, authMethod: null, plan: null, accountLabel: null,
          signedInAt: new Date(), accountChangedAt: null, previousAccountLabel: null, signedOutAt: null, signOutFailed: null, fingerprint: null, revoked: false });
      }
      const down = bindings.find((b) => b.ownerUserId === 'ada')!.slot;
      state.get(down)!.reachable = false;
      assert.equal((await reconcileAgentRuntime({ config: on, store, manager })).modelsRead, 1, 'the other plan is read');
      assert.deepEqual(calls.filter((call) => call.startsWith('models')).map((call) => call.split(' ')[1]), [bindings.find((b) => b.ownerUserId === 'bob')!.slot]);
    });

    test('signing out, or signing in to another account, clears the list; the next tick reads the new account\'s', async () => {
      const { runtime, store, manager, connections, reported } = await owned();
      reported.models = list;
      await record(runtime, 'claude_account', facts('ada@example.org'));
      reported.models = null;
      await record(runtime, 'claude_account', facts('bea@example.org'));
      assert.equal(modelsOf(connections), null, 'another account: its own models are not known yet');
      reported.models = [entry('haiku')];
      assert.equal((await reconcileAgentRuntime({ config: on, store, manager })).modelsRead, 1);
      assert.deepEqual((modelsOf(connections) as { listed: unknown }).listed, [entry('haiku')]);
      await runtime.signOut('ada', 'claude_code', 'ada-session');
      assert.equal(modelsOf(connections), null, 'signed out: nothing of that account stays');
    });
  });

  describe('a missing CLI is confirmed only by the durable client history (#480)', () => {
    /** The owner's runtime is removed and the worker releases it while the slot answers `not_installed` for these clients. */
    async function releaseAfter(setup: (c: Awaited<ReturnType<typeof owned>>) => Promise<void>, notInstalled: ('claude_code' | 'codex')[]) {
      const c = await owned();
      await setup(c);
      c.manager.release = ((release) => async (slot: string, id: string) => {
        const out = await release(slot, id);
        return out.ok ? { ok: true as const, value: { ...out.value, notInstalled } } : out;
      })(c.manager.release.bind(c.manager));
      await c.runtime.remove('ada');
      const report = await reconcileAgentRuntime({ config: on, store: c.store, manager: c.manager });
      return { ...c, report, lastRelease: (await c.runtime.status('ada')).lastRelease };
    }

    test('no login was ever started: the slot\'s not_installed stands and the release is confirmed (positive control)', async () => {
      const { report, lastRelease } = await releaseAfter(async () => undefined, ['claude_code', 'codex']);
      assert.equal(report.released.length, 1);
      assert.deepEqual(report.logoutFailed, []);
      assert.equal(lastRelease?.signOutFailed, false);
    });

    test('a console was claimed but never completed: the history keeps it unconfirmed although the slot finds nothing', async () => {
      const { report, lastRelease, store, bindings } = await releaseAfter(async ({ runtime }) => { await consoleOperation(runtime); }, ['claude_code']);
      assert.deepEqual(report.logoutFailed, [bindings[0]!.id]);
      assert.equal(lastRelease?.signOutFailed, true);
      assert.deepEqual(await store.loginPossible(bindings[0]!.id), ['claude_code'], 'the history survives the release it could not confirm');
    });

    test('a recorded sign-in with no later confirmed sign-out stays unconfirmed; a failed sign-out does not clear it', async () => {
      const signedIn = await releaseAfter(async ({ runtime }) => { await record(runtime, 'claude_account', facts('ada@example.org')); }, ['claude_code']);
      assert.equal(signedIn.lastRelease?.signOutFailed, true);
      const failed = await releaseAfter(async ({ runtime, reported }) => {
        await record(runtime, 'claude_account', facts('ada@example.org'));
        reported.logout = 'failed';
        await runtime.signOut('ada', 'claude_code', 'ada-session');
      }, ['claude_code']);
      assert.equal(failed.lastRelease?.signOutFailed, true);
      // not_installed is not a confirmation either: the owner-facing sign-out records it as failed, so the history stays.
      const gone = await releaseAfter(async ({ runtime, reported }) => {
        await record(runtime, 'claude_account', facts('ada@example.org'));
        reported.logout = 'not_installed';
        await runtime.signOut('ada', 'claude_code', 'ada-session');
      }, ['claude_code']);
      assert.equal(gone.lastRelease?.signOutFailed, true);
    });

    test('after the CLI\'s own logout returned ok the history is clear and a missing CLI is confirmed (negative control for the rows above)', async () => {
      const { lastRelease, report } = await releaseAfter(async ({ runtime }) => {
        await record(runtime, 'claude_account', facts('ada@example.org'));
        await runtime.signOut('ada', 'claude_code', 'ada-session');
      }, ['claude_code']);
      assert.deepEqual(report.logoutFailed, []);
      assert.equal(lastRelease?.signOutFailed, false);
    });

    test('only the client with history is held back: Codex never started is confirmed, Claude Code with a login is not', async () => {
      const { lastRelease } = await releaseAfter(async ({ runtime }) => { await record(runtime, 'claude_account', facts('ada@example.org')); }, ['codex']);
      assert.equal(lastRelease?.signOutFailed, false, 'the history is about claude_code, the slot only found codex missing');
      const both = await releaseAfter(async ({ runtime }) => { await record(runtime, 'claude_account', facts('ada@example.org')); }, ['claude_code', 'codex']);
      assert.equal(both.lastRelease?.signOutFailed, true);
    });

    test('a failed or skipped sign-out reported by the slot is unconfirmed whatever the history says', async () => {
      const c = await owned();
      c.manager.release = async () => ({ ok: true, value: { deleted: true, logoutFailed: true, notInstalled: [] } });
      await c.runtime.remove('ada');
      const report = await reconcileAgentRuntime({ config: on, store: c.store, manager: c.manager });
      assert.equal(report.logoutFailed.length, 1);
    });
  });

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
    // Codex (T6 #281): the slot names its methods so a payer is never mistaken for Claude's.
    assert.equal(runtimePayer('chatgpt'), 'chatgpt_plan');
    assert.equal(runtimePayer('openai_api_key'), 'openai_api');
    assert.equal(runtimePayer('access_token'), 'unknown');
    for (const method of ['unknown', 'oauth_token', 'third_party', 'api_key_helper', null]) assert.equal(runtimePayer(method), 'unknown');
  });
});
