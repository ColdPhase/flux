import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { before, describe, test } from 'node:test';
import type { NeedsYouItem, NeedsYouResponse, Project, TaskCreationNotice, Workspace, WorkItem } from '@flux/contracts';
import { pool } from './support/db.js';
import { addMember, expectStatus, grant, person, project as createProject, workspace, type Person } from './support/people.js';
import { waitFor } from './support/push.js';

// Blocked tasks can name who they wait for (#550): one optional person who is a member of the project. They get a
// Needs-you item and a push; the owner (or an agent owner's person) keeps the plain item; the project conversation
// gets one short line per block or unblock; an Undo never posts the same blocker twice.

const send = (someone: Person, method: string, path: string, body?: unknown) => someone.browser.request(method, path, { body });
const queue = async (someone: Person) => expectStatus(await someone.browser.request('GET', '/api/v1/needs-you'), 200) as NeedsYouResponse;
const find = (response: NeedsYouResponse, key: string): NeedsYouItem | undefined => response.items.find((item) => item.key === key);
const human = (someone: Person) => ({ kind: 'human' as const, id: someone.id });

describe('a blocked task waits for a person', () => {
  let ada: Person; let kai: Person; let viewer: Person; let outsider: Person; let ws: Workspace; let place: Project;
  const create = async (body: Record<string, unknown>) => expectStatus(await send(ada, 'POST', `/api/v1/projects/${place.id}/work`, body), 201) as WorkItem;
  const patch = async (task: Pick<WorkItem, 'id' | 'version'>, body: Record<string, unknown>, status = 200) =>
    expectStatus(await ada.browser.request('PATCH', `/api/v1/work/${task.id}`, { body: { clientCommandId: randomUUID(), ...body }, headers: { 'If-Match': `"${task.version}"` } }), status) as WorkItem;
  const lines = async () => (expectStatus(await send(ada, 'GET', `/api/v1/projects/${place.id}/task-notices?limit=100`), 200) as { items: TaskCreationNotice[] }).items;
  const blockerMessages = async (task: WorkItem) => Number((await pool.query(
    "SELECT count(*)::int AS n FROM project_messages WHERE contribution_kind = 'blocker' AND body = $1 AND project_id = $2", [task.blocker ?? 'x', place.id])).rows[0].n);

  before(async () => {
    [ada, kai, viewer, outsider] = await Promise.all(['wf-ada', 'wf-kai', 'wf-viewer', 'wf-outsider'].map(person));
    ws = await workspace(ada, 'Waiting space');
    for (const someone of [kai, viewer, outsider]) await addMember(ada, ws.id, someone, 'member');
    place = await createProject(ada, ws.id, 'Waiting project', 'restricted');
    await grant(ada, place.id, kai, 'contributor');
    await grant(ada, place.id, viewer, 'viewer');
  });

  test('naming who it waits for is validated, optional and cleared when the task leaves Blocked', async () => {
    const task = await create({ title: 'Order the boards', owner: human(ada) });
    // Only blocked work waits for someone.
    expectStatus(await send(ada, 'POST', `/api/v1/projects/${place.id}/work`, { title: 'Nope', waitingFor: human(kai) }), 400);
    expectStatus(await ada.browser.request('PATCH', `/api/v1/work/${task.id}`, { body: { waitingFor: human(kai), clientCommandId: randomUUID() }, headers: { 'If-Match': `"${task.version}"` } }), 400);
    const blocked = await patch(task, { status: 'blocked', blocker: 'Need a price', waitingFor: human(kai) });
    assert.equal(blocked.waitingFor?.id, kai.id);
    assert.equal(blocked.waitingFor?.name, 'wf-kai');
    // A person with access only: an outsider and an agent are refused.
    await patch(blocked, { waitingFor: human(outsider) }, 422);
    await patch(blocked, { waitingFor: { kind: 'agent', id: randomUUID() } }, 400);
    // The reason can change without the person; clearing the person leaves the reason.
    const same = await patch(blocked, { blocker: 'Need a firm price' });
    assert.equal(same.waitingFor?.id, kai.id);
    const none = await patch(same, { waitingFor: null });
    assert.equal(none.waitingFor, null);
    assert.equal(none.blocker, 'Need a firm price');
    const again = await patch(none, { waitingFor: human(kai) });
    const open = await patch(again, { status: 'in_progress' });
    assert.equal(open.waitingFor, null, 'it clears when the task leaves Blocked');
    assert.equal(open.blocker, null);
    // A viewer cannot change it.
    expectStatus(await viewer.browser.request('PATCH', `/api/v1/work/${open.id}`, { body: { status: 'blocked', waitingFor: human(kai), clientCommandId: randomUUID() }, headers: { 'If-Match': `"${open.version}"` } }), 403);
  });

  test('the person waited on gets "Ada is waiting for you"; the owner keeps the plain item', async () => {
    const task = await create({ title: 'Choose the lens', owner: human(ada), status: 'blocked', blocker: 'Which focal length?', waitingFor: human(kai) });
    const key = `blocked:${task.id}`;
    const theirs = find(await queue(kai), key);
    assert.ok(theirs, 'the person waited on has an item');
    assert.equal(theirs.kind, 'blocked');
    assert.equal(theirs.title, `wf-ada is waiting for you: #${task.number} Choose the lens · Which focal length?`);
    assert.equal(theirs.blocked?.waitedBy, 'wf-ada');
    assert.equal(theirs.url, `/projects/${place.id}/tasks?open=work:${task.id}`);
    const mine = find(await queue(ada), key);
    assert.ok(mine);
    assert.equal(mine.title, `#${task.number} is blocked: Which focal length?`);
    assert.equal(mine.blocked?.waitedBy, undefined);
    assert.equal(find(await queue(viewer), key), undefined, 'nobody else is asked');
    // Done / Not now work as for any item.
    expectStatus(await send(kai, 'POST', `/api/v1/needs-you/${encodeURIComponent(key)}`, { action: 'done' }), 200);
    assert.equal(find(await queue(kai), key), undefined);
    // Unblocked: gone for both.
    await patch(task, { status: 'in_progress' });
    assert.equal(find(await queue(ada), key), undefined);
  });

  test('the person waited on is told once, with a notification that opens the task', async () => {
    const task = await create({ title: 'Pick a power supply', owner: human(ada) });
    const blocked = await patch(task, { status: 'blocked', blocker: 'Which voltage?', waitingFor: human(kai) });
    const note = await waitFor(async () => {
      const inbox = expectStatus(await kai.browser.request('GET', '/api/v1/inbox'), 200) as { items: { title: string; reason: string; url: string; body: string }[] };
      return inbox.items.find((item) => item.title.includes(`#${task.number}`) && item.title.includes('is waiting for you'));
    }, 'the notification for the person waited on');
    assert.equal(note.reason, 'assigned', 'it follows the default push level of work assigned to you');
    assert.equal(note.title, `wf-ada is waiting for you: #${task.number} Pick a power supply`);
    assert.equal(note.body, 'Which voltage?');
    assert.equal(note.url, `/projects/${place.id}/tasks?open=work:${task.id}`);
    assert.equal(find(await queue(ada), `blocked:${blocked.id}`)?.kind, 'blocked');
  });

  test('an agent-held blocked task is the agent owner\'s item', async () => {
    const agent = expectStatus(await send(kai, 'POST', `/api/v1/workspaces/${ws.id}/agents`, { name: 'Kai bot', owner: 'self' }), 201) as { id: string };
    expectStatus(await send(ada, 'POST', `/api/v1/projects/${place.id}/grants`, { principal: { kind: 'agent', id: agent.id }, role: 'contributor' }), 201);
    const task = await create({ title: 'Calibrate by agent', owner: { kind: 'agent', id: agent.id }, status: 'blocked', blocker: 'Needs the rig' });
    const key = `blocked:${task.id}`;
    assert.equal(find(await queue(kai), key)?.title, `#${task.number} is blocked: Needs the rig`, 'the agent\'s human owner');
    assert.equal(find(await queue(ada), key), undefined, 'not the person who assigned it');
    assert.equal(find(await queue(viewer), key), undefined);
  });

  test('the conversation gets one line when a task is blocked and one when unblocked, none for reason edits', async () => {
    const task = await create({ title: 'Mount the sensor', owner: human(ada) });
    const before = (await lines()).filter((line) => line.workId === task.id).length;
    const blocked = await patch(task, { status: 'blocked', blocker: 'Bracket missing', waitingFor: human(kai) });
    const edited = await patch(blocked, { blocker: 'Bracket missing, ordered' });
    const swapped = await patch(edited, { waitingFor: null });
    const open = await patch(swapped, { status: 'in_progress' });
    const mine = (await lines()).filter((line) => line.workId === task.id);
    assert.deepEqual(mine.map((line) => line.kind).sort(), ['task.blocked', 'task.created', 'task.unblocked']);
    assert.equal(mine.length - before, 2);
    const line = mine.find((entry) => entry.kind === 'task.blocked')!;
    assert.equal(line.waitingFor?.name, 'wf-kai');
    assert.equal(line.reason, 'Bracket missing');
    assert.equal(line.workNumber, task.number);
    assert.equal(line.createdBy.id, ada.id);
    assert.equal(open.status, 'in_progress');
    // Everyone who can read the project sees the same lines, and a stranger sees none.
    assert.equal((expectStatus(await send(viewer, 'GET', `/api/v1/projects/${place.id}/task-notices?limit=100`), 200) as { items: unknown[] }).items.length, (await lines()).length);
    expectStatus(await send(outsider, 'GET', `/api/v1/projects/${place.id}/task-notices`), 404);
  });

  test('Undo of an unblock puts the blocker back without saying it again', async () => {
    const task = await create({ title: 'Flash the firmware', owner: human(ada) });
    const blocked = await patch(task, { status: 'blocked', blocker: 'Programmer cable is lost', waitingFor: human(kai) });
    assert.equal(await blockerMessages(blocked), 1);
    const open = await patch(blocked, { status: 'in_progress' });
    // The client's Undo: a new command with the old blocker and person, marked as a restore.
    const back = await patch(open, { status: 'blocked', blocker: 'Programmer cable is lost', waitingFor: human(kai), restore: true });
    assert.equal(back.status, 'blocked');
    assert.equal(back.waitingFor?.id, kai.id);
    assert.equal(await blockerMessages(back), 1, 'no duplicate blocker message');
    // A genuinely new, unmarked save still says it.
    const worded = await patch(back, { blocker: 'Programmer cable is still lost' });
    assert.equal(await blockerMessages(worded), 1);
    // Kai is not told a second time by the restore.
    const told = Number((await pool.query("SELECT count(*)::int AS n FROM notifications WHERE user_id = $1 AND title LIKE $2", [kai.id, `%#${task.number} Flash the firmware`])).rows[0].n);
    assert.equal(told, 1);
  });
});
