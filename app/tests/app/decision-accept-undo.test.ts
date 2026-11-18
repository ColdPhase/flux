import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { before, describe, test } from 'node:test';
import type { Decision, NeedsYouResponse, Project, TaskActivityPage, TaskCreationNotice, Workspace, WorkItem } from '@flux/contracts';
import { NEEDS_YOU_PATH } from '@flux/contracts';
import { pool } from './support/db.js';
import { addMember, expectStatus, grant, person, project as createProject, workspace, type Person } from './support/people.js';
import { waitFor } from './support/push.js';

// Accept works at once, with a 10 s Undo (founder decision, Hubert, 2026-11-15, round 8, #1424; docs/development/work-decisions.md
// "Accept at once, and Undo takes it back"). Undo is the accepter's `POST /decisions/:id/unaccept`: the decision is proposed again, a
// decision it replaced is the current one again, and the tasks it let continue wait for it again, as they were, without their "can
// continue" line and notification. Only the accepter, only while nothing rests on the acceptance, and only shortly after it.

const send = (someone: Person, method: string, path: string, body?: unknown, headers?: Record<string, string>) => someone.browser.request(method, path, { body, headers });
const human = (someone: Person) => ({ kind: 'human' as const, id: someone.id });
const codeOf = (response: { json: unknown }) => (response.json as { code?: string }).code;

describe('the Undo of an acceptance', () => {
  let ada: Person; let kai: Person; let mia: Person; let ws: Workspace; let place: Project;

  const create = async (body: Record<string, unknown>, who = ada) => expectStatus(await send(who, 'POST', `/api/v1/projects/${place.id}/work`, body), 201) as WorkItem;
  const read = async (task: Pick<WorkItem, 'id'>) => expectStatus(await send(ada, 'GET', `/api/v1/work/${task.id}`), 200) as WorkItem;
  const patch = async (task: Pick<WorkItem, 'id' | 'version'>, body: Record<string, unknown>, who = ada) =>
    expectStatus(await send(who, 'PATCH', `/api/v1/work/${task.id}`, { clientCommandId: randomUUID(), ...body }, { 'If-Match': `"${task.version}"` }), 200) as WorkItem;
  const propose = async (title: string, extra: Record<string, unknown> = {}) => expectStatus(await send(ada, 'POST', `/api/v1/projects/${place.id}/decisions`, { title, ...extra }), 201) as Decision;
  const decision = async (id: string) => expectStatus(await send(ada, 'GET', `/api/v1/decisions/${id}`), 200) as Decision;
  const accept = async (item: Decision, who = kai) => expectStatus(await send(who, 'POST', `/api/v1/decisions/${item.id}/accept`, {}, { 'If-Match': `"${item.version}"`, 'Idempotency-Key': randomUUID() }), 200) as Decision;
  const unacceptRaw = (item: Pick<Decision, 'id' | 'version'>, who = kai) => send(who, 'POST', `/api/v1/decisions/${item.id}/unaccept`, {}, { 'If-Match': `"${item.version}"` });
  const unaccept = async (item: Decision, who = kai) => expectStatus(await unacceptRaw(item, who), 200) as Decision;
  const refused = async (item: Pick<Decision, 'id' | 'version'>, status: number, code: string, who = kai) => {
    const response = await unacceptRaw(item, who);
    assert.equal(response.status, status, response.text);
    assert.equal(codeOf(response), code);
  };
  const lines = async (task: Pick<WorkItem, 'id'>, kind: TaskCreationNotice['kind']) =>
    (expectStatus(await send(ada, 'GET', `/api/v1/projects/${place.id}/task-notices?limit=100`), 200) as { items: TaskCreationNotice[] }).items.filter((line) => line.workId === task.id && line.kind === kind);
  const activity = async (task: Pick<WorkItem, 'id'>) => (expectStatus(await send(ada, 'GET', `/api/v1/work/${task.id}/activity?limit=50`), 200) as TaskActivityPage).items;
  const canContinue = async (task: WorkItem) => Number((await pool.query('SELECT count(*)::int AS n FROM notifications WHERE user_id = $1 AND title LIKE $2', [ada.id, `#${task.number} can continue%`])).rows[0].n);
  const needsYou = async (who: Person) => (expectStatus(await send(who, 'GET', NEEDS_YOU_PATH), 200) as NeedsYouResponse).items.map((item) => item.key);

  before(async () => {
    [ada, kai, mia] = await Promise.all(['au-ada', 'au-kai', 'au-mia'].map(person));
    ws = await workspace(ada, 'Accept undo space');
    for (const someone of [kai, mia]) await addMember(ada, ws.id, someone, 'member');
    place = await createProject(ada, ws.id, 'Accept undo project', 'restricted');
    await grant(ada, place.id, kai, 'contributor');
    await grant(ada, place.id, mia, 'contributor');
  });

  test('Undo makes the decision proposed again, brings back the one it replaced and puts the waiting tasks back as they were', async () => {
    const earlier = await accept(await propose('Water the beds by hand'));
    const proposal = await propose('Water the beds with drip lines', { supersedes: earlier.id });
    const waiting = await create({ title: 'Lay the drip lines', owner: human(ada), status: 'blocked', blocker: 'Which hose?', waitingOn: { kind: 'decision', id: proposal.id } });
    assert.ok((await needsYou(mia)).includes(`decision:${proposal.id}`), 'Mia can accept it too');
    const blockedLines = (await lines(waiting, 'task.blocked')).length;
    const statusesBefore = (await activity(waiting)).filter((entry) => entry.kind === 'status').length;

    const accepted = await accept(proposal);
    assert.equal(accepted.status, 'accepted');
    assert.equal((await decision(earlier.id)).status, 'superseded');
    assert.deepEqual([(await read(waiting)).status, (await read(waiting)).waitingOn], ['in_progress', null]);
    assert.equal((await lines(waiting, 'task.resumed')).length, 1);
    await waitFor(async () => (await canContinue(waiting)) === 1 || undefined, 'Ada hears the task can continue');
    assert.ok(!(await needsYou(mia)).includes(`decision:${proposal.id}`), 'accepted: it left every Inbox at once');

    const undone = await unaccept(accepted);
    assert.deepEqual([undone.status, undone.decidedBy, undone.decidedAt], ['proposed', null, null]);
    const back = await decision(earlier.id);
    assert.deepEqual([back.status, back.supersededBy], ['accepted', null], 'the decision it replaced is the current one again');
    const task = await read(waiting);
    assert.deepEqual([task.status, task.blocker, task.waitingOn?.kind, task.waitingOn?.id], ['blocked', 'Which hose?', 'decision', proposal.id], 'the task waits for it again, as it was');
    assert.equal((await lines(waiting, 'task.resumed')).length, 0, 'its "can continue" line is gone');
    assert.equal((await lines(waiting, 'task.blocked')).length, blockedLines, 'the task is not blocked a second time in the conversation');
    const statuses = (await activity(waiting)).filter((entry) => entry.kind === 'status');
    assert.equal(statuses.length, statusesBefore, 'the history keeps no "continued" and "blocked again" for an acceptance that came to nothing');
    assert.equal(await canContinue(waiting), 0, 'the "can continue" notification is gone');
    assert.ok((await needsYou(mia)).includes(`decision:${proposal.id}`), 'it is back in the Inbox of those who can accept it');

    // It can be accepted again, and that acceptance resumes the task again.
    const again = await accept(undone, mia);
    assert.equal(again.decidedBy?.id, mia.id);
    assert.equal((await read(waiting)).status, 'in_progress');
    assert.equal((await decision(earlier.id)).status, 'superseded');
  });

  test('only the accepter, only while it is accepted and unchanged, and only while nothing rests on it', async () => {
    const accepted = await accept(await propose('Paint the shed green'));
    await refused(accepted, 403, 'DECISION_NOT_YOURS', mia);
    await refused(accepted, 403, 'DECISION_NOT_YOURS', ada);
    await refused({ id: accepted.id, version: accepted.version - 1 }, 409, 'VERSION_CONFLICT');

    // A newer proposal names it as the decision it replaces.
    await propose('Paint the shed blue', { supersedes: accepted.id });
    await refused(accepted, 409, 'DECISION_IN_USE');
    assert.equal((await decision(accepted.id)).status, 'accepted', 'it stays accepted');

    // A task it let continue was changed since.
    const proposal = await propose('Buy a rain barrel');
    const waiting = await create({ title: 'Place the barrel', owner: human(ada), status: 'blocked', waitingOn: { kind: 'decision', id: proposal.id } });
    const taken = await accept(proposal);
    await patch(await read(waiting), { title: 'Place the barrel by the shed' });
    await refused(taken, 409, 'DECISION_IN_USE');
    assert.equal((await read(waiting)).status, 'in_progress', 'the task stays as it is');

    // Undone once, a second Undo finds nothing to take back.
    const once = await accept(await propose('Compost in the corner'));
    const undone = await unaccept(once);
    await refused(undone, 409, 'DECISION_NOT_ACCEPTED');
  });

  test('an Undo long after the acceptance is refused: a change of direction is a new proposal', async () => {
    const accepted = await accept(await propose('Fence the beds'));
    await pool.query("UPDATE project_decisions SET decided_at = now() - interval '11 minutes' WHERE id = $1", [accepted.id]);
    await refused(accepted, 409, 'DECISION_UNDO_ENDED');
    assert.equal((await decision(accepted.id)).status, 'accepted');
  });
});
