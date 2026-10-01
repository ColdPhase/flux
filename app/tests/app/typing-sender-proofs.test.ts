import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { TypingAccessPorts, TypingPulse } from '@flux/core';
import { TypingSenderProofs } from '../../apps/server/src/typing/sender-proofs.js';

function gate() { let release!: () => void; const wait = new Promise<void>((resolve) => { release = resolve; }); return { wait, release }; }
const context = { kind: 'conversation' as const, id: randomUUID() };
const pulse = (): TypingPulse => ({ connectionId: randomUUID(), actorId: randomUUID(), sessionId: randomUUID(), context: { ...context }, sequence: 1, active: true, expiresAt: Date.now() + 5000 });
const direct = <T>(operation: () => Promise<T>) => operation();
function access(held?: ReturnType<typeof gate>) {
  return { currentHuman: async (actor) => { await held?.wait; return { id: actor.actorId, name: 'Current native person' }; }, canonicalContext: async (_actor, target) => ({ ...target }) } satisfies TypingAccessPorts;
}
test('captured authority is immutable and a later cycle rechecks the exact session/name', async () => {
  const held = gate(); const item = pulse(); let currentChecks = 0; let writeChecks = 0;
  const ports: TypingAccessPorts = { currentHuman: async (actor) => { currentChecks++; await held.wait; return { id: actor.actorId, name: 'Live name' }; },
    canonicalContext: async (_actor, target, action) => { writeChecks++; assert.equal(action, 'write'); return target; } };
  const proofs = new TypingSenderProofs(ports, direct);
  try {
    const originalId = item.actorId; const proof = proofs.request(context, [item], () => true);
    item.actorId = 'forged after capture'; item.context.id = randomUUID(); held.release();
    const first = (await proof)!; assert.equal(first.people[0]!.human.id, originalId);
    assert.ok(Object.isFrozen(first) && Object.isFrozen(first.people) && Object.isFrozen(first.people[0]!.pulse.context));
    assert.equal(currentChecks, 2); assert.equal(writeChecks, 1);
    await proofs.request(context, [pulse()], () => true);
    assert.equal(currentChecks, 4); assert.equal(writeChecks, 2, 'there is no cross-cycle authority cache');
  } finally { held.release(); proofs.close(); }
});
test('superseded pending cycles retire; cancelled unfinished SQL retains its actual slot', async () => {
  const held = gate(); const proofs = new TypingSenderProofs(access(held), direct);
  try {
    const running = proofs.request(context, [pulse()], () => true);
    const old = proofs.request(context, [pulse()], () => true);
    const latest = proofs.request(context, [pulse()], () => true);
    assert.equal(await old, null); assert.equal(proofs.work.running, 1); assert.equal(proofs.work.pending, 1); assert.equal(proofs.work.captured, 2);
    proofs.invalidate(); assert.equal(await latest, null);
    assert.equal(proofs.work.running, 1); assert.equal(proofs.work.captured, 1, 'generation change does not hide held native SQL');
    held.release(); assert.equal(await running, null);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(proofs.work.running, 0); assert.equal(proofs.work.captured, 0);
  } finally { held.release(); proofs.close(); }
});
test('global concurrency and capture capacity fail closed without launching hidden work', async () => {
  const held = gate(); const proofs = new TypingSenderProofs(access(held), direct); const jobs: Promise<unknown>[] = [];
  try {
    for (let index = 0; index < 4; index++) { const target = { ...context, id: randomUUID() }; const items = Array.from({ length: 512 }, () => ({ ...pulse(), context: target })); jobs.push(proofs.request(target, items, () => true)); }
    for (let index = 0; index < 4; index++) { const target = { ...context, id: randomUUID() }; const items = Array.from({ length: 512 }, () => ({ ...pulse(), context: target })); jobs.push(proofs.request(target, items, () => true)); }
    assert.equal(proofs.work.running, 4); assert.equal(proofs.work.pending, 4); assert.equal(proofs.work.captured, 4096);
    await assert.rejects(proofs.request({ ...context, id: randomUUID() }, [pulse()], () => true), /capacity unavailable/);
    assert.equal(proofs.work.peaks.captured, 4096);
    proofs.close(); assert.equal(proofs.work.running, 4); assert.equal(proofs.work.captured, 2048);
    held.release(); await Promise.all(jobs); await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(proofs.work.contexts, 0); assert.equal(proofs.work.captured, 0);
  } finally { held.release(); proofs.close(); }
});
test('a revoked exact session is omitted; authority error rejects the entire proof', async () => {
  const item = pulse(); let currentChecks = 0;
  const ports: TypingAccessPorts = { currentHuman: async (actor) => ++currentChecks === 1 ? { id: actor.actorId, name: 'Before revoke' } : null, canonicalContext: async (_actor, target) => target };
  const proofs = new TypingSenderProofs(ports, direct);
  try { assert.deepEqual((await proofs.request(context, [item], () => true))!.people, []); }
  finally { proofs.close(); }
  const rejected = new Error('native SQL unavailable'); const unavailable = new TypingSenderProofs({ ...ports, currentHuman: async () => { throw rejected; } }, direct);
  try { await assert.rejects(unavailable.request(context, [item], () => true), (error) => error === rejected); }
  finally { unavailable.close(); }
});
test('the earliest sender deadline survives a later slow check and queued reuse', async () => {
  const held = gate(); const entered = gate(); let checks = 0;
  const ports: TypingAccessPorts = { currentHuman: async (actor) => { if (++checks === 3) { entered.release(); await held.wait; } return { id: actor.actorId, name: 'Native person' }; }, canonicalContext: async (_actor, target) => target };
  const proofs = new TypingSenderProofs(ports, direct);
  try {
    const pending = proofs.request(context, [pulse(), pulse()], () => true); await entered.wait;
    await new Promise<void>((resolve) => setTimeout(resolve, 1050)); held.release();
    const proof = (await pending)!;
    assert.equal(proof.people.length, 2); assert.ok(proof.expiresAt < performance.now(), 'the last check cannot renew the first sender proof');
  } finally { held.release(); proofs.close(); }
});
