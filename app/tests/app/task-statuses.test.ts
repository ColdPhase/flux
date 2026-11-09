import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { before, describe, test } from 'node:test';
import type { Decision, NeedsYouResponse, Project, ProjectWorkView, TaskActivityPage, TaskCreationNotice, TaskDiscussion, Workspace, WorkItem, WorkResult } from '@flux/contracts';
import { DomainError } from '@flux/core';
import { workUseCases } from '../../apps/server/src/work/adapters.js';
import { db, pool } from './support/db.js';
import { addMember, expectStatus, grant, person, project as createProject, workspace, type Person } from './support/people.js';
import { waitFor } from './support/push.js';

// A task has four states (#868). "Not pursued" is Done with a "dropped" note and Done takes one optional line, "what came of it", that is
// also written in the task's discussion. A blocked task waits for one thing: a person (#550), a decision or another task, and goes back to
// Doing by itself when that is resolved (the decision accepted, the task done, or the person saying they are done); its owner hears of it once.

const send = (someone: Person, method: string, path: string, body?: unknown, headers?: Record<string, string>) => someone.browser.request(method, path, { body, headers });
const human = (someone: Person) => ({ kind: 'human' as const, id: someone.id });
const codeOf = (response: { json: unknown }) => (response.json as { code?: string }).code;

describe('four task states, dropped, what came of it, and what a blocked task waits for', () => {
  let ada: Person; let kai: Person; let mia: Person; let outsider: Person; let ws: Workspace; let place: Project; let elsewhere: Project;

  const create = async (body: Record<string, unknown>, who = ada, where = place) =>
    expectStatus(await send(who, 'POST', `/api/v1/projects/${where.id}/work`, body), 201) as WorkItem;
  const read = async (task: Pick<WorkItem, 'id'>, who = ada) => expectStatus(await send(who, 'GET', `/api/v1/work/${task.id}`), 200) as WorkItem;
  const patchRaw = (task: Pick<WorkItem, 'id' | 'version'>, body: Record<string, unknown>, who = ada) =>
    send(who, 'PATCH', `/api/v1/work/${task.id}`, { clientCommandId: randomUUID(), ...body }, { 'If-Match': `"${task.version}"` });
  const patch = async (task: Pick<WorkItem, 'id' | 'version'>, body: Record<string, unknown>, who = ada, status = 200) => expectStatus(await patchRaw(task, body, who), status) as WorkItem;
  const refused = async (task: Pick<WorkItem, 'id' | 'version'>, body: Record<string, unknown>, status: number, code?: string, who = ada) => {
    const response = await patchRaw(task, body, who);
    assert.equal(response.status, status, response.text);
    if (code) assert.equal(codeOf(response), code);
  };
  const propose = async (title: string, where = place) => expectStatus(await send(ada, 'POST', `/api/v1/projects/${where.id}/decisions`, { title }), 201) as Decision;
  const accept = async (decision: Decision, who = kai) => expectStatus(await send(who, 'POST', `/api/v1/decisions/${decision.id}/accept`, {}, { 'If-Match': `"${decision.version}"` }), 200) as Decision;
  const lines = async (where = place) => (expectStatus(await send(ada, 'GET', `/api/v1/projects/${where.id}/task-notices?limit=100`), 200) as { items: TaskCreationNotice[] }).items;
  const lineOf = async (task: Pick<WorkItem, 'id'>, kind: TaskCreationNotice['kind']) => (await lines()).filter((line) => line.workId === task.id && line.kind === kind);
  const activity = async (task: Pick<WorkItem, 'id'>) => (expectStatus(await send(ada, 'GET', `/api/v1/work/${task.id}/activity?limit=50`), 200) as TaskActivityPage).items;
  const discussion = async (task: Pick<WorkItem, 'id'>) => expectStatus(await send(ada, 'GET', `/api/v1/work/${task.id}/discussion`), 200) as TaskDiscussion;
  const cameOfItMessages = async (task: Pick<WorkItem, 'id'>) => (await discussion(task)).messages.filter((message) => message.contribution?.kind === 'came_of_it');
  const inbox = async (who: Person) => (expectStatus(await send(who, 'GET', '/api/v1/inbox'), 200) as { items: { title: string; reason: string; url: string }[] }).items;
  const heardOf = (who: Person, task: WorkItem, because: string) => waitFor(async () => (await inbox(who)).find((item) => item.title === `#${task.number} can continue: ${because}`), `${who.id} hears #${task.number} can continue`);
  const notHeard = async (who: Person, task: WorkItem) => (await inbox(who)).filter((item) => item.title.startsWith(`#${task.number} can continue`));

  before(async () => {
    [ada, kai, mia, outsider] = await Promise.all(['st-ada', 'st-kai', 'st-mia', 'st-outsider'].map(person));
    ws = await workspace(ada, 'Statuses space');
    for (const someone of [kai, mia, outsider]) await addMember(ada, ws.id, someone, 'member');
    place = await createProject(ada, ws.id, 'Statuses project', 'restricted');
    elsewhere = await createProject(ada, ws.id, 'Another project', 'restricted');
    await grant(ada, place.id, kai, 'contributor');
    await grant(ada, place.id, mia, 'contributor');
  });

  describe('Done, dropped and what came of it', () => {
    test('a task is Done with one line that is also written in its discussion, once', async () => {
      const task = await create({ title: 'Mount gateway 2', owner: human(ada) });
      const finished = await patch(task, { status: 'done', cameOfIt: 'The shed roof\nwas too  low, so it sits on the pole.' });
      assert.deepEqual([finished.status, finished.dropped, finished.cameOfIt], ['done', false, 'The shed roof was too  low, so it sits on the pole.']);
      assert.equal((await read(task)).cameOfIt, finished.cameOfIt);
      const said = await cameOfItMessages(task);
      assert.equal(said.length, 1);
      assert.equal(said[0]!.body, finished.cameOfIt);
      assert.equal(said[0]!.authorId, ada.id);
      // Saving a line is one message, as saving a blocker is; a change of the line is a new message.
      const same = await patch(finished, { cameOfIt: 'It sits on the pole now.' });
      assert.equal((await cameOfItMessages(task)).length, 2);
      const cleared = await patch(same, { cameOfIt: null });
      assert.equal(cleared.cameOfIt, null);
      assert.equal((await cameOfItMessages(task)).length, 2, 'clearing the line writes nothing');
      assert.equal((await patch(cleared, { cameOfIt: '   ' })).cameOfIt, null, 'an empty line is none');
    });

    test('an exact retry of the same command does not write the line twice', async () => {
      const task = await create({ title: 'Buy cable glands', owner: human(ada) });
      const body = { clientCommandId: randomUUID(), status: 'done', cameOfIt: 'Bought six, the shop had them.' };
      const first = expectStatus(await send(ada, 'PATCH', `/api/v1/work/${task.id}`, body, { 'If-Match': `"${task.version}"` }), 200) as WorkItem;
      const again = expectStatus(await send(ada, 'PATCH', `/api/v1/work/${task.id}`, body, { 'If-Match': `"${task.version}"` }), 200) as WorkItem;
      assert.equal(again.version, first.version);
      assert.equal((await cameOfItMessages(task)).length, 1);
    });

    test('a dropped task is Done · dropped; reading, activity and the finished count say so', async () => {
      const task = await create({ title: 'Radar module', owner: human(ada) });
      const dropped = await patch(task, { status: 'done', dropped: true });
      assert.deepEqual([dropped.status, dropped.dropped, dropped.cameOfIt], ['done', true, null]);
      assert.equal((await cameOfItMessages(task)).length, 0, 'no line, no message');
      const entry = (await activity(task)).find((item) => item.kind === 'status' && item.status?.to === 'done')!;
      assert.equal(entry.status?.dropped, true);
      const rows = expectStatus(await send(ada, 'GET', `/api/v1/projects/${place.id}/work-view?purpose=tasks&group=finished&kinds=work&limit=100`), 200) as ProjectWorkView;
      const row = rows.items.find((item) => item.id === task.id);
      assert.ok(row && row.kind === 'work');
      assert.deepEqual([row.status, row.dropped], ['done', true], 'the row says Done · dropped');
      // A dropped task counts as finished: the summary has no fifth state.
      const summary = expectStatus(await send(ada, 'GET', `/api/v1/projects/${place.id}/work-summary`), 200) as { all: { finished: number } };
      assert.ok(summary.all.finished >= 1);
    });

    test('the line is one line of at most 500 characters; dropped and the line are for Done only', async () => {
      const task = await create({ title: 'Check the float', owner: human(ada) });
      await refused(task, { status: 'done', cameOfIt: 'x'.repeat(501) }, 400);
      await refused(task, { status: 'done', cameOfIt: 'x'.repeat(2001) }, 400);
      assert.equal((await patch(task, { status: 'done', cameOfIt: 'x'.repeat(500) })).cameOfIt?.length, 500);
      const open = await create({ title: 'Not finished', owner: human(ada) });
      await refused(open, { dropped: true }, 400);
      await refused(open, { cameOfIt: 'too early' }, 400);
      await refused(open, { status: 'in_progress', dropped: true }, 400);
      await refused(open, { status: 'in_progress', cameOfIt: 'too early' }, 400);
      assert.equal((await read(open)).version, open.version, 'nothing was stored');
    });

    test('leaving Done clears both, and the discussion keeps what was said', async () => {
      const task = await create({ title: 'Wire the pump', owner: human(ada) });
      const done = await patch(task, { status: 'done', dropped: true, cameOfIt: 'Not needed after all.' });
      assert.deepEqual([done.dropped, done.cameOfIt], [true, 'Not needed after all.']);
      const back = await patch(done, { status: 'in_progress' });
      assert.deepEqual([back.status, back.dropped, back.cameOfIt], ['in_progress', false, null]);
      assert.equal((await cameOfItMessages(task)).length, 1, 'the message stays');
      // An Undo of that move puts the note back without writing it again.
      const undone = await patch(back, { status: 'done', dropped: true, cameOfIt: 'Not needed after all.', restore: true });
      assert.deepEqual([undone.status, undone.dropped, undone.cameOfIt], ['done', true, 'Not needed after all.']);
      assert.equal((await cameOfItMessages(task)).length, 1, 'restore writes nothing');
    });

    test('there is no fifth state: not_pursued is refused', async () => {
      const task = await create({ title: 'Old word', owner: human(ada) });
      await refused(task, { status: 'not_pursued' }, 400);
      assert.equal((await send(ada, 'POST', `/api/v1/projects/${place.id}/work`, { title: 'Old word', status: 'not_pursued' })).status, 400);
    });
  });

  describe('what a blocked task waits for', () => {
    test('a decision or a task, as one name, cleared when it leaves Blocked', async () => {
      const decision = await propose('Use LoRa for the far beds');
      const other = await create({ title: 'Order six probes', owner: human(ada) });
      const task = await create({ title: 'Install the far gateway', owner: human(ada) });
      const onDecision = await patch(task, { status: 'blocked', waitingOn: { kind: 'decision', id: decision.id } });
      assert.deepEqual(onDecision.waitingOn, { kind: 'decision', id: decision.id, title: 'Use LoRa for the far beds' });
      assert.equal(onDecision.waitingFor, null);
      const onTask = await patch(onDecision, { waitingOn: { kind: 'task', id: other.id } });
      assert.deepEqual(onTask.waitingOn, { kind: 'task', id: other.id, number: other.number, title: 'Order six probes' });
      assert.equal(onTask.status, 'blocked');
      // It waits for one thing: naming a person clears the task, naming a task clears the person.
      const onPerson = await patch(onTask, { waitingFor: human(kai) });
      assert.deepEqual([onPerson.waitingFor?.id, onPerson.waitingOn], [kai.id, null]);
      const backOnTask = await patch(onPerson, { waitingOn: { kind: 'task', id: other.id } });
      assert.deepEqual([backOnTask.waitingFor, backOnTask.waitingOn?.kind], [null, 'task']);
      // Clearing what it waits for leaves it blocked, with its reason.
      const cleared = await patch(backOnTask, { waitingOn: null, blocker: 'Ask Jonas' });
      assert.deepEqual([cleared.status, cleared.waitingOn, cleared.blocker], ['blocked', null, 'Ask Jonas']);
      const again = await patch(cleared, { waitingOn: { kind: 'decision', id: decision.id } });
      const open = await patch(again, { status: 'in_progress' });
      assert.deepEqual([open.waitingOn, open.waitingFor, open.blocker], [null, null, null], 'it clears when the task leaves Blocked');
      // A read, a list and the row all carry it while it waits.
      const waiting = await patch(open, { status: 'blocked', waitingOn: { kind: 'task', id: other.id } });
      assert.equal((await read(waiting, kai)).waitingOn?.kind, 'task');
      const listed = (expectStatus(await send(ada, 'GET', `/api/v1/projects/${place.id}/work?limit=100`), 200) as { items: WorkItem[] }).items.find((item) => item.id === task.id)!;
      assert.equal(listed.waitingOn?.id, other.id);
      // The Board's row names it too: a decision by its title, a task by its number.
      const rows = expectStatus(await send(ada, 'GET', `/api/v1/projects/${place.id}/work-view?purpose=tasks&group=blocked&kinds=work&limit=100`), 200) as ProjectWorkView;
      const row = rows.items.find((item) => item.id === task.id);
      assert.ok(row && row.kind === 'work');
      assert.deepEqual(row.waitingOn, { kind: 'task', id: other.id, number: other.number, title: 'Order six probes' });
      const decided = await patch(waiting, { waitingOn: { kind: 'decision', id: decision.id } });
      const rowsAgain = expectStatus(await send(ada, 'GET', `/api/v1/projects/${place.id}/work-view?purpose=tasks&group=blocked&kinds=work&limit=100`), 200) as ProjectWorkView;
      const again2 = rowsAgain.items.find((item) => item.id === decided.id);
      assert.ok(again2 && again2.kind === 'work');
      assert.deepEqual(again2.waitingOn, { kind: 'decision', id: decision.id, title: 'Use LoRa for the far beds' });
    });

    test('a task created Blocked can name what it waits for; naming two things or the wrong thing is refused', async () => {
      const decision = await propose('Order from the cheaper shop');
      const made = await create({ title: 'Place the order', status: 'blocked', waitingOn: { kind: 'decision', id: decision.id }, owner: human(ada) });
      assert.equal(made.waitingOn?.title, 'Order from the cheaper shop');
      assert.equal((await send(ada, 'POST', `/api/v1/projects/${place.id}/work`, { title: 'Two things', status: 'blocked', waitingFor: human(kai), waitingOn: { kind: 'decision', id: decision.id } })).status, 400);
      assert.equal((await send(ada, 'POST', `/api/v1/projects/${place.id}/work`, { title: 'Not blocked', waitingOn: { kind: 'decision', id: decision.id } })).status, 400);
      const open = await create({ title: 'Plain task' });
      await refused(open, { status: 'blocked', waitingFor: human(kai), waitingOn: { kind: 'decision', id: decision.id } }, 400);
      await refused(open, { waitingOn: { kind: 'decision', id: decision.id } }, 400);
      await refused(open, { status: 'blocked', waitingOn: { kind: 'idea', id: decision.id } }, 400);
      await refused(open, { status: 'blocked', waitingOn: { kind: 'task', id: 'nope' } }, 400);
    });

    test('not for itself, not for what is already decided or done, not for another space, not round in a circle', async () => {
      const task = await create({ title: 'Self waiter', owner: human(ada) });
      await refused(task, { status: 'blocked', waitingOn: { kind: 'task', id: task.id } }, 422, 'WAITING_ON_ITSELF');
      const decided = await accept(await propose('Already decided'), ada);
      await refused(task, { status: 'blocked', waitingOn: { kind: 'decision', id: decided.id } }, 422, 'WAITING_ON_RESOLVED');
      const finished = await create({ title: 'Already done', status: 'done' });
      await refused(task, { status: 'blocked', waitingOn: { kind: 'task', id: finished.id } }, 422, 'WAITING_ON_RESOLVED');
      const foreignTask = await create({ title: 'In another project' }, ada, elsewhere);
      const foreignDecision = await propose('Another project decision', elsewhere);
      await refused(task, { status: 'blocked', waitingOn: { kind: 'task', id: foreignTask.id } }, 422, 'WAITING_ON_NOT_FOUND');
      await refused(task, { status: 'blocked', waitingOn: { kind: 'decision', id: foreignDecision.id } }, 422, 'WAITING_ON_NOT_FOUND');
      await refused(task, { status: 'blocked', waitingOn: { kind: 'task', id: randomUUID() } }, 422, 'WAITING_ON_NOT_FOUND');
      assert.equal((await read(task)).version, task.version, 'a refusal stores nothing');
      const a = await create({ title: 'Circle A', owner: human(ada) });
      const b = await create({ title: 'Circle B', owner: human(ada) });
      const c = await create({ title: 'Circle C', owner: human(ada) });
      const aWaits = await patch(a, { status: 'blocked', waitingOn: { kind: 'task', id: b.id } });
      const bWaits = await patch(b, { status: 'blocked', waitingOn: { kind: 'task', id: c.id } });
      await refused(c, { status: 'blocked', waitingOn: { kind: 'task', id: a.id } }, 422, 'WAITING_ON_CYCLE');
      await refused(bWaits, { waitingOn: { kind: 'task', id: a.id } }, 422, 'WAITING_ON_CYCLE');
      assert.equal(aWaits.waitingOn?.id, b.id);
      assert.equal(bWaits.waitingOn?.id, c.id);
    });

    test('the stream and the activity say what it waits for, as the card does', async () => {
      const decision = await propose('Use LoRa for the far beds');
      const other = await create({ title: 'Order six probes', owner: human(ada) });
      const first = await create({ title: 'Waits for a decision', owner: human(ada) });
      const second = await create({ title: 'Waits for a task', owner: human(ada) });
      const third = await create({ title: 'Waits with a reason', owner: human(ada) });
      const d = await patch(first, { status: 'blocked', blocker: 'Not sure yet', waitingOn: { kind: 'decision', id: decision.id } });
      const t = await patch(second, { status: 'blocked', waitingOn: { kind: 'task', id: other.id } });
      const r = await patch(third, { status: 'blocked', blocker: 'Needs a bracket' });
      assert.equal((await lineOf(d, 'task.blocked'))[0]!.reason, 'waiting for the decision Use LoRa for the far beds');
      assert.equal((await lineOf(t, 'task.blocked'))[0]!.reason, `waiting for #${other.number}`);
      assert.equal((await lineOf(r, 'task.blocked'))[0]!.reason, 'Needs a bracket');
      const blockedEntry = async (task: WorkItem) => (await activity(task)).find((item) => item.kind === 'status' && item.status?.to === 'blocked')!.status!;
      assert.equal((await blockedEntry(d)).waitingOn, 'the decision Use LoRa for the far beds');
      assert.equal((await blockedEntry(t)).waitingOn, `#${other.number}`);
      assert.equal((await blockedEntry(r)).waitingOn ?? null, null);
    });

    test('Undo of an unblock puts the wait back without saying the reason again', async () => {
      const other = await create({ title: 'Wait for this', owner: human(ada) });
      const task = await create({ title: 'Restorable', owner: human(ada) });
      const blocked = await patch(task, { status: 'blocked', blocker: 'Parts are late', waitingOn: { kind: 'task', id: other.id } });
      const reasons = async () => Number((await pool.query("SELECT count(*)::int AS n FROM project_messages WHERE contribution_kind = 'blocker' AND project_id = $1 AND conversation_id IN (SELECT conversation_id FROM project_task_discussions WHERE work_id = $2)", [place.id, task.id])).rows[0].n);
      assert.equal(await reasons(), 1);
      const open = await patch(blocked, { status: 'in_progress' });
      const back = await patch(open, { status: 'blocked', blocker: 'Parts are late', waitingOn: { kind: 'task', id: other.id }, restore: true });
      assert.deepEqual([back.status, back.waitingOn?.id, back.blocker], ['blocked', other.id, 'Parts are late']);
      assert.equal(await reasons(), 1, 'no duplicate reason');
    });
  });

  describe('it goes back to Doing by itself', () => {
    test('the decision is accepted: every task that waited for it continues, its owner hears of it once', async () => {
      const decision = await propose('Use LoRa for the far beds');
      const aTask = await create({ title: 'Install far gateway', owner: human(ada) });
      const kTask = await create({ title: 'Test far gateway', owner: human(kai) });
      const stays = await create({ title: 'Waits for another decision', owner: human(ada) });
      const other = await propose('Some other decision');
      const moved = await create({ title: 'Moved away before', owner: human(ada) });
      const reworded = await create({ title: 'Pointed elsewhere', owner: human(ada) });
      const a = await patch(aTask, { status: 'blocked', waitingOn: { kind: 'decision', id: decision.id } });
      const k = await patch(kTask, { status: 'blocked', waitingOn: { kind: 'decision', id: decision.id } });
      const s = await patch(stays, { status: 'blocked', waitingOn: { kind: 'decision', id: other.id } });
      const m = await patch(await patch(moved, { status: 'blocked', waitingOn: { kind: 'decision', id: decision.id } }), { status: 'open' });
      const w = await patch(await patch(reworded, { status: 'blocked', waitingOn: { kind: 'decision', id: decision.id } }), { waitingOn: { kind: 'decision', id: other.id } });

      await accept(decision);

      const resumed = await read(a);
      assert.deepEqual([resumed.status, resumed.waitingOn, resumed.waitingFor, resumed.blocker], ['in_progress', null, null, null]);
      assert.equal((await read(k)).status, 'in_progress');
      assert.equal((await read(s)).status, 'blocked', 'another decision is not this one');
      assert.equal((await read(w)).waitingOn?.id, other.id);
      assert.equal((await read(m)).version, m.version, 'a task that moved away is left alone');
      assert.equal((await read(w)).version, w.version);
      const line = (await lineOf(a, 'task.resumed'))[0]!;
      assert.equal(line.reason, 'the decision was accepted');
      assert.equal(line.createdBy.id, kai.id, 'by whoever accepted it');
      assert.equal((await lineOf(a, 'task.unblocked')).length, 0, 'it is one line, not a second "unblocked"');
      assert.equal((await lineOf(m, 'task.resumed')).length, 0);
      assert.equal((await lineOf(s, 'task.resumed')).length, 0);
      const entry = (await activity(a)).find((item) => item.kind === 'status' && item.status?.to === 'in_progress')!;
      assert.deepEqual([entry.automation, entry.actor.id, entry.status?.from], ['wait_resolved', kai.id, 'blocked']);

      // The owner hears it once: "#4 can continue: the decision was accepted". Whoever accepted it is not told of their own act.
      const note = await heardOf(ada, a, 'the decision was accepted');
      assert.equal(note.reason, 'assigned');
      assert.equal(note.url, `/projects/${place.id}/tasks?open=work:${a.id}`);
      assert.equal((await notHeard(kai, k)).length, 0);
      assert.equal((await notHeard(ada, a)).length, 1);
      assert.equal((await notHeard(ada, s)).length, 0);
    });

    test('the task it waited for is Done: by a change, as dropped, or by a result that finishes it', async () => {
      const awaited = await create({ title: 'Order six probes', owner: human(ada) });
      const dropped = await create({ title: 'Buy the old probes', owner: human(ada) });
      const viaResult = await create({ title: 'Bench test', owner: human(ada) });
      const wait = async (title: string, on: WorkItem) => patch(await create({ title, owner: human(ada) }), { status: 'blocked', waitingOn: { kind: 'task', id: on.id } });
      const one = await wait('Mount the probes', awaited);
      const two = await wait('Calibrate the probes', awaited);
      const three = await wait('Use the old probes', dropped);
      const four = await wait('Read the bench result', viaResult);

      await patch(awaited, { status: 'done' }, kai);
      assert.equal((await read(one)).status, 'in_progress');
      assert.equal((await read(two)).status, 'in_progress');
      assert.equal((await lineOf(one, 'task.resumed'))[0]!.reason, `#${awaited.number} is done`);
      await heardOf(ada, one, `#${awaited.number} is done`);
      assert.deepEqual([(await read(one)).waitingOn], [null]);
      const entry = (await activity(one)).find((item) => item.automation === 'wait_resolved')!;
      assert.equal(entry.status?.to, 'in_progress');

      await patch(dropped, { status: 'done', dropped: true }, kai);
      assert.equal((await lineOf(three, 'task.resumed'))[0]!.reason, `#${dropped.number} was dropped`);
      await heardOf(ada, three, `#${dropped.number} was dropped`);

      const result = expectStatus(await send(kai, 'POST', `/api/v1/projects/${place.id}/results`,
        { title: 'It works', finding: 'positive', work: [viaResult.id], finishes: { id: viaResult.id, expectedVersion: viaResult.version } }), 201) as WorkResult;
      assert.ok(result.id);
      assert.equal((await read(viaResult)).status, 'done');
      assert.equal((await read(four)).status, 'in_progress');
      assert.equal((await lineOf(four, 'task.resumed'))[0]!.reason, `#${viaResult.number} is done`);
    });

    test('a task whose prerequisite is still open goes back to To do, since Doing needs every prerequisite done', async () => {
      const prerequisite = await create({ title: 'Prerequisite', owner: human(ada) });
      const decision = await propose('Needs a prerequisite too');
      const task = await create({ title: 'Has a prerequisite', owner: human(ada), status: 'blocked', waitingOn: { kind: 'decision', id: decision.id }, dependencyIds: [prerequisite.id] });
      await accept(decision);
      const after = await read(task);
      assert.deepEqual([after.status, after.waitingOn], ['open', null]);
      assert.equal((await lineOf(task, 'task.resumed')).length, 1);
    });

    test('a task held by an agent is taken up again: the same event as when it was given to the agent', async () => {
      const agent = expectStatus(await send(kai, 'POST', `/api/v1/workspaces/${ws.id}/agents`, { name: 'St bot', owner: 'self' }), 201) as { id: string };
      const decision = await propose('The agent waits for this');
      const task = await create({ title: 'Held by an agent', owner: { kind: 'agent', id: agent.id }, status: 'blocked', waitingOn: { kind: 'decision', id: decision.id } }, kai);
      const events = async () => Number((await pool.query("SELECT count(*)::int AS n FROM agent_task_events WHERE work_id = $1 AND kind = 'assigned'", [task.id])).rows[0].n);
      const before = await events();
      await accept(decision, mia);
      assert.equal(await events(), before + 1, 'one event to pick it up');
      assert.equal((await lineOf(task, 'task.resumed')).length, 1);
      const notes = await pool.query("SELECT count(*)::int AS n FROM notifications WHERE title LIKE $1", [`%#${task.number} can continue%`]);
      assert.equal(Number(notes.rows[0].n), 0, 'an agent owner is not sent an Inbox note');
    });

    test('a person moving an agent\'s Blocked task to Doing (Resolve) queues the agent like a resolved wait; To do, and a task that was not Blocked, do not', async () => {
      const agent = expectStatus(await send(kai, 'POST', `/api/v1/workspaces/${ws.id}/agents`, { name: 'St resolver', owner: 'self' }), 201) as { id: string };
      const held = async (title: string, status: string) => create({ title, owner: { kind: 'agent', id: agent.id }, status, ...(status === 'blocked' ? { blocker: 'Waits for the lens' } : {}) }, kai);
      const events = async (task: WorkItem) => Number((await pool.query("SELECT count(*)::int AS n FROM agent_task_events WHERE work_id = $1 AND kind = 'assigned'", [task.id])).rows[0].n);
      const blocked = await held('Blocked with its agent', 'blocked');
      const before = await events(blocked);
      await patch(blocked, { status: 'in_progress' }, kai);
      assert.equal(await events(blocked), before + 1, 'Resolve picks the agent up again');
      const toDo = await held('Back to To do', 'blocked');
      const kept = await events(toDo);
      await patch(toDo, { status: 'open' }, kai);
      assert.equal(await events(toDo), kept, 'moving it to To do does not start the agent');
      const doing = await held('Already Doing', 'in_progress');
      const same = await events(doing);
      await patch(doing, { status: 'done' }, kai);
      assert.equal(await events(doing), same, 'a task that was not Blocked is left alone');
    });

    test('the person waited for says they are done: reading the space is enough, and only they can', async () => {
      const task = await create({ title: 'Pick the voltage', owner: human(ada), status: 'blocked', blocker: 'Which voltage?', waitingFor: human(kai) });
      const asked = expectStatus(await send(kai, 'GET', '/api/v1/needs-you'), 200) as NeedsYouResponse;
      assert.equal(asked.items.find((item) => item.key === `blocked:${task.id}`)?.blocked?.waitedBy, 'st-ada', 'Kai has the item');
      const path = `/api/v1/work/${task.id}/waiting-done`;
      const at = (version: number) => ({ 'If-Match': `"${version}"` });
      assert.equal((await send(ada, 'POST', path, undefined, at(task.version))).status, 409, 'the owner is not the one waited for');
      assert.equal(codeOf(await send(mia, 'POST', path, undefined, at(task.version))), 'NOT_WAITING_FOR_YOU');
      assert.equal((await send(outsider, 'POST', path, undefined, at(task.version))).status, 404, 'no access, no task');
      assert.equal((await send(kai, 'POST', path)).status, 428, 'the version is needed');
      assert.equal((await send(kai, 'POST', path, undefined, at(task.version + 5))).status, 409, 'a stale version');
      await assert.rejects(workUseCases(db).resolveWaiting({ kind: 'agent', id: randomUUID() }, task.id, task.version),
        (error: unknown) => error instanceof DomainError && error.code === 'WAITING_DONE_NEEDS_PERSON');
      assert.equal((await read(task)).status, 'blocked', 'every refusal left it blocked');

      const done = expectStatus(await send(kai, 'POST', path, undefined, at(task.version)), 200) as WorkItem;
      assert.deepEqual([done.status, done.waitingFor, done.blocker], ['in_progress', null, null]);
      assert.equal((await lineOf(task, 'task.resumed'))[0]!.reason, 'st-kai is done');
      assert.equal((await lineOf(task, 'task.resumed'))[0]!.createdBy.id, kai.id);
      await heardOf(ada, task, 'st-kai is done');
      const entry = (await activity(task)).find((item) => item.automation === 'wait_resolved')!;
      assert.deepEqual([entry.actor.id, entry.status?.to], [kai.id, 'in_progress']);
      // The item leaves Kai's Inbox, and saying it again is a conflict: it no longer waits for them.
      const after = expectStatus(await send(kai, 'GET', '/api/v1/needs-you'), 200) as NeedsYouResponse;
      assert.equal(after.items.find((item) => item.key === `blocked:${task.id}`), undefined);
      assert.equal(codeOf(await send(kai, 'POST', path, undefined, at(done.version))), 'NOT_WAITING_FOR_YOU');
    });

    test('a task whose creation was undone while it waited holds nothing: its decision can be accepted and its task finished', async () => {
      const undo = async (task: WorkItem) => expectStatus(await send(ada, 'POST', `/api/v1/work/${task.id}/creation-undo`, { clientCommandId: randomUUID(), expectedVersion: task.version }), 200);
      const decision = await propose('Waited for by an undone task');
      const fromDecision = await create({ title: 'Undone waiter for a decision', owner: human(ada), status: 'blocked', waitingOn: { kind: 'decision', id: decision.id } });
      assert.equal(fromDecision.creationUndo?.eligible, true);
      await undo(fromDecision);
      await accept(decision, ada);
      const stayed = await read(fromDecision);
      assert.equal(stayed.lifecycle?.state, 'creation_reverted');
      assert.deepEqual((await lineOf(fromDecision, 'task.resumed')), [], 'read-only history is not resumed');
      // The same with a task: the waiter's creation is undone, and the task it waited for can be finished.
      const awaited = await create({ title: 'Awaited by an undone task', owner: human(ada) });
      const fromTask = await create({ title: 'Undone waiter for a task', owner: human(ada), status: 'blocked', waitingOn: { kind: 'task', id: awaited.id } });
      await undo(fromTask);
      const finished = await patch(awaited, { status: 'done' });
      assert.equal(finished.status, 'done');
      // And a live waiter beside a reverted one still resumes.
      const target = await create({ title: 'Awaited by two', owner: human(ada) });
      const live = await create({ title: 'Live waiter', owner: human(ada), status: 'blocked', waitingOn: { kind: 'task', id: target.id } });
      const gone = await create({ title: 'Gone waiter', owner: human(ada), status: 'blocked', waitingOn: { kind: 'task', id: target.id } });
      await undo(gone);
      await patch(target, { status: 'done' });
      assert.equal((await read(live)).status, 'in_progress');
    });

    test('a task that something waits for is in use: its creation cannot be undone from under the one that waits', async () => {
      const awaited = await create({ title: 'Awaited prerequisite', owner: human(ada) });
      assert.equal(awaited.creationUndo?.eligible, true);
      await create({ title: 'Waits for it', owner: human(ada), status: 'blocked', waitingOn: { kind: 'task', id: awaited.id } });
      const now = await read(awaited);
      assert.equal(now.creationUndo?.eligible, false);
      assert.equal(now.creationUndo?.reason, 'task_used');
      const refusal = await send(ada, 'POST', `/api/v1/work/${awaited.id}/creation-undo`, { clientCommandId: randomUUID(), expectedVersion: now.version });
      assert.equal(refusal.status, 409);
      // Naming it later by a change is a use too.
      const other = await create({ title: 'Another prerequisite', owner: human(ada) });
      const waiter = await create({ title: 'Waits later', owner: human(ada) });
      await patch(waiter, { status: 'blocked', waitingOn: { kind: 'task', id: other.id } });
      assert.equal((await read(other)).creationUndo?.reason, 'task_used');
    });

    test('a chain of waiting tasks is followed to its end: a circle is refused however long the chain is', async () => {
      const chain: WorkItem[] = [];
      for (let index = 0; index < 55; index++) chain.push(await create({ title: `Link ${index}`, owner: human(ada) }));
      // Each task waits for the next one: link 0 waits for 1, 1 for 2, and so on.
      for (let index = 0; index < chain.length - 1; index++) chain[index] = await patch(chain[index]!, { status: 'blocked', waitingOn: { kind: 'task', id: chain[index + 1]!.id } });
      await refused(chain.at(-1)!, { status: 'blocked', waitingOn: { kind: 'task', id: chain[0]!.id } }, 422, 'WAITING_ON_CYCLE');
    });

    test('a dropped task is done, so it satisfies the prerequisites of the tasks that need it', async () => {
      const prerequisite = await create({ title: 'Prerequisite to drop', owner: human(ada) });
      const needs = await create({ title: 'Needs the dropped one', owner: human(ada), dependencyIds: [prerequisite.id] });
      await refused(needs, { status: 'in_progress' }, 409, 'TASK_PREREQUISITES_UNMET');
      await patch(prerequisite, { status: 'done', dropped: true });
      assert.equal((await patch(needs, { status: 'in_progress' })).status, 'in_progress');
    });

    test('a person who is also the owner finishing their own wait is not told of it', async () => {
      const task = await create({ title: 'Own wait', owner: human(kai), status: 'blocked', waitingFor: human(kai) });
      const done = expectStatus(await send(kai, 'POST', `/api/v1/work/${task.id}/waiting-done`, undefined, { 'If-Match': `"${task.version}"` }), 200) as WorkItem;
      assert.equal(done.status, 'in_progress');
      await new Promise((resolve) => setTimeout(resolve, 1500));
      assert.equal((await notHeard(kai, task)).length, 0);
    });
  });
});
