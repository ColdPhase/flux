import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { before, describe, test } from 'node:test';
import type { Conversation, MessageReadersResult, MessageReceiptsResult } from '@flux/contracts';
import { pool } from './support/db.js';
import { addMember, expectStatus, person, project, workspace, type Person } from './support/people.js';

// The faces under a message (#1231): a space of hundreds answers each run with its count and its 3 newest readers, never all of
// them; the list is a separate, paged request; each reader belongs to the newest run they read whole; and only people who can
// read the space now are counted. The 500 people are rows (a person, a company membership, an observation), so the test reads the
// real receipts and list queries over a real audience without 500 sign-ups.

const PEOPLE = 500;
const PAGE = 20;

describe('read receipts of a large space (#1231)', () => {
  let ada: Person;
  let kai: Person;
  let wsId: string;
  let space: string;
  let older: string;
  let newer: string;
  let crowd: string[] = [];

  const path = (suffix: string) => `/api/v1/projects/${space}/receipts${suffix}`;
  const receipts = (actor: Person, runs: string[][]) => actor.browser.request('POST', path(''), { body: { runs } });
  const readers = (actor: Person, runs: string[][], run: number, after?: string) => actor.browser.request('POST', path('/readers'), { body: { runs, run, ...(after ? { after } : {}) } });
  const root = async (actor: Person, body: string) =>
    (expectStatus(await actor.browser.request('POST', `/api/v1/projects/${space}/conversations`, { body: { body, clientMessageId: randomUUID() } }), 201, 'start') as Conversation).messages[0]!.id;

  before(async () => {
    ada = await person('face-ada');
    kai = await person('face-kai');
    const ws = await workspace(ada, 'Hundreds');
    wsId = ws.id;
    await addMember(ada, wsId, kai, 'member');
    space = (await project(ada, wsId, 'Everyone', 'workspace')).id;
    older = await root(ada, 'Welcome, everyone.');
    await root(kai, 'A question from Kai, so the two of Ada’s runs are apart.');
    newer = await root(ada, 'The plan for next week is in the Wiki.');

    // 500 people, in the company, who all read the last run: the oldest reader first, a second apart, so the order is known.
    crowd = Array.from({ length: PEOPLE }, () => randomUUID());
    await pool.query(`INSERT INTO auth_users (id, name, email) SELECT id, 'Reader ' || lpad(n::text, 3, '0'), id || '@example.test' FROM unnest($1::text[]) WITH ORDINALITY AS u(id, n)`, [crowd]);
    await pool.query(`INSERT INTO workspace_members (workspace_id, user_id, role, created_by) SELECT $1, id, 'member', $2 FROM unnest($3::text[]) AS u(id)`, [wsId, ada.id, crowd]);
    await pool.query(
      `INSERT INTO project_message_observations (workspace_id, project_id, message_id, viewer_id, observed_at)
       SELECT $1, $2, $3, id, now() - make_interval(secs => $4 - n) FROM unnest($5::text[]) WITH ORDINALITY AS u(id, n)`,
      [wsId, space, newer, PEOPLE + 10, crowd]);
  });

  test('a run of 500 readers answers a count and 3 faces, newest first, in a small response', async () => {
    const response = await receipts(ada, [[newer]]);
    const answer = expectStatus(response, 200, 'receipts') as MessageReceiptsResult;
    assert.equal(answer.runs[0]!.count, PEOPLE);
    assert.deepEqual(answer.runs[0]!.readers.map((reader) => reader.name), ['Reader 500', 'Reader 499', 'Reader 498']);
    assert.ok(response.text.length < 1200, `the answer does not grow with the audience (${response.text.length} bytes)`);
  });

  test('the list pages newest first, 20 at a time, to the last reader, and repeats nobody', async () => {
    const runs = [[newer]];
    const first = expectStatus(await readers(ada, runs, 0), 200) as MessageReadersResult;
    assert.equal(first.readers.length, PAGE);
    assert.equal(first.count, PEOPLE);
    assert.notEqual(first.next, null);
    const names = [...first.readers.map((reader) => reader.name)];
    let page = first;
    let pages = 1;
    while (page.next) {
      page = expectStatus(await readers(ada, runs, 0, page.next), 200) as MessageReadersResult;
      names.push(...page.readers.map((reader) => reader.name));
      pages++;
    }
    assert.equal(pages, PEOPLE / PAGE);
    assert.equal(new Set(names).size, PEOPLE, 'every reader once');
    assert.equal(names[0], 'Reader 500');
    assert.equal(names.at(-1), 'Reader 001');
    assert.ok(first.readers.every((reader, index, all) => index === 0 || reader.at < all[index - 1]!.at), 'newest first');
  });

  test('a reader is placed once, in the newest run they read whole; people who cannot read the space now are not counted', async () => {
    // The first 10 of the crowd also read the older run: they read the newer one too, so they are under it only.
    await pool.query(
      `INSERT INTO project_message_observations (workspace_id, project_id, message_id, viewer_id) SELECT $1, $2, $3, id FROM unnest($4::text[]) AS u(id)`,
      [wsId, space, older, crowd.slice(0, 10)]);
    const both = expectStatus(await receipts(ada, [[older], [newer]]), 200) as MessageReceiptsResult;
    assert.deepEqual(both.runs.map((run) => run.count), [0, PEOPLE], 'all 500 read the newer run, so nobody is repeated under the older one');
    // Someone who read only the older run is under the older run.
    const only = randomUUID();
    await pool.query(`INSERT INTO auth_users (id, name, email) VALUES ($1, 'Only Older', $2)`, [only, `${only}@example.test`]);
    await pool.query(`INSERT INTO workspace_members (workspace_id, user_id, role, created_by) VALUES ($1, $2, 'member', $3)`, [wsId, only, ada.id]);
    await pool.query(`INSERT INTO project_message_observations (workspace_id, project_id, message_id, viewer_id) VALUES ($1, $2, $3, $4)`, [wsId, space, older, only]);
    const split = expectStatus(await receipts(ada, [[older], [newer]]), 200) as MessageReceiptsResult;
    assert.deepEqual(split.runs.map((run) => run.count), [1, PEOPLE]);
    assert.deepEqual(split.runs[0]!.readers.map((reader) => reader.name), ['Only Older']);

    // The newest reader leaves the company: the count and the faces name only people who can read the space now.
    expectStatus(await ada.browser.request('DELETE', `/api/v1/workspaces/${wsId}/members/${crowd[PEOPLE - 1]}`), 204);
    const after = expectStatus(await receipts(ada, [[older], [newer]]), 200) as MessageReceiptsResult;
    assert.deepEqual(after.runs.map((run) => run.count), [1, PEOPLE - 1]);
    assert.deepEqual(after.runs[1]!.readers.map((reader) => reader.name), ['Reader 499', 'Reader 498', 'Reader 497']);
  });

  test('only the author of the runs asks, only people who can read the space, and the cursor and the index are checked', async () => {
    const runs = [[newer]];
    expectStatus(await readers(kai, runs, 0), 422, 'Kai did not write that run');
    const outsider = await person('face-out');
    expectStatus(await readers(outsider, runs, 0), 404, 'someone outside the space');
    expectStatus(await readers(ada, runs, 1), 400, 'run must name one of the runs');
    expectStatus(await readers(ada, runs, 0, 'not-a-cursor'), 400, 'after must be a cursor');
  });
});
