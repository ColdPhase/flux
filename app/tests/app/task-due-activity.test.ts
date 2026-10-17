import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { before, describe, test } from 'node:test';
import { projectWorkDetailPath, projectWorkViewPath, taskActivityPath, type Project, type TaskActivityEntry, type TaskActivityPage, type Workspace, type WorkItem } from '@flux/contracts';
import { pool } from './support/db.js';
import { Browser } from './support/http.js';
import { actionScene, toolFailure } from './support/mcp-actions.js';
import { toolValue } from './support/mcp.js';
import { addMember, expectStatus, grant, person, project as createProject, workspace, type Person } from './support/people.js';
import { eraseProject } from './support/project-erasure-scene.js';

// A task has a due date and a real history (#488, migration 0107). The due date is a calendar day with no time zone. Every
// change of status, owner, due date or title keeps one activity entry with the person or agent who made it and when, whichever
// path made it; a read of the activity needs exactly the access to read the task.

const human = (someone: Person) => ({ kind: 'human' as const, id: someone.id });
const count = async (workId: string) => Number((await pool.query('SELECT count(*)::int AS n FROM project_task_activity WHERE work_id = $1', [workId])).rows[0].n);

describe('a task has a due date and a history of who changed it', () => {
  let ada: Person; let kai: Person; let vera: Person; let olga: Person; let ws: Workspace; let place: Project;
  const create = async (body: Record<string, unknown>, who = ada) => expectStatus(await who.browser.request('POST', `/api/v1/projects/${place.id}/work`, { body }), 201) as WorkItem;
  const send = (who: Person, task: Pick<WorkItem, 'id' | 'version'>, body: Record<string, unknown>, headers: Record<string, string> = {}) =>
    who.browser.request('PATCH', `/api/v1/work/${task.id}`, { body: { clientCommandId: randomUUID(), ...body }, headers: { 'If-Match': `"${task.version}"`, ...headers } });
  const patch = async (task: Pick<WorkItem, 'id' | 'version'>, body: Record<string, unknown>, who = ada) => expectStatus(await send(who, task, body), 200) as WorkItem;
  const read = async (task: Pick<WorkItem, 'id'>, who = ada) => expectStatus(await who.browser.request('GET', `/api/v1/work/${task.id}`), 200) as WorkItem;
  const activity = async (task: Pick<WorkItem, 'id'>, query = '', who = ada) =>
    expectStatus(await who.browser.request('GET', `${taskActivityPath(task.id)}${query}`), 200) as TaskActivityPage;

  before(async () => {
    [ada, kai, vera, olga] = await Promise.all(['da-ada', 'da-kai', 'da-vera', 'da-olga'].map(person));
    ws = await workspace(ada, 'Due space');
    for (const someone of [kai, vera, olga]) await addMember(ada, ws.id, someone, 'member');
    place = await createProject(ada, ws.id, 'Due project', 'restricted');
    await grant(ada, place.id, kai, 'contributor');
    await grant(ada, place.id, vera, 'viewer');
  });

  describe('the due date', () => {
    test('is set when the task is created or changed, cleared with null, and read everywhere the task is', async () => {
      const without = await create({ title: 'No date yet' });
      assert.equal(without.dueOn, null);
      const task = await create({ title: 'Order the boards', dueOn: '2026-11-03' });
      assert.equal(task.dueOn, '2026-11-03');
      assert.equal((await read(task)).dueOn, '2026-11-03');
      const listed = expectStatus(await ada.browser.request('GET', `/api/v1/projects/${place.id}/work?limit=100`), 200) as { items: WorkItem[] };
      assert.equal(listed.items.find((item) => item.id === task.id)?.dueOn, '2026-11-03');
      const detail = expectStatus(await ada.browser.request('GET', projectWorkDetailPath(place.id, 'work', task.id)), 200) as { object: { dueOn: string | null } };
      assert.equal(detail.object.dueOn, '2026-11-03', 'the task panel reads it from the work detail');
      const rows = expectStatus(await ada.browser.request('GET', `${projectWorkViewPath(place.id)}?purpose=tasks&kinds=work&group=all&limit=100`), 200) as { items: { id: string; dueOn?: string | null }[] };
      assert.equal(rows.items.find((item) => item.id === task.id)?.dueOn, '2026-11-03', 'and the list rows carry it');

      const moved = await patch(task, { dueOn: '2026-12-24' });
      assert.equal(moved.dueOn, '2026-12-24');
      assert.equal(moved.version, task.version + 1, 'changing only the due date is an ordinary versioned change');
      const cleared = await patch(moved, { dueOn: null });
      assert.equal(cleared.dueOn, null);
      assert.equal((await read(task)).dueOn, null);
      assert.equal((await patch(cleared, { dueOn: '1970-01-01' })).dueOn, '1970-01-01');
      assert.equal((await create({ title: 'Last day', dueOn: '9999-12-31' })).dueOn, '9999-12-31');
      assert.equal((await create({ title: 'Leap day', dueOn: '2028-02-29' })).dueOn, '2028-02-29');
      assert.equal((await create({ title: 'Explicit none', dueOn: null })).dueOn, null);
    });

    test('must be a real calendar day from 1970 to 9999; a refusal changes nothing', async () => {
      const task = await create({ title: 'Strict dates', dueOn: '2026-05-01' });
      for (const bad of ['2026-02-31', '2027-02-29', '2026-13-01', '2026-00-10', '2026-04-31', '2026-2-3', '26-02-03', '1969-12-31', '0001-01-01', '10000-01-01',
        '', ' 2026-05-02', '2026-05-02T00:00:00Z', '2026-05-02T10', '05/02/2026', 20260502, true, {}]) {
        const refused = await send(ada, task, { dueOn: bad });
        assert.equal(refused.status, 400, `${JSON.stringify(bad)} on update: ${refused.text}`);
        const created = await ada.browser.request('POST', `/api/v1/projects/${place.id}/work`, { body: { title: 'Bad date', dueOn: bad } });
        assert.equal(created.status, 400, `${JSON.stringify(bad)} on create: ${created.text}`);
      }
      const still = await read(task);
      assert.deepEqual([still.dueOn, still.version], ['2026-05-01', task.version]);
      assert.equal(await count(task.id), 0);
    });

    test('honours If-Match and the client command like every other field', async () => {
      const task = await create({ title: 'Versioned due date' });
      const moved = await patch(task, { dueOn: '2026-11-10' });
      // A stale version is refused with the current task, and nothing is recorded.
      const stale = await send(ada, task, { dueOn: '2026-11-11' });
      assert.equal(stale.status, 409);
      assert.equal((stale.json as { code: string }).code, 'VERSION_CONFLICT');
      assert.equal((await read(task)).dueOn, '2026-11-10');
      // An exact retry of the same command returns the original outcome and writes nothing more.
      const commandId = randomUUID();
      const first = expectStatus(await send(ada, moved, { dueOn: '2026-11-12', clientCommandId: commandId }), 200) as WorkItem;
      const rows = await count(task.id);
      const retry = expectStatus(await send(ada, moved, { dueOn: '2026-11-12', clientCommandId: commandId }), 200) as WorkItem;
      assert.deepEqual([retry.version, retry.dueOn], [first.version, '2026-11-12']);
      assert.equal(await count(task.id), rows, 'a replay records no second entry');
      // Another date for the same command is a different intent.
      const other = await send(ada, moved, { dueOn: '2026-11-13', clientCommandId: commandId });
      assert.equal(other.status, 409);
      assert.equal((other.json as { code: string }).code, 'IDEMPOTENCY_CONFLICT');
      assert.equal((await read(task)).dueOn, '2026-11-12');
      // The transport's Idempotency-Key replays the stored response without running again.
      const key = randomUUID(); const keyedCommand = randomUUID();
      const keyed = expectStatus(await send(ada, first, { dueOn: '2026-11-14', clientCommandId: keyedCommand }, { 'Idempotency-Key': key }), 200) as WorkItem;
      const afterKeyed = await count(task.id);
      const replayed = expectStatus(await send(ada, first, { dueOn: '2026-11-14', clientCommandId: keyedCommand }, { 'Idempotency-Key': key }), 200) as WorkItem;
      assert.deepEqual([replayed.version, replayed.dueOn], [keyed.version, '2026-11-14']);
      assert.equal(await count(task.id), afterKeyed);
    });

    test('needs write access like every field: a viewer is refused and a stranger does not see the task', async () => {
      const task = await create({ title: 'Writers only', dueOn: '2026-11-20' });
      assert.equal((await send(vera, task, { dueOn: '2026-11-21' })).status, 403);
      assert.equal((await send(olga, task, { dueOn: '2026-11-21' })).status, 404);
      const viewerCreate = await vera.browser.request('POST', `/api/v1/projects/${place.id}/work`, { body: { title: 'Nope', dueOn: '2026-11-21' } });
      assert.equal(viewerCreate.status, 403);
      assert.equal((await read(task)).dueOn, '2026-11-20');
      assert.equal(await count(task.id), 0);
      // A contributor may.
      assert.equal((await patch(task, { dueOn: '2026-11-22' }, kai)).dueOn, '2026-11-22');
    });
  });

  describe('the activity', () => {
    test('keeps one entry per changed field with the real person, in the order they happened', async () => {
      const task = await create({ title: 'Mount the sensor', dueOn: '2026-11-03', status: 'open', owner: human(ada) });
      assert.deepEqual((await activity(task)).items, [], 'creation is not an entry; the task carries createdBy and createdAt');
      // Four fields in one command are four entries, all by the person who made it.
      const everything = await patch(task, { title: 'Mount the distance sensor', status: 'in_progress', owner: human(kai), dueOn: '2026-12-01' });
      const first = await activity(task);
      assert.equal(first.items.length, 4);
      assert.deepEqual(first.items.map((entry) => entry.kind).sort(), ['due', 'owner', 'status', 'title']);
      for (const entry of first.items) {
        assert.deepEqual([entry.actor.kind, entry.actor.id, entry.actor.name], ['human', ada.id, 'da-ada']);
        assert.match(entry.at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
        assert.equal(entry.automation, undefined);
      }
      const byKind = (entries: TaskActivityEntry[], kind: string) => entries.find((entry) => entry.kind === kind)!;
      assert.deepEqual(byKind(first.items, 'status').status, { from: 'open', to: 'in_progress', blocker: null, waitingFor: null });
      assert.deepEqual(byKind(first.items, 'title').title, { from: 'Mount the sensor', to: 'Mount the distance sensor' });
      assert.deepEqual(byKind(first.items, 'due').due, { from: '2026-11-03', to: '2026-12-01' });
      assert.deepEqual(byKind(first.items, 'owner').owner, { from: { kind: 'human', id: ada.id, name: 'da-ada' }, to: { kind: 'human', id: kai.id, name: 'da-kai' } });
      // Another person's change is theirs, and it sorts before the earlier ones.
      const cleared = await patch(everything, { dueOn: null, owner: null }, kai);
      const second = await activity(task);
      assert.equal(second.items.length, 6);
      const newest = second.items.slice(0, 2);
      assert.deepEqual(newest.map((entry) => entry.kind).sort(), ['due', 'owner']);
      for (const entry of newest) assert.deepEqual([entry.actor.id, entry.actor.name], [kai.id, 'da-kai']);
      assert.deepEqual(byKind(newest, 'due').due, { from: '2026-12-01', to: null });
      assert.deepEqual(byKind(newest, 'owner').owner, { from: { kind: 'human', id: kai.id, name: 'da-kai' }, to: null });
      const times = second.items.map((entry) => Date.parse(entry.at));
      assert.deepEqual(times, [...times].sort((a, b) => b - a), 'newest first');
      assert.ok(Math.abs(Date.parse(second.items[0]!.at) - Date.now()) < 120_000);
      assert.equal(second.workId, task.id);
      assert.equal(second.nextBefore, null);
      assert.equal(cleared.dueOn, null);
    });

    test('keeps nothing for a change that changes nothing, a refusal, a stale version or creation with values', async () => {
      const task = await create({ title: 'Quiet', dueOn: '2026-11-03', status: 'in_progress', owner: human(kai) });
      assert.equal(await count(task.id), 0, 'a task created with an owner, state and date has no change entries');
      const same = await patch(task, { title: 'Quiet', status: 'in_progress', owner: human(kai), dueOn: '2026-11-03', outcome: 'A different outcome' });
      assert.equal(await count(task.id), 0, 'the same values are not a change; an outcome is not tracked');
      assert.equal((await send(ada, same, { title: 'x'.repeat(201) })).status, 400);
      assert.equal((await send(ada, task, { title: 'Stale' })).status, 409);
      assert.equal((await send(vera, same, { title: 'Viewer' })).status, 403);
      assert.equal((await send(ada, same, { owner: { kind: 'human', id: olga.id } })).status, 422, 'an owner without access is refused');
      assert.equal(await count(task.id), 0);
      await patch(same, { criteria: ['Both runs are attached'], blocker: null });
      assert.equal(await count(task.id), 0, 'criteria are not tracked');
    });

    test('records a block with its reason and the person it waits for, and an Undo that restores it', async () => {
      const task = await create({ title: 'Choose the lens', owner: human(ada) });
      const blocked = await patch(task, { status: 'blocked', blocker: 'Which focal length?', waitingFor: human(kai) });
      const edited = await patch(blocked, { blocker: 'Which focal length, and which mount?' });
      assert.equal((await activity(task)).items.length, 1, 'editing the reason of a blocked task is not a status change');
      const open = await patch(edited, { status: 'in_progress' });
      const back = await patch(open, { status: 'blocked', blocker: 'Which focal length, and which mount?', waitingFor: human(kai), restore: true });
      const done = await patch(back, { status: 'done' });
      assert.equal(done.status, 'done');
      const entries = (await activity(task)).items.map((entry) => entry.status);
      assert.deepEqual(entries, [
        { from: 'blocked', to: 'done', blocker: null, waitingFor: null },
        { from: 'in_progress', to: 'blocked', blocker: 'Which focal length, and which mount?', waitingFor: { kind: 'human', id: kai.id, name: 'da-kai' } },
        { from: 'blocked', to: 'in_progress', blocker: null, waitingFor: null },
        { from: 'open', to: 'blocked', blocker: 'Which focal length?', waitingFor: { kind: 'human', id: kai.id, name: 'da-kai' } },
      ], 'a restore is a status change like any other');
      // Blocked with no one to wait for.
      const lone = await create({ title: 'No one in particular' });
      await patch(lone, { status: 'blocked', blocker: 'Waiting on the weather' });
      assert.deepEqual((await activity(lone)).items[0]!.status, { from: 'open', to: 'blocked', blocker: 'Waiting on the weather', waitingFor: null });
    });

    test('records an agent as the agent, and a person as the person, whichever path made the change', async () => {
      const f = await actionScene(pool);
      const ownerId = (await pool.query('SELECT owner_user_id FROM agents WHERE id = $1', [f.agentId])).rows[0].owner_user_id as string;
      const update = await f.grant('work.update', 'execute');
      const target = await f.owner.request('POST', `/api/v1/projects/${f.projectId}/work`, { body: { title: 'Run the comparison' } });
      const task = expectStatus(target, 201) as WorkItem;
      const command = (expectedVersion: number, changes: Record<string, unknown>, clientCommandId = randomUUID()) => ({ projectId: f.projectId,
        runtimeSessionId: f.runtimeSessionId, grantId: update.id, clientCommandId, peerRequestClass: 'execute', sources: [], workId: task.id, expectedVersion, changes });
      const commandId = randomUUID();
      const changed = toolValue(await f.tool('flux_update_task', command(task.version, { status: 'in_progress', title: 'Run the comparison twice' }, commandId)));
      const readEntries = async () => expectStatus(await f.owner.request('GET', taskActivityPath(task.id)), 200) as TaskActivityPage;
      const agentEntries = await readEntries();
      assert.deepEqual(agentEntries.items.map((entry) => entry.kind).sort(), ['status', 'title']);
      for (const entry of agentEntries.items) {
        assert.deepEqual([entry.actor.kind, entry.actor.id, entry.actor.name], ['agent', f.agentId, 'Planning agent']);
        assert.deepEqual(entry.actor.projectOwner, { kind: 'human', id: ownerId }, 'an agent carries its owner as the task detail shows it');
      }
      // The agent's retry of the same command records nothing more.
      assert.deepEqual(toolValue(await f.tool('flux_update_task', command(task.version, { status: 'in_progress', title: 'Run the comparison twice' }, commandId))), { ...changed, replayed: true });
      assert.equal((await readEntries()).items.length, 2);
      // The owner then hands it to the agent: the owner is recorded as the agent, named and scoped like the agent's own entries.
      const current = expectStatus(await f.owner.request('GET', `/api/v1/work/${task.id}`), 200) as WorkItem;
      expectStatus(await f.owner.request('PATCH', `/api/v1/work/${task.id}`, { body: { owner: { kind: 'agent', id: f.agentId }, clientCommandId: randomUUID() }, headers: { 'If-Match': `"${current.version}"` } }), 200);
      const handed = (await readEntries()).items[0]!;
      assert.equal(handed.kind, 'owner');
      assert.deepEqual([handed.actor.kind, handed.actor.id], ['human', ownerId]);
      assert.deepEqual(handed.owner, { from: null, to: { kind: 'agent', id: f.agentId, name: 'Planning agent', projectOwner: { kind: 'human', id: ownerId } } });
      // A task finished by the result an agent records.
      const results = await f.grant('result.record', 'execute');
      const finishing = (expectStatus(await f.owner.request('GET', `/api/v1/work/${task.id}`), 200) as WorkItem);
      toolValue(await f.tool('flux_record_result', { projectId: f.projectId, runtimeSessionId: f.runtimeSessionId, grantId: results.id, clientCommandId: randomUUID(), peerRequestClass: 'execute', sources: [f.source],
        result: { title: 'Compared twice', finding: 'positive', evidence: 'Both runs agree', workIds: [task.id], finishes: { workId: task.id, expectedVersion: finishing.version } } }));
      const finished = (await readEntries()).items[0]!;
      assert.deepEqual([finished.kind, finished.actor.kind, finished.actor.id, finished.status?.to], ['status', 'agent', f.agentId, 'done']);
      assert.equal(toolFailure(await f.tool('flux_update_task', command(finishing.version, { title: 'Stale' }))).code, 'VERSION_CONFLICT');
      assert.equal((await readEntries()).items.length, 4, 'a refused agent change records nothing');
    });

    test('a person finishing a task with a result is the one who made the change', async () => {
      const task = await create({ title: 'Measure it', status: 'in_progress' });
      expectStatus(await ada.browser.request('POST', `/api/v1/projects/${place.id}/results`,
        { body: { title: 'Measured', finding: 'negative', evidence: 'Four hours', work: [task.id], finishes: { id: task.id, expectedVersion: task.version }, clientCommandId: randomUUID() } }), 201);
      const [entry] = (await activity(task)).items;
      assert.deepEqual([entry!.kind, entry!.actor.id, entry!.status], ['status', ada.id, { from: 'in_progress', to: 'done', blocker: null, waitingFor: null }]);
    });

    test('pages newest first with a stable cursor, and refuses a limit or cursor it cannot use', async () => {
      const task = await create({ title: 'Title 0' });
      let current = task;
      for (let i = 1; i <= 7; i += 1) current = await patch(current, { title: `Title ${i}` });
      const everything = await activity(task, '?limit=50');
      assert.equal(everything.items.length, 7);
      assert.deepEqual(everything.items.map((entry) => entry.title?.to), ['Title 7', 'Title 6', 'Title 5', 'Title 4', 'Title 3', 'Title 2', 'Title 1']);
      const seen: string[] = []; let before: string | null = null; let pages = 0;
      do {
        const page: TaskActivityPage = await activity(task, `?limit=3${before ? `&before=${before}` : ''}`);
        assert.ok(page.items.length <= 3);
        seen.push(...page.items.map((entry) => entry.id)); before = page.nextBefore; pages += 1;
      } while (before);
      assert.equal(pages, 3);
      assert.deepEqual(seen, everything.items.map((entry) => entry.id), 'the pages join up without a repeat or a gap');
      const exact = await activity(task, '?limit=7');
      assert.equal(exact.nextBefore, null, 'a page that ends the history has no cursor');
      // A change made after the first page does not shift the next one.
      const firstPage = await activity(task, '?limit=3');
      await patch(current, { title: 'Title 8' });
      const afterwards = await activity(task, `?limit=3&before=${firstPage.nextBefore}`);
      assert.deepEqual(afterwards.items.map((entry) => entry.title?.to), ['Title 4', 'Title 3', 'Title 2']);
      for (const query of ['?limit=0', '?limit=51', '?limit=-1', '?limit=abc', '?limit=1.5', '?before=', '?before=nope', `?before=${Buffer.from('{"t":"x","i":"y"}').toString('base64url')}`])
        assert.equal((await ada.browser.request('GET', `${taskActivityPath(task.id)}${query}`)).status, 400, query);
      assert.equal((await activity(task, '?limit=50')).items.length, 8);
    });

    test('shows thirty by default and breaks ties of identical times by id', async () => {
      const task = await create({ title: 'Many changes' });
      const stamp = '2026-10-17T10:00:00.123456Z';
      await pool.query(`INSERT INTO project_task_activity(id, workspace_id, project_id, work_id, kind, actor_kind, actor_id, detail, created_at)
        SELECT gen_random_uuid(), $1::uuid, $2::uuid, $3::uuid, 'due', 'human', $4::text, jsonb_build_object('from', NULL::text, 'to', to_char(DATE '2026-01-01' + n, 'YYYY-MM-DD')),
          CASE WHEN n < 40 THEN $5::timestamptz ELSE $5::timestamptz + (n - 39) * interval '1 microsecond' END
        FROM generate_series(1, 55) AS n`, [ws.id, place.id, task.id, ada.id, stamp]);
      const first = await activity(task);
      assert.equal(first.items.length, 30);
      assert.ok(first.nextBefore);
      const ordered = (await pool.query<{ id: string }>('SELECT id FROM project_task_activity WHERE work_id = $1 ORDER BY created_at DESC, id DESC', [task.id])).rows.map((row) => row.id);
      assert.deepEqual(first.items.map((entry) => entry.id), ordered.slice(0, 30));
      // One entry at a time across microseconds that a millisecond clock cannot tell apart.
      const one: string[] = []; let before: string | null = null;
      do {
        const page: TaskActivityPage = await activity(task, `?limit=1${before ? `&before=${before}` : ''}`);
        one.push(...page.items.map((entry) => entry.id)); before = page.nextBefore;
      } while (before);
      assert.deepEqual(one, ordered, 'no entry repeats or is skipped');
      assert.equal((await activity(task, '?limit=50')).items.length, 50);
    });

    test('is readable by exactly those who can read the task, including a task whose creation was undone', async () => {
      const task = await create({ title: 'Who may look', dueOn: '2026-11-03' });
      await patch(task, { title: 'Who may look at it' });
      for (const reader of [ada, kai, vera]) assert.equal((await activity(task, '', reader)).items.length, 1);
      // Not a project reader: the same answer as the task itself.
      const taskRead = await olga.browser.request('GET', `/api/v1/work/${task.id}`);
      const activityRead = await olga.browser.request('GET', taskActivityPath(task.id));
      assert.deepEqual([activityRead.status, (activityRead.json as { code: string }).code], [taskRead.status, (taskRead.json as { code: string }).code]);
      assert.equal(activityRead.status, 404);
      assert.equal((await olga.browser.request('GET', `${taskActivityPath(task.id)}?limit=0&before=junk`)).status, 404, 'access is decided before the query');
      for (const id of [randomUUID(), 'not-an-id']) assert.equal((await ada.browser.request('GET', taskActivityPath(id))).status, 404);
      assert.equal((await new Browser().request('GET', taskActivityPath(task.id))).status, 401);
      // Access that is taken away takes the history away with it.
      await grant(ada, place.id, olga, 'viewer');
      assert.equal((await activity(task, '', olga)).items.length, 1);
      await grant(ada, place.id, olga, 'denied');
      assert.equal((await olga.browser.request('GET', taskActivityPath(task.id))).status, 404);

      // A task whose creation was undone stays readable as history.
      const f = await actionScene(pool);
      const createGrant = await f.grant('work.create', 'execute');
      const created = toolValue(await f.tool('flux_create_task', { projectId: f.projectId, runtimeSessionId: f.runtimeSessionId, grantId: createGrant.id,
        clientCommandId: randomUUID(), peerRequestClass: 'execute', sources: [], task: { title: 'Unused agent trial' } }));
      const item = await f.read(String(created.workId)) as unknown as WorkItem;
      expectStatus(await f.owner.request('POST', `/api/v1/work/${item.id}/creation-undo`, { body: { clientCommandId: randomUUID(), expectedVersion: item.version } }), 200);
      const history = expectStatus(await f.owner.request('GET', taskActivityPath(item.id)), 200) as TaskActivityPage;
      assert.deepEqual([history.workId, history.items, history.nextBefore], [item.id, [], null]);
    });

    test('goes with its project when the project is erased', async () => {
      const doomed = await createProject(ada, ws.id, 'Erased with its history', 'workspace');
      const task = expectStatus(await ada.browser.request('POST', `/api/v1/projects/${doomed.id}/work`, { body: { title: 'Before' } }), 201) as WorkItem;
      expectStatus(await send(ada, task, { title: 'After', dueOn: '2026-11-03', status: 'in_progress' }), 200);
      assert.equal(await count(task.id), 3);
      await eraseProject(doomed.id);
      assert.equal(await count(task.id), 0);
      assert.equal(Number((await pool.query('SELECT count(*)::int AS n FROM project_task_activity WHERE project_id = $1', [doomed.id])).rows[0].n), 0);
      assert.equal((await pool.query('SELECT 1 FROM projects WHERE id = $1', [doomed.id])).rowCount, 0);
    });
  });
});
