import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { coWorkClaimUseCases, type CoWorkClaimUnitOfWork, type CoWorkContext, type CoWorkUnit,
  type ClaimOutcome, type ClaimInput, type ClaimOperation } from '../../packages/core/src/co-work/index.js';
import { ConflictError, ForbiddenError } from '../../packages/core/src/access/errors.js';

// Pure core checks only. This transactional fixture is not evidence of SQL locking,
// real #152 grant integration, durable retention or supported-client activation.
function fixture() {
  const context: CoWorkContext = { workspaceId: randomUUID(), projectId: randomUUID(),
    connectionId: randomUUID(), agentId: randomUUID(), ownerId: 'owner', runtimeSessionId: randomUUID() };
  let unit: CoWorkUnit = { id: randomUUID(), taskId: randomUUID(), workspaceId: context.workspaceId,
    projectId: context.projectId, assignmentConnectionId: context.connectionId, role: 'review',
    state: 'pending', generation: 0, version: 1, lease: null, checkpointId: null };
  let now = new Date('2026-09-30T22:00:00Z');
  let authorized = true, readableCheckpoints = true, activeOthers = 0, maximum = 1, failReceipt = false;
  const checkpoints = new Map<string, { unitId: string; generation: number; sessionId: string }>();
  const receipts = new Map<string, { fingerprint: string; outcome: ClaimOutcome }>();
  let writes = 0;
  const uow: CoWorkClaimUnitOfWork = {
    async run<T>(ctx: CoWorkContext, operation: ClaimOperation, input: ClaimInput, effect: Parameters<CoWorkClaimUnitOfWork['run']>[3]): Promise<T> {
      if (!authorized) throw new ForbiddenError('Current grant revoked');
      const key = `${ctx.connectionId}:${ctx.projectId}:${operation}:${input.commandId}`;
      const fingerprint = JSON.stringify({ session: ctx.runtimeSessionId, input });
      const receipt = receipts.get(key);
      if (receipt && receipt.fingerprint !== fingerprint) throw new ConflictError('Changed command', 'COWORK_COMMAND_CONFLICT');
      let pendingUnit = structuredClone(unit), pendingReceipt: ClaimOutcome | null = null;
      const result = await effect({ unit: structuredClone(unit), now, activeConnectionUnits: activeOthers,
        maximumConnectionUnits: maximum, leaseSeconds: 60, replay: receipt ? structuredClone(receipt.outcome) : null,
        async requireCheckpoint(id, fence) {
          const checkpoint = checkpoints.get(id);
          if (!checkpoint) throw new ConflictError('Checkpoint not persisted');
          if (checkpoint.unitId !== fence.unitId || checkpoint.generation !== fence.generation
            || checkpoint.sessionId !== ctx.runtimeSessionId) throw new ConflictError('Checkpoint fence mismatch');
        },
        async save(next) { pendingUnit = structuredClone(next); return structuredClone(next); },
        async requireReadableCheckpoint(id, unitId) {
          if (!readableCheckpoints || checkpoints.get(id)?.unitId !== unitId) throw new ForbiddenError('Checkpoint source no longer readable');
        },
        async saveReceipt(outcome) { if (failReceipt) throw new Error('Injected failure after unit write'); pendingReceipt = structuredClone(outcome); },
      });
      if (pendingReceipt) { unit = pendingUnit; receipts.set(key, { fingerprint, outcome: pendingReceipt }); writes++; }
      return result as T;
    },
  };
  const use = coWorkClaimUseCases(uow);
  const command = () => ({ commandId: randomUUID(), unitId: unit.id, expectedVersion: unit.version });
  return { context, use, command, get unit() { return structuredClone(unit); }, get writes() { return writes; },
    advance(seconds: number) { now = new Date(now.getTime() + seconds * 1000); },
    revoke() { authorized = false; }, hideCheckpointSources() { readableCheckpoints = false; }, busy(count: number, capacity = 1) { activeOthers = count; maximum = capacity; },
    failReceipt() { failReceipt = true; }, allowReceipt() { failReceipt = false; },
    checkpoint(overrides: Partial<{ unitId: string; generation: number; sessionId: string }> = {}) {
      const id = randomUUID();
      checkpoints.set(id, { unitId: unit.id, generation: unit.generation, sessionId: context.runtimeSessionId, ...overrides });
      return id;
    },
  };
}

const conflict = (code: string) => (error: unknown) => error instanceof ConflictError && error.code === code;

test('claim, checkpoint release and cold-session reclaim advance the fence without completing work', async () => {
  const f = fixture();
  const claimed = await f.use.claim(f.context, f.command());
  assert.equal(claimed.state, 'claimed');
  assert.equal(claimed.generation, 1);
  assert.equal(claimed.lease!.runtimeSessionId, f.context.runtimeSessionId);
  const released = await f.use.release(f.context, { ...f.command(), generation: claimed.generation,
    leaseId: claimed.lease!.id, checkpointId: f.checkpoint() });
  assert.equal(released.state, 'paused');
  assert.equal(released.lease, null);
  const cold = { ...f.context, runtimeSessionId: randomUUID() };
  const reclaimed = await f.use.claim(cold, f.command());
  assert.ok(reclaimed.generation > released.generation);
  assert.notEqual(reclaimed.lease!.id, claimed.lease!.id);
  assert.equal(reclaimed.checkpointId, released.checkpointId);
  await assert.rejects(f.use.renew(f.context, { ...f.command(), generation: claimed.generation,
    leaseId: claimed.lease!.id }), conflict('COWORK_CLAIM_LOST'));
});

test('default connection capacity includes execution/review work in other sessions and projects', async () => {
  const f = fixture();
  f.busy(1);
  await assert.rejects(f.use.claim(f.context, f.command()), conflict('COWORK_CONNECTION_BUSY'));
  assert.equal(f.writes, 0);
  f.busy(1, 2); // Only the current authorization adapter can supply this grant capacity.
  assert.equal((await f.use.claim(f.context, f.command())).state, 'claimed');
});

test('renew cannot revive a lease at its exact expiry', async () => {
  const f = fixture();
  const first = await f.use.claim(f.context, f.command());
  f.advance(60);
  await assert.rejects(f.use.renew(f.context, { ...f.command(), generation: first.generation,
    leaseId: first.lease!.id }), conflict('COWORK_CLAIM_LOST'));
  assert.equal(f.writes, 1);
  const next = await f.use.claim(f.context, f.command());
  assert.equal(next.generation, first.generation + 1);
  assert.notEqual(next.lease!.id, first.lease!.id);
});

test('a second runtime session cannot renew the same connection lease', async () => {
  const f = fixture();
  const first = await f.use.claim(f.context, f.command());
  await assert.rejects(f.use.renew({ ...f.context, runtimeSessionId: randomUUID() },
    { ...f.command(), generation: first.generation, leaseId: first.lease!.id }), conflict('COWORK_CLAIM_LOST'));
  assert.equal(f.writes, 1);
});

test('retry returns the original effect without extending an expired lease; revoked replay is denied', async () => {
  const f = fixture(), command = f.command();
  const first = await f.use.claim(f.context, command);
  f.advance(61);
  assert.deepEqual(await f.use.claim(f.context, command), first);
  assert.equal(f.writes, 1);
  await assert.rejects(f.use.renew(f.context, { ...f.command(), generation: first.generation,
    leaseId: first.lease!.id }), conflict('COWORK_CLAIM_LOST'));
  f.revoke();
  await assert.rejects(f.use.claim(f.context, command), ForbiddenError);
});

test('retry from a different session conflicts instead of silently creating another claim', async () => {
  const f = fixture(), command = f.command();
  await f.use.claim(f.context, command);
  await assert.rejects(f.use.claim({ ...f.context, runtimeSessionId: randomUUID() }, command), conflict('COWORK_COMMAND_CONFLICT'));
  await assert.rejects(f.use.claim(f.context, { ...command, expectedVersion: 2 }), conflict('COWORK_COMMAND_CONFLICT'));
  assert.equal(f.writes, 1);
});

test('receipt failure rolls back the unit and a subsequent retry retains one effect', async () => {
  const f = fixture(), command = f.command();
  f.failReceipt();
  await assert.rejects(f.use.claim(f.context, command), /Injected failure/);
  assert.equal(f.unit.state, 'pending');
  assert.equal(f.unit.generation, 0);
  assert.equal(f.writes, 0);
  f.allowReceipt();
  assert.equal((await f.use.claim(f.context, command)).generation, 1);
  assert.equal(f.writes, 1);
});

test('unpersisted checkpoints and old expected versions cannot release a live claim', async () => {
  const f = fixture();
  const first = await f.use.claim(f.context, f.command());
  const input = { ...f.command(), generation: first.generation, leaseId: first.lease!.id, checkpointId: randomUUID() };
  await assert.rejects(f.use.release(f.context, input), /Checkpoint not persisted/);
  await assert.rejects(f.use.release(f.context, { ...input, expectedVersion: 1 }), conflict('COWORK_VERSION_CONFLICT'));
  assert.equal(f.unit.state, 'claimed');
  assert.equal(f.writes, 1);
});

test('wrong project or connection cannot reveal or renew a unit', async () => {
  const f = fixture();
  for (const wrong of [{ ...f.context, projectId: randomUUID() }, { ...f.context, connectionId: randomUUID() }]) {
    await assert.rejects(f.use.claim(wrong, f.command()), (error: unknown) =>
      error instanceof Error && 'code' in error && error.code === 'COWORK_UNIT_NOT_FOUND');
  }
  assert.equal(f.writes, 0);
});


test('an incorrectly scoped adapter cannot operate on a different unit in the same project', async () => {
  const f = fixture();
  const missing = randomUUID();
  const rejected = (error: unknown) => error instanceof Error && 'code' in error && error.code === 'COWORK_UNIT_NOT_FOUND';
  await assert.rejects(f.use.claim(f.context, { ...f.command(), unitId: missing }), rejected);
  const first = await f.use.claim(f.context, f.command());
  const wrongFence = { ...f.command(), unitId: missing, generation: first.generation, leaseId: first.lease!.id };
  await assert.rejects(f.use.renew(f.context, wrongFence), rejected);
  await assert.rejects(f.use.release(f.context, { ...wrongFence, checkpointId: f.checkpoint() }), rejected);
  assert.equal(f.writes, 1);
});


test('an existing checkpoint from another unit, generation or session cannot release this claim', async () => {
  const f = fixture();
  const first = await f.use.claim(f.context, f.command());
  for (const wrong of [{ unitId: randomUUID() }, { generation: 999 }, { sessionId: randomUUID() }]) {
    await assert.rejects(f.use.release(f.context, { ...f.command(), generation: first.generation,
      leaseId: first.lease!.id, checkpointId: f.checkpoint(wrong) }), /Checkpoint fence mismatch/);
  }
  assert.equal(f.unit.state, 'claimed');
  assert.equal(f.writes, 1);
});


test('UUID casing is normalized before the durable command fingerprint', async () => {
  const f = fixture(), command = f.command();
  const first = await f.use.claim(f.context, { ...command, commandId: command.commandId.toUpperCase(), unitId: command.unitId.toUpperCase() });
  assert.deepEqual(await f.use.claim(f.context, command), first);
  assert.equal(f.writes, 1);
  const renewed = await f.use.renew(f.context, { ...f.command(), generation: first.generation, leaseId: first.lease!.id.toUpperCase() });
  assert.equal(renewed.lease!.id, first.lease!.id);
});


test('intervening renewal or release makes the original produced state stale for replay', async () => {
  const f = fixture(), claim = f.command();
  const first = await f.use.claim(f.context, claim);
  const renew = { ...f.command(), generation: first.generation, leaseId: first.lease!.id };
  const renewed = await f.use.renew(f.context, renew);
  await assert.rejects(f.use.claim(f.context, claim), conflict('COWORK_RECEIPT_STALE'));
  assert.deepEqual(await f.use.renew(f.context, renew), renewed);
  await f.use.release(f.context, { ...f.command(), generation: renewed.generation,
    leaseId: renewed.lease!.id, checkpointId: f.checkpoint() });
  await assert.rejects(f.use.renew(f.context, renew), conflict('COWORK_RECEIPT_STALE'));
  assert.equal(f.writes, 3);
});

test('unchanged release replay requires current checkpoint source access and cannot survive reclaim', async () => {
  const f = fixture();
  const first = await f.use.claim(f.context, f.command());
  const release = { ...f.command(), generation: first.generation, leaseId: first.lease!.id, checkpointId: f.checkpoint() };
  const released = await f.use.release(f.context, release);
  assert.deepEqual(await f.use.release(f.context, release), released);
  f.hideCheckpointSources();
  await assert.rejects(f.use.release(f.context, release), ForbiddenError);
  assert.equal(f.writes, 2);
  await f.use.claim(f.context, f.command());
  await assert.rejects(f.use.release(f.context, release), conflict('COWORK_RECEIPT_STALE'));
  assert.equal(f.writes, 3);
});
