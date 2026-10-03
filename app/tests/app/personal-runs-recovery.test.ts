import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { schema } from '@flux/db';
import { recoverPersonalRuns, type PersonalRunUnitOfWork } from '@flux/core';
import { PERSONAL_RUN_LIMITS, type Conversation, type Project, type Workspace } from '@flux/contracts';
import { personalRunWorkerUnitOfWork } from '../../apps/worker/src/personal-runs/adapters.js';
import { db, pool } from './support/db.js';
import { addMember, expectStatus, person, project, workspace, type Person } from './support/people.js';

// Real SQL/transaction/recovery checks, with synthetic persisted crash states. No provider pass.
const uow = personalRunWorkerUnitOfWork(db);
const ownIds: string[] = [];
let first: Person; let second: Person; let third: Person; let fourth: Person; let ws: Workspace; let place: Project; let conversation: Conversation;
const agents = new Map<string, string>();

async function seed(owner: Person, status: 'queued' | 'reading' | 'dispatching' | 'completed', ageSeconds = 3600) {
  const id = randomUUID();
  const now = new Date();
  await db.insert(schema.personalRuns).values({
    id, workspaceId: ws.id, projectId: place.id, conversationId: conversation.id,
    ownerUserId: owner.id, agentId: agents.get(owner.id)!, connectionId: randomUUID(),
    clientRunId: randomUUID(), requestFingerprint: randomUUID(), kind: 'ask', prompt: 'Synthetic crash fixture',
    status, reservedMicros: 60_000, model: PERSONAL_RUN_LIMITS.model,
    costState: status === 'completed' ? 'observed' : 'reserved',
    chargedMicros: status === 'completed' ? 2500 : 0,
    answerBody: status === 'completed' ? 'Existing answer' : null,
    committedAt: status === 'completed' ? now : null,
    updatedAt: new Date(now.getTime() - ageSeconds * 1000),
  });
  ownIds.push(id);
  return id;
}
async function row(id: string) {
  return (await pool.query('SELECT status, cost_state, charged_micros, reserved_micros, answer_body FROM personal_runs WHERE id=$1', [id])).rows[0];
}
describe('personal-run crash recovery (real SQL, no provider)', () => {
  // Inside the suite, so the cleanup runs before support/db.ts closes the shared pool.
  after(async () => {
    if (ownIds.length) await pool.query('DELETE FROM personal_runs WHERE id=ANY($1::uuid[])', [ownIds]);
  });
  before(async () => {
    [first, second, third, fourth] = await Promise.all(['recovery-first', 'recovery-second', 'recovery-third', 'recovery-fourth'].map(person));
    ws = await workspace(first, 'Recovery fixture');
    for (const member of [second, third, fourth]) await addMember(first, ws.id, member, 'member');
    place = await project(first, ws.id, 'Recovery', 'workspace');
    conversation = expectStatus(await first.browser.request('POST', `/api/v1/projects/${place.id}/conversations`, {
      body: { body: 'Recovery source', clientMessageId: randomUUID() },
    }), 201) as Conversation;
    for (const owner of [first, second, third, fourth]) {
      const agent = expectStatus(await owner.browser.request('POST', `/api/v1/workspaces/${ws.id}/agents`, {
        body: { name: 'Recovery assistant', owner: 'self' },
      }), 201) as { id: string };
      agents.set(owner.id, agent.id);
    }
  });

  test('one global batch, replicas, accounting, recent/terminal preservation and owner-only progress', async () => {
    const queued = await seed(first, 'queued', 172_803);
    const reading = await seed(second, 'reading', 172_802);
    const dispatched = await seed(third, 'dispatching', 172_801);
    const recent = await seed(fourth, 'reading', 600);
    const completed = await seed(first, 'completed', 172_804);
    const prior = await row(completed);
    assert.equal(await recoverPersonalRuns(uow, 1), 1, 'limit is global across states');
    assert.equal((await row(queued)).status, 'unavailable');
    assert.equal((await row(reading)).status, 'reading');
    await Promise.all([recoverPersonalRuns(uow, 1), recoverPersonalRuns(uow, 1)]);
    assert.deepEqual(await row(queued), { status: 'unavailable', cost_state: 'released', charged_micros: 0, reserved_micros: 60_000, answer_body: null });
    assert.deepEqual(await row(reading), { status: 'unavailable', cost_state: 'released', charged_micros: 0, reserved_micros: 60_000, answer_body: null });
    assert.deepEqual(await row(dispatched), { status: 'provider_failed', cost_state: 'unknown', charged_micros: 0, reserved_micros: 60_000, answer_body: null });
    assert.equal((await row(recent)).status, 'reading');
    assert.deepEqual(await row(completed), prior);
    const events = await pool.query(`SELECT e.object_id, e.data->>'status' AS status, array_agg(a.recipient) AS recipients
      FROM events e JOIN event_audience a ON a.event_id=e.id WHERE e.kind='assistant_run.changed.v1'
      AND e.object_id=ANY($1::uuid[]) GROUP BY e.id`, [[queued, reading, dispatched]]);
    assert.equal(events.rows.length, 3, 'exactly one progress event per recovered run');
    for (const event of events.rows) assert.deepEqual(event.recipients, [`human:${event.object_id === reading ? second.id : event.object_id === dispatched ? third.id : first.id}`]);
    await recoverPersonalRuns(uow);
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM events WHERE kind='assistant_run.changed.v1' AND object_id=ANY($1::uuid[])", [[queued, reading, dispatched]])).rows[0].n, 3, 'repeated sweep is inert');
  });

  test('a locked old row does not hold up recovery of another owner', async () => {
    const locked = await seed(first, 'queued', 259_201);
    const available = await seed(second, 'reading', 259_200);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT id FROM personal_runs WHERE id=$1 FOR UPDATE', [locked]);
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        assert.equal(await Promise.race([
          recoverPersonalRuns(uow, 1),
          new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Recovery waited for a locked row')), 3000); }),
        ]), 1);
      } finally { clearTimeout(timer); }
      assert.equal((await row(available)).status, 'unavailable');
      assert.equal((await row(locked)).status, 'queued');
    } finally { await client.query('ROLLBACK'); client.release(); }
    await recoverPersonalRuns(uow);
    assert.equal((await row(locked)).status, 'unavailable');
  });

  test('failed progress recording rolls the state/accounting back', async () => {
    const id = await seed(second, 'dispatching');
    const before = await row(id);
    const failing: PersonalRunUnitOfWork = {
      run: (work) => uow.run((ports) => work({ ...ports, events: { record: async () => { throw new Error('Synthetic event failure'); } } })),
    };
    await assert.rejects(recoverPersonalRuns(failing), /Synthetic event failure/);
    assert.deepEqual(await row(id), before);
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM events WHERE object_id=$1 AND kind='assistant_run.changed.v1'", [id])).rows[0].n, 0);
    await recoverPersonalRuns(uow);
  });

  test('the running worker recovers a crash without another owner invocation', { timeout: 80_000 }, async () => {
    const id = await seed(first, 'dispatching');
    const deadline = Date.now() + 75_000;
    while ((await row(id)).status === 'dispatching') {
      assert.ok(Date.now() < deadline, 'the production worker never recovered the stale run');
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    assert.deepEqual(await row(id), { status: 'provider_failed', cost_state: 'unknown', charged_micros: 0, reserved_micros: 60_000, answer_body: null });
  });
});
