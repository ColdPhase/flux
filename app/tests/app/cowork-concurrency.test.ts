import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { TaskCoordination } from '@flux/contracts';
import { pool } from './support/db.js';
import { waitUntilBlockedBy, settled } from './support/locks.js';
import { toolValue } from './support/mcp.js';
import { expectStatus } from './support/people.js';
import { coworkScene, failed, failureCode, type CoworkConn, type Reply } from './support/cowork-scene.js';

// #153 AC-5: real concurrency over the real OAuth bearer, with two owners (Hubert, Marek) and three connections (Codex and
// Hubert Claude for Hubert, Marek Claude for Marek). Parallel claims, transfers, declines, requests and cancellations
// against one unit or request: exactly one wins, the others are refused without a trace, and the generation fence holds.
// A revoked grant or connection is refused even when the command was already in flight. Docker regression evidence only:
// it is not a trace of a real Codex or Claude Code client, and PR targets (#74) are not covered.

/** Resolves once at least `count` database sessions wait on a lock. No timing assumption: it polls the lock table. */
async function waitForWaiters(count: number, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const waiting = (await pool.query('SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND cardinality(pg_blocking_pids(pid)) > 0')).rows[0].n as number;
    if (waiting >= count) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Fewer than ${count} sessions waited on a lock`);
}

/**
 * Two commands in a forced order. A held row lock stops the first at the row, the second queues behind it (on the same
 * connection slot, or on the same row), and releasing the lock lets them run one after the other in exactly that order.
 */
async function ordered<A, B>(lock: { table: 'cowork_units' | 'cowork_requests' | 'cowork_connection_slots'; key: string; id: string },
  first: () => Promise<A>, second: () => Promise<B>): Promise<[A, B]> {
  const holder = await pool.connect();
  try {
    await holder.query('BEGIN');
    await holder.query(`SELECT 1 FROM ${lock.table} WHERE ${lock.key} = $1 FOR UPDATE`, [lock.id]);
    const pid = Number((await holder.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
    const a = first();
    a.catch(() => undefined);
    await waitUntilBlockedBy(pool, pid);
    const b = second();
    b.catch(() => undefined);
    await waitForWaiters(2);
    await holder.query('COMMIT');
    return await Promise.all([a, b]);
  } catch (error) {
    await holder.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally { holder.release(); }
}

const codes = (replies: Reply[]) => replies.map((reply) => failureCode(reply));
const wins = (replies: Reply[]) => replies.filter((reply) => !failed(reply));
const errors = (replies: Reply[]) => replies.filter((reply) => failed(reply));

async function threeConnections() {
  const f = await coworkScene();
  const codex = await f.connect(f.hubert, 'Codex'), hubertClaude = await f.connect(f.hubert, 'Hubert Claude'), marekClaude = await f.connect(f.marek, 'Marek Claude');
  return { f, codex, hubertClaude, marekClaude };
}
const takeCall = (c: CoworkConn, grantId: string, taskId: string, version: number, key = 'take') => c.call('flux_create_unit',
  { ...c.base(grantId, 'execute'), taskId, unitKey: key, expectedTaskVersion: version, assignmentConnectionId: c.connectionId, parent: null });

test('three connections take one task at the same time: exactly one wins, the others are refused with nothing debited or created', async () => {
  const { f, codex, hubertClaude, marekClaude } = await threeConnections();
  const all = [codex, hubertClaude, marekClaude];
  for (let round = 0; round < 3; round += 1) {
    const t = await f.task(`Contested task ${round}`);
    const grants = await Promise.all(all.map((c) => c.standing('cowork.unit.create', t.id, 'execute')));
    const replies = await Promise.all(all.map((c, index) => takeCall(c, grants[index]!.id, t.id, t.version)));
    assert.equal(wins(replies).length, 1, `round ${round}: exactly one connection takes the task`);
    assert.deepEqual(codes(errors(replies)), ['COWORK_UNIT_TAKEN', 'COWORK_UNIT_TAKEN']);
    const open = (await pool.query("SELECT assignment_connection_id AS assignee FROM cowork_units WHERE work_id = $1 AND role = 'execute' AND state NOT IN ('completed','stopped')", [t.id])).rows;
    assert.equal(open.length, 1);
    const winner = all.findIndex((_, index) => !failed(replies[index]!));
    assert.equal(open[0].assignee, all[winner]!.connectionId);
    for (const [index, grant] of grants.entries()) assert.equal(await f.used(grant.id), index === winner ? 1 : 0, 'only the winner spent a use');
  }
});

test('two sessions of one connection claim a unit at once: one lease; after it lapses the other session takes it and the first is fenced out', async () => {
  const { f, codex, marekClaude } = await threeConnections();
  const second = await marekClaude.extraSession();
  const t = await f.task('Native outcome A');
  const held = await f.take(codex, t);
  const unitId = await f.openUnit(codex, held, t, 'execute', marekClaude, 'help');
  const grant = await marekClaude.standing('cowork.claim', unitId, 'execute');
  const claim = (session: typeof second) => marekClaude.call('flux_claim_unit', { ...session.base(grant.id, 'execute'), unitId, expectedVersion: 1 });
  const replies = await Promise.all([claim(marekClaude), claim(second)]);
  assert.equal(wins(replies).length, 1, 'exactly one session holds the lease');
  const loserCode = failureCode(errors(replies)[0]!);
  assert.ok(['COWORK_VERSION_CONFLICT', 'COWORK_CONNECTION_BUSY', 'COWORK_CLAIM_LOST'].includes(loserCode!), `the other is refused (${loserCode})`);
  const winnerSession = !failed(replies[0]!) ? marekClaude : second, loserSession = winnerSession === marekClaude ? second : marekClaude;
  const first = toolValue(wins(replies)[0]!) as { generation: number; version: number; lease: { id: string } };
  assert.deepEqual([first.generation, (await f.unit(unitId)).state], [1, 'claimed']);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM cowork_checkpoints WHERE unit_id = $1', [unitId])).rows[0].n, 0);

  // The lease lapses; the other session takes over with a higher generation, and the first session's fence no longer holds.
  await pool.query("UPDATE cowork_units SET lease_expires_at = clock_timestamp() - interval '1 second' WHERE id = $1", [unitId]);
  const takeover = await marekClaude.call('flux_claim_unit', { ...loserSession.base(grant.id, 'execute'), unitId, expectedVersion: (await f.unit(unitId)).version });
  const next = toolValue(takeover) as { generation: number; version: number; lease: { id: string } };
  assert.equal(next.generation, 2);
  const renew = await marekClaude.standing('cowork.renew', unitId, 'execute');
  const stale = await marekClaude.call('flux_renew_unit', { ...winnerSession.base(renew.id, 'execute'), unitId, expectedVersion: first.version,
    generation: first.generation, leaseId: first.lease.id });
  assert.ok(['COWORK_CLAIM_LOST', 'COWORK_VERSION_CONFLICT'].includes(failureCode(stale)!), 'the old generation cannot renew');
  const complete = await marekClaude.standing('cowork.unit.complete', unitId, 'execute');
  const staleComplete = await marekClaude.call('flux_complete_unit', { ...winnerSession.base(complete.id, 'execute'), unitId, expectedVersion: first.version,
    generation: first.generation, leaseId: first.lease.id, outcome: { type: 'material', id: f.material.materialId, version: 1 } });
  assert.ok(['COWORK_CLAIM_LOST', 'COWORK_VERSION_CONFLICT'].includes(failureCode(staleComplete)!), 'the old generation cannot complete');
  assert.deepEqual([(await f.unit(unitId)).state, (await f.unit(unitId)).generation], ['claimed', 2]);
  assert.equal(await f.used(complete.id), 0);
  assert.equal(await f.used(renew.id), 0);
});

test('two transfers of one unit at once: exactly one wins, the generation advances once and the holder\'s claim is fenced', async () => {
  const { f, codex, hubertClaude, marekClaude } = await threeConnections();
  const t = await f.task('Handed over');
  const held = await f.take(codex, t);
  const toMarek = await codex.standing('cowork.unit.transfer', held.unitId, 'execute');
  const toHubert = await codex.standing('cowork.unit.transfer', held.unitId, 'execute');
  const fence = { unitId: held.unitId, expectedVersion: held.claim.version, generation: held.claim.generation, leaseId: held.claim.lease.id };
  const before = await f.unit(held.unitId);
  const replies = await Promise.all([
    codex.call('flux_transfer_unit', { ...codex.base(toMarek.id, 'execute'), ...fence, assignmentConnectionId: marekClaude.connectionId }),
    codex.call('flux_transfer_unit', { ...codex.base(toHubert.id, 'execute'), ...fence, assignmentConnectionId: hubertClaude.connectionId })]);
  assert.equal(wins(replies).length, 1, 'one transfer wins');
  assert.ok(['COWORK_VERSION_CONFLICT', 'COWORK_CLAIM_LOST'].includes(failureCode(errors(replies)[0]!)!), 'the other meets the fence');
  const winner = !failed(replies[0]!) ? marekClaude : hubertClaude;
  const after = await f.unit(held.unitId);
  assert.deepEqual([after.assignee, after.state, after.generation, after.version, after.from], [winner.connectionId, 'pending', before.generation + 1, before.version + 1, codex.connectionId]);
  assert.deepEqual([await f.used(toMarek.id), await f.used(toHubert.id)], !failed(replies[0]!) ? [1, 0] : [0, 1], 'only the winner spent a use');
  // The former holder can neither renew nor transfer again: its claim, and then its assignment, are gone.
  const renew = await codex.standing('cowork.renew', held.unitId, 'execute');
  assert.ok(failed(await codex.call('flux_renew_unit', { ...codex.base(renew.id, 'execute'), ...fence })));
  assert.equal(await f.used(renew.id), 0);
  assert.ok(failed(await codex.call('flux_transfer_unit', { ...codex.base(toHubert.id, 'execute'), ...fence, assignmentConnectionId: hubertClaude.connectionId })));
  assert.deepEqual([(await f.unit(held.unitId)).assignee, (await f.unit(held.unitId)).generation], [winner.connectionId, before.generation + 1]);
});

test('a received unit is declined and claimed at the same time, in both orders: one wins and the loser changes nothing', async () => {
  const { f, codex, marekClaude } = await threeConnections();
  const setup = async (title: string) => {
    const t = await f.task(title);
    const held = await f.take(codex, t);
    const transfer = await codex.standing('cowork.unit.transfer', held.unitId, 'execute');
    toolValue(await codex.call('flux_transfer_unit', { ...codex.base(transfer.id, 'execute'), unitId: held.unitId, expectedVersion: held.claim.version,
      generation: held.claim.generation, leaseId: held.claim.lease.id, assignmentConnectionId: marekClaude.connectionId }));
    const pending = await f.unit(held.unitId);
    const second = await marekClaude.extraSession();
    const claimGrant = await marekClaude.standing('cowork.claim', held.unitId, 'execute');
    const declineGrant = await marekClaude.standing('cowork.unit.decline', held.unitId, 'execute');
    return { held, pending, claimGrant, declineGrant, claim: () => marekClaude.call('flux_claim_unit', { ...second.base(claimGrant.id, 'execute'), unitId: held.unitId, expectedVersion: pending.version }),
      decline: () => marekClaude.call('flux_decline_unit', { ...marekClaude.base(declineGrant.id, 'execute'), unitId: held.unitId, expectedVersion: pending.version }) };
  };

  // Decline first: the unit goes back, paused, to its prior assignee; the claim finds it no longer assigned.
  const a = await setup('Declined first');
  const [declined, claimedLate] = await ordered({ table: 'cowork_units', key: 'id', id: a.held.unitId }, a.decline, a.claim);
  assert.equal(failed(declined), false);
  assert.equal(failureCode(claimedLate), 'COWORK_UNIT_NOT_FOUND');
  const afterA = await f.unit(a.held.unitId);
  assert.deepEqual([afterA.assignee, afterA.state, afterA.generation, afterA.from], [codex.connectionId, 'paused', a.pending.generation + 1, null]);
  assert.deepEqual([await f.used(a.declineGrant.id), await f.used(a.claimGrant.id)], [1, 0]);

  // Claim first: the unit is held by the receiver; the decline is refused and the unit keeps its claim.
  const b = await setup('Claimed first');
  const [claimed, declinedLate] = await ordered({ table: 'cowork_units', key: 'id', id: b.held.unitId }, b.claim, b.decline);
  assert.equal(failed(claimed), false);
  assert.equal(failureCode(declinedLate), 'COWORK_VERSION_CONFLICT');
  const afterB = await f.unit(b.held.unitId);
  assert.deepEqual([afterB.assignee, afterB.state, afterB.from], [marekClaude.connectionId, 'claimed', null]);
  assert.deepEqual([await f.used(b.declineGrant.id), await f.used(b.claimGrant.id)], [0, 1]);
});

test('duplicate and parallel requests: one command ID is one effect, one intent is one request, and every attempt is accounted for', async () => {
  const { f, codex, marekClaude } = await threeConnections();
  const t = await f.task('Native outcome A');
  const review = await f.startReview(codex, marekClaude, t);
  const target = { type: 'work', id: t.id, version: t.version };
  const count = async () => (await pool.query('SELECT count(*)::int AS n FROM cowork_requests WHERE work_id = $1', [t.id])).rows[0].n as number;
  const usedBefore = await f.used(review.ask.id);

  // The same command five times at once (a client that retries before it hears back): one request, one debit, the same answer.
  const command = randomUUID();
  const same = await Promise.all(Array.from({ length: 5 }, () => review.send('review-1', target, { clientCommandId: command })));
  assert.equal(errors(same).length, 0);
  assert.equal(new Set(same.map((reply) => String(toolValue(reply).requestId))).size, 1);
  assert.equal(await count(), 1);
  assert.equal(await f.used(review.ask.id), usedBefore + 1, 'five attempts, one debit');

  // The same intent under five different commands: one request, and each command is counted once.
  const intents = await Promise.all(Array.from({ length: 5 }, () => review.send('review-1', target)));
  assert.equal(errors(intents).length, 0);
  assert.equal(new Set(intents.map((reply) => String(toolValue(reply).requestId))).size, 1);
  assert.equal(intents.filter((reply) => toolValue(reply).status === 'created').length, 0, 'the request already existed');
  assert.equal(await count(), 1);
  assert.equal(await f.used(review.ask.id), usedBefore + 1 + 5);
});

test('a cancel and the recipient\'s claim or answer meet on the request row, in both orders: one wins, the loser leaves nothing', async () => {
  const { f, codex, marekClaude } = await threeConnections();
  const t = await f.task('Native outcome A');
  const review = await f.startReview(codex, marekClaude, t);
  const target = { type: 'work', id: t.id, version: t.version };
  const claimGrant = await marekClaude.standing('cowork.request.claim', review.reviewUnit, 'review');
  const respond = await marekClaude.standing('cowork.request.respond', review.reviewUnit, 'review');
  const fence = (requestId: string, version: number) => ({ unitId: review.reviewUnit, generation: review.reviewClaim.generation,
    leaseId: review.reviewClaim.lease.id, requestId, expectedRequestVersion: version });
  const claim = (requestId: string) => marekClaude.call('flux_claim_request', { ...marekClaude.base(claimGrant.id, 'review'), ...fence(requestId, 1) });
  const resolve = (requestId: string, version: number) => marekClaude.call('flux_resolve_request', { ...marekClaude.base(respond.id, 'review'), ...fence(requestId, version),
    evidence: { type: 'material', id: f.material.materialId, version: 1 }, verdict: 'passed' });
  const cancel = (requestId: string, version: number) => f.marek.browser.request('POST', `/api/v1/work/${t.id}/coordination/requests/${requestId}/cancel`, { body: { expectedVersion: version } });
  const fresh = async (key: string) => String(toolValue(await review.send(key, target)).requestId);
  const verdicts = async () => (await pool.query('SELECT count(*)::int AS n FROM cowork_review_verdicts')).rows[0].n as number;

  // Claim first, then the cancel that named the version before the claim: it is told the request moved on.
  const r1 = await fresh('r1');
  const [claimed1, cancelled1] = await ordered({ table: 'cowork_requests', key: 'id', id: r1 }, () => claim(r1), () => cancel(r1, 1));
  assert.equal(toolValue(claimed1).state, 'claimed');
  assert.deepEqual([cancelled1.status, (cancelled1.json as { code: string }).code], [409, 'COWORK_VERSION_CONFLICT']);
  assert.equal((await f.request(r1)).state, 'claimed');

  // Cancel first: the claim is told the request is closed, debits nothing and the request stays cancelled.
  const usedClaims = await f.used(claimGrant.id);
  const r2 = await fresh('r2');
  const [cancelled2, claimed2] = await ordered({ table: 'cowork_requests', key: 'id', id: r2 }, () => cancel(r2, 1), () => claim(r2));
  assert.equal(cancelled2.status, 200);
  assert.equal(failureCode(claimed2), 'COWORK_REQUEST_CLOSED');
  assert.equal(await f.used(claimGrant.id), usedClaims, 'the refused claim debited nothing');
  assert.deepEqual([(await f.request(r2)).state, (await f.request(r2)).cancelledBy], ['cancelled', f.marek.id]);

  // An answer first: the verdict is recorded and the cancel is refused as closed; a cancel first: the answer records no verdict.
  const r3 = await fresh('r3');
  toolValue(await marekClaude.call('flux_claim_request', { ...marekClaude.base(claimGrant.id, 'review'), ...fence(r3, 1) }));
  const [answered, cancelledLate] = await ordered({ table: 'cowork_requests', key: 'id', id: r3 }, () => resolve(r3, 2), () => cancel(r3, 2));
  assert.equal(toolValue(answered).state, 'resolved');
  assert.deepEqual([cancelledLate.status, (cancelledLate.json as { code: string }).code], [409, 'COWORK_REQUEST_CLOSED']);
  assert.equal(await verdicts(), 1);
  const r4 = await fresh('r4');
  toolValue(await marekClaude.call('flux_claim_request', { ...marekClaude.base(claimGrant.id, 'review'), ...fence(r4, 1) }));
  const [cancelledFirst, answeredLate] = await ordered({ table: 'cowork_requests', key: 'id', id: r4 }, () => cancel(r4, 2), () => resolve(r4, 2));
  assert.equal(cancelledFirst.status, 200);
  assert.equal(failureCode(answeredLate), 'COWORK_REQUEST_CLOSED');
  assert.equal(await verdicts(), 1, 'the refused answer recorded no verdict');
  const view = expectStatus(await f.hubert.browser.request('GET', `/api/v1/work/${t.id}/coordination`), 200) as TaskCoordination;
  assert.deepEqual(view.requests.map((card) => card.state), ['cancelled', 'resolved', 'cancelled', 'claimed']);
});

test('a grant revoked while its command is in flight is refused at commit and leaves no effect; one revoked before it is simply refused', async () => {
  const { f, codex, marekClaude } = await threeConnections();
  const t = await f.task('Native outcome A');
  const review = await f.startReview(codex, marekClaude, t);
  const target = { type: 'work', id: t.id, version: t.version };
  const requests = async () => (await pool.query('SELECT count(*)::int AS n FROM cowork_requests WHERE work_id = $1', [t.id])).rows[0].n as number;
  const revoke = (grantId: string) => f.hubert.browser.request('DELETE', `/api/v1/agent-connections/${codex.connectionId}/action-grants/${grantId}`);

  // The command passes its authorization, then waits on the sender's slot; the owner revokes the grant meanwhile.
  const holder = await pool.connect();
  try {
    await holder.query('BEGIN');
    await holder.query('SELECT 1 FROM cowork_connection_slots WHERE connection_id = $1 FOR UPDATE', [codex.connectionId]);
    const pid = Number((await holder.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
    const inFlight = review.send('review-1', target);
    inFlight.catch(() => undefined);
    await waitUntilBlockedBy(pool, pid);
    const revocation = revoke(review.ask.id);
    const revocationDone = settled(revocation);
    // Either the revocation is applied now (the grant is no longer there to commit under) or it waits for the command.
    const deadline = Date.now() + 3000;
    while (!revocationDone() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
    const appliedFirst = revocationDone();
    await holder.query('COMMIT');
    const reply = await inFlight;
    assert.equal((await revocation).status, 204);
    if (appliedFirst) {
      assert.equal(failureCode(reply), 'AGENT_EXECUTION_UNAVAILABLE', 'a revoked grant cannot commit an in-flight command');
      assert.equal(await requests(), 0, 'nothing was created');
    } else {
      assert.equal(failed(reply), false, 'the command committed before the revocation took effect');
      assert.equal(await requests(), 1);
    }
  } finally {
    await holder.query('ROLLBACK').catch(() => undefined);
    holder.release();
  }
  // From now on the grant is gone: a new command, and a retry of the old one, are refused and create nothing.
  const before = await requests();
  assert.equal(failureCode(await review.send('review-2', target)), 'AGENT_EXECUTION_UNAVAILABLE');
  assert.equal(await requests(), before);
});

test('a connection revoked while its command is in flight cannot issue another; the books agree about the one in flight and its requests stay readable', async () => {
  const { f, codex, marekClaude } = await threeConnections();
  const t = await f.task('Native outcome A');
  const review = await f.startReview(codex, marekClaude, t);
  const target = { type: 'work', id: t.id, version: t.version };
  const sent = toolValue(await review.send('review-0', target));
  const succeeded = (outcome: { status: number; message: Reply }) => outcome.status === 200 && !failed(outcome.message);
  const holder = await pool.connect();
  let committed: boolean;
  try {
    await holder.query('BEGIN');
    await holder.query('SELECT 1 FROM cowork_connection_slots WHERE connection_id = $1 FOR UPDATE', [codex.connectionId]);
    const pid = Number((await holder.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
    const inFlight = codex.raw('flux_send_request', review.sendArgs('review-1', target));
    inFlight.catch(() => undefined);
    await waitUntilBlockedBy(pool, pid);
    const revocation = f.hubert.browser.request('DELETE', `/api/v1/agent-connections/${codex.connectionId}`);
    revocation.catch(() => undefined);
    const revoked = settled(revocation);
    const deadline = Date.now() + 3000;
    while (!revoked() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
    await holder.query('COMMIT');
    const outcome = await inFlight;
    assert.equal((await revocation).status, 204);
    committed = succeeded(outcome);
  } finally {
    await holder.query('ROLLBACK').catch(() => undefined);
    holder.release();
  }
  // Whichever way the race went, the books agree: a committed command left its request, a refused one left none.
  const rows = (await pool.query('SELECT intent_key FROM cowork_requests WHERE work_id = $1 ORDER BY created_at', [t.id])).rows.map((row) => row.intent_key);
  assert.deepEqual(rows, committed ? ['review-0', 'review-1'] : ['review-0']);
  // From now on the connection issues nothing.
  assert.equal(succeeded(await codex.raw('flux_send_request', review.sendArgs('review-2', target))), false);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM cowork_requests WHERE work_id = $1', [t.id])).rows[0].n, rows.length);
  assert.equal((await f.unit(review.held.unitId)).state, 'stopped', 'its unit stopped with the revocation');
  // The owners and managers still read what it asked, as history.
  const view = expectStatus(await f.hubert.browser.request('GET', `/api/v1/work/${t.id}/coordination`), 200) as TaskCoordination;
  assert.ok(view.requests.some((card) => card.id === String(sent.requestId)));
});
