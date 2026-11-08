import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { sql } from 'drizzle-orm';
import { notificationRows } from '@flux/db';
import { workUseCases } from '../../apps/server/src/work/adapters.js';
import { pool } from './support/db.js';
import { countingDatabase } from './support/query-count.js';
import { addMember, expectStatus, person, project, workspace, type Person } from './support/people.js';
import { waitFor } from './support/wait.js';

// #828: a page of task notices and a page of the Inbox read what they point at together, not one task at a time. The number of
// statements is the same for 3 rows as for 18 (it was 11 → 113 and 10 → 218 for a page of 100).

let ada: Person;
let jonas: Person;
let projectId: string;
const counting = countingDatabase();
after(() => counting.close());

const task = async (title: string, assignee?: Person) => expectStatus(await ada.browser.request('POST', `/api/v1/projects/${projectId}/work`,
  { body: { title, ...(assignee ? { owner: { kind: 'human', id: assignee.id } } : {}) } }), 201) as { id: string; version: number };
const undo = async (made: { id: string; version: number }) => expectStatus(await ada.browser.request('POST', `/api/v1/work/${made.id}/creation-undo`,
  { body: { clientCommandId: randomUUID(), expectedVersion: made.version } }), 200);

describe('reads that follow each row to another row are batched (#828)', () => {
  before(async () => {
    ada = await person('query-counts-ada');
    jonas = await person('query-counts-jonas');
    const company = await workspace(ada, 'Query counts');
    await addMember(ada, company.id, jonas, 'member');
    projectId = (await project(ada, company.id, 'Counted reads', 'workspace')).id;
  });

  test('task notices: the statements do not grow with the page, and an undone creation still shows', async () => {
    const principal = { kind: 'human' as const, id: ada.id };
    const read = (limit: number) => workUseCases(counting.db).listTaskNotices(principal, projectId, { limit, offset: 0 });
    const first = [await task('Notice 1'), await task('Notice 2'), await task('Notice 3')];
    await read(50); // the first read of a workspace also learns that it is not encrypted; that is not what grows with the page
    let small: Awaited<ReturnType<typeof read>> | undefined;
    const few = await counting.count(async () => { small = await read(50); });
    assert.equal(small!.items.length, 3);
    for (let number = 4; number <= 18; number++) await task(`Notice ${number}`);
    let large: Awaited<ReturnType<typeof read>> | undefined;
    const many = await counting.count(async () => { large = await read(50); });
    assert.equal(large!.items.length, 18);
    assert.equal(many, few, `3 notices took ${few} statements, 18 took ${many}`);
    assert.ok(many <= 12, `a page of notices took ${many} statements`);
    // The task's own record still decides what a notice says: an undone creation shows its lifecycle.
    await undo(first[0]!);
    const after = await read(50);
    const states = Object.fromEntries(after.items.map((item) => [item.workId, item.lifecycle?.state]));
    assert.equal(states[first[0]!.id], 'creation_reverted');
    assert.equal(states[first[1]!.id], 'active');
  });

  test('Inbox assignment notifications: the statements do not grow with the page, and an undone creation still says so', async () => {
    const assigned = async () => Number((await pool.query(`SELECT count(*)::int AS n FROM notifications WHERE user_id = $1 AND reason = 'assigned'`, [jonas.id])).rows[0].n);
    const read = () => notificationRows(counting.db).listForRecipient(jonas.id, sql`true`, 100);
    const made = [await task('Assigned 1', jonas), await task('Assigned 2', jonas), await task('Assigned 3', jonas)];
    await waitFor(async () => (await assigned()) >= 3, 'three assignment notifications');
    let small: Awaited<ReturnType<typeof read>> = [];
    const few = await counting.count(async () => { small = await read(); });
    assert.ok(small.length >= 3);
    for (let number = 4; number <= 18; number++) await task(`Assigned ${number}`, jonas);
    await waitFor(async () => (await assigned()) >= 18, 'eighteen assignment notifications');
    let large: Awaited<ReturnType<typeof read>> = [];
    const many = await counting.count(async () => { large = await read(); });
    assert.ok(large.length >= 18);
    assert.equal(many, few, `${small.length} rows took ${few} statements, ${large.length} took ${many}`);
    assert.ok(many <= 6, `a page of the Inbox took ${many} statements`);
    await undo(made[0]!);
    const rows = await read();
    const undone = rows.filter((row) => row.body.includes('Task creation undone'));
    assert.equal(undone.length, 1, 'exactly the notification of the task whose creation was undone says so');
  });
});
