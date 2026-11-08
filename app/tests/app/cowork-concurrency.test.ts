import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pool } from './support/db.js';
import { waitUntilBlockedBy } from './support/locks.js';
import { approveWaiting, waits } from './support/mcp-actions.js';
import { toolValue } from './support/mcp.js';
import { coworkScene, failed, failureCode, type CoworkConn, type Reply } from './support/cowork-scene.js';

// #153 AC-5: real concurrency over the real OAuth bearer, with two owners (Hubert, Marek) and three connections (Codex and
// Hubert Claude for Hubert, Marek Claude for Marek). Parallel claims, transfers and declines
// against one unit: exactly one wins, the others are refused without a trace, and the generation fence holds.
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
async function ordered<A, B>(lock: { table: 'cowork_units' | 'cowork_connection_slots'; key: string; id: string },
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
const takeCall = (c: CoworkConn, taskId: string, version: number, key = 'take') => c.call('flux_create_unit',
  { ...c.base('execute'), taskId, unitKey: key, expectedTaskVersion: version, assignmentConnectionId: c.connectionId, parent: null });

test('three connections take one task at the same time: exactly one wins, the others are refused with nothing debited or created', async () => {
  const { f, codex, hubertClaude, marekClaude } = await threeConnections();
  const all = [codex, hubertClaude, marekClaude];
  for (let round = 0; round < 3; round += 1) {
    const t = await f.task(`Contested task ${round}`);
    const replies = await Promise.all(all.map((c) => takeCall(c, t.id, t.version)));
    assert.equal(wins(replies).length, 1, `round ${round}: exactly one connection takes the task`);
    assert.deepEqual(codes(errors(replies)), ['COWORK_UNIT_TAKEN', 'COWORK_UNIT_TAKEN']);
    const open = (await pool.query("SELECT assignment_connection_id AS assignee FROM cowork_units WHERE work_id = $1 AND role = 'execute' AND state NOT IN ('completed','stopped')", [t.id])).rows;
    assert.equal(open.length, 1);
    const winner = all.findIndex((_, index) => !failed(replies[index]!));
    assert.equal(open[0].assignee, all[winner]!.connectionId);
  }
});

test('two sessions of one connection claim a unit at once: one lease; after it lapses the other session takes it and the first is fenced out', async () => {
  const { f, codex, marekClaude } = await threeConnections();
  const second = await marekClaude.extraSession();
  const t = await f.task('Native outcome A');
  const held = await f.take(codex, t);
  const unitId = await f.openUnit(codex, held, t, 'execute', marekClaude, 'help');
  const claim = (session: typeof second) => marekClaude.call('flux_claim_unit', { ...session.base('execute'), unitId, expectedVersion: 1 });
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
  const takeover = await marekClaude.call('flux_claim_unit', { ...loserSession.base('execute'), unitId, expectedVersion: (await f.unit(unitId)).version });
  const next = toolValue(takeover) as { generation: number; version: number; lease: { id: string } };
  assert.equal(next.generation, 2);
  const stale = await marekClaude.call('flux_renew_unit', { ...winnerSession.base('execute'), unitId, expectedVersion: first.version,
    generation: first.generation, leaseId: first.lease.id });
  assert.ok(['COWORK_CLAIM_LOST', 'COWORK_VERSION_CONFLICT'].includes(failureCode(stale)!), 'the old generation cannot renew');
  const staleComplete = await marekClaude.call('flux_complete_unit', { ...winnerSession.base('execute'), unitId, expectedVersion: first.version,
    generation: first.generation, leaseId: first.lease.id, outcome: { type: 'material', id: f.material.materialId, version: 1 } });
  assert.ok(['COWORK_CLAIM_LOST', 'COWORK_VERSION_CONFLICT'].includes(failureCode(staleComplete)!), 'the old generation cannot complete');
  assert.deepEqual([(await f.unit(unitId)).state, (await f.unit(unitId)).generation], ['claimed', 2]);
});

test('two transfers of one unit at once: exactly one wins, the generation advances once and the holder\'s claim is fenced', async () => {
  // Both go to the owner's own clients, so the transfers are made at once: a transfer to another person's client waits for the owner (C-18).
  const { f, codex, hubertClaude } = await threeConnections();
  const marekClaude = await f.connect(f.hubert, 'Hubert Second');
  const t = await f.task('Handed over');
  const held = await f.take(codex, t);
  const fence = { unitId: held.unitId, expectedVersion: held.claim.version, generation: held.claim.generation, leaseId: held.claim.lease.id };
  const before = await f.unit(held.unitId);
  const replies = await Promise.all([
    codex.call('flux_transfer_unit', { ...codex.base('execute'), ...fence, assignmentConnectionId: marekClaude.connectionId }),
    codex.call('flux_transfer_unit', { ...codex.base('execute'), ...fence, assignmentConnectionId: hubertClaude.connectionId })]);
  assert.equal(wins(replies).length, 1, 'one transfer wins');
  assert.ok(['COWORK_VERSION_CONFLICT', 'COWORK_CLAIM_LOST', 'COWORK_UNIT_NOT_FOUND'].includes(failureCode(errors(replies)[0]!)!), `the other meets the fence (${failureCode(errors(replies)[0]!)})`);
  const winner = !failed(replies[0]!) ? marekClaude : hubertClaude;
  const after = await f.unit(held.unitId);
  assert.deepEqual([after.assignee, after.state, after.generation, after.version, after.from], [winner.connectionId, 'pending', before.generation + 1, before.version + 1, codex.connectionId]);
  // The former holder can neither renew nor transfer again: its claim, and then its assignment, are gone.
  assert.ok(failed(await codex.call('flux_renew_unit', { ...codex.base('execute'), ...fence })));
  assert.ok(failed(await codex.call('flux_transfer_unit', { ...codex.base('execute'), ...fence, assignmentConnectionId: hubertClaude.connectionId })));
  assert.deepEqual([(await f.unit(held.unitId)).assignee, (await f.unit(held.unitId)).generation], [winner.connectionId, before.generation + 1]);
});

test('a received unit is declined and claimed at the same time, in both orders: one wins and the loser changes nothing', async () => {
  const { f, codex, marekClaude } = await threeConnections();
  const setup = async (title: string) => {
    const t = await f.task(title);
    const held = await f.take(codex, t);
    // Marek's client is another person's: the transfer waits for Codex's owner, whose Approve hands the unit over.
    assert.ok(waits(await codex.call('flux_transfer_unit', { ...codex.base('execute'), unitId: held.unitId, expectedVersion: held.claim.version,
      generation: held.claim.generation, leaseId: held.claim.lease.id, assignmentConnectionId: marekClaude.connectionId })));
    await approveWaiting(pool, f.hubert.browser, codex.connectionId, 'cowork.unit.transfer');
    const pending = await f.unit(held.unitId);
    const second = await marekClaude.extraSession();
    return { held, pending, claim: () => marekClaude.call('flux_claim_unit', { ...second.base('execute'), unitId: held.unitId, expectedVersion: pending.version }),
      decline: () => marekClaude.call('flux_decline_unit', { ...marekClaude.base('execute'), unitId: held.unitId, expectedVersion: pending.version }) };
  };

  // Decline first: the unit goes back, paused, to its prior assignee; the claim finds it no longer assigned.
  const a = await setup('Declined first');
  const [declined, claimedLate] = await ordered({ table: 'cowork_units', key: 'id', id: a.held.unitId }, a.decline, a.claim);
  assert.equal(failed(declined), false);
  assert.equal(failureCode(claimedLate), 'COWORK_UNIT_NOT_FOUND');
  const afterA = await f.unit(a.held.unitId);
  assert.deepEqual([afterA.assignee, afterA.state, afterA.generation, afterA.from], [codex.connectionId, 'paused', a.pending.generation + 1, null]);

  // Claim first: the unit is held by the receiver; the decline is refused and the unit keeps its claim.
  const b = await setup('Claimed first');
  const [claimed, declinedLate] = await ordered({ table: 'cowork_units', key: 'id', id: b.held.unitId }, b.claim, b.decline);
  assert.equal(failed(claimed), false);
  assert.equal(failureCode(declinedLate), 'COWORK_VERSION_CONFLICT');
  const afterB = await f.unit(b.held.unitId);
  assert.deepEqual([afterB.assignee, afterB.state, afterB.from], [marekClaude.connectionId, 'claimed', null]);
});

test('a connection revoked around an in-flight command: the books agree and its unit stops', async () => {
  const { f, codex, marekClaude } = await threeConnections();
  const t = await f.task('Native outcome A');
  const review = await f.startReview(codex, marekClaude, t);
  const slot = { table: 'cowork_connection_slots', key: 'connection_id', id: codex.connectionId } as const;
  const succeeded = (outcome: { status: number; message: Reply }) => outcome.status === 200 && !failed(outcome.message);
  const held = await f.unit(review.held.unitId);
  const renew = () => codex.raw('flux_renew_unit', { ...codex.base('execute'), unitId: review.held.unitId, expectedVersion: held.version,
    generation: review.held.claim.generation, leaseId: review.held.claim.lease.id });

  // The revocation is queued ahead of the command: the command, authorized a moment earlier, cannot commit.
  const [revoked, refused] = await ordered(slot, () => f.hubert.browser.request('DELETE', `/api/v1/agent-connections/${codex.connectionId}`), renew);
  assert.equal(revoked.status, 204);
  assert.equal(succeeded(refused), false);
  assert.equal(succeeded(await renew()), false, 'a revoked connection renews nothing');
  assert.equal((await f.unit(review.held.unitId)).state, 'stopped', 'its unit stopped with the revocation');
});
