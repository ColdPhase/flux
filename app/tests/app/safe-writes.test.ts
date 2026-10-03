import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import type { Draft, VersionConflict, Workspace } from '@flux/contracts';
import { createDatabase, idempotencyRepository } from '@flux/db';
import { deleteExpiredIdempotencyKeys } from '@flux/core';
import { addMember, draft, expectStatus, grant, person, project, type Person } from './support/people.js';

// If-Match preconditions and idempotency keys over HTTP (issue #29, AC-4).
const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required');
const { db, pool } = createDatabase(connectionString);
after(() => pool.end());

async function stored(draftId: string) {
  const result = await pool.query('SELECT title, body, visibility, project_id, version FROM drafts WHERE id = $1', [draftId]);
  return result.rows[0];
}

describe('If-Match preconditions', () => {
  let author: Person;
  let stranger: Person;
  let ws: Workspace;

  before(async () => {
    [author, stranger] = await Promise.all(['precondition-author', 'precondition-stranger'].map(person));
    ws = expectStatus(await author.browser.request('POST', '/api/v1/workspaces', { body: { name: 'Preconditions' } }), 201) as Workspace;
  });

  test('draft responses carry the version as ETag', async () => {
    const created = await author.browser.request('POST', `/api/v1/workspaces/${ws.id}/drafts`, { body: { title: 'Tagged' } });
    assert.equal(created.status, 201);
    assert.equal(created.headers.get('etag'), '"1"');
    const read = await author.browser.request('GET', `/api/v1/drafts/${(created.json as Draft).id}`);
    assert.equal(read.headers.get('etag'), '"1"');
  });

  test('a missing precondition is 428 and a stale one is 409 with the latest version; neither writes', async () => {
    const item = await draft(author, ws.id, 'Plan', { body: 'first' });
    const missing = expectStatus(await author.browser.request('PATCH', `/api/v1/drafts/${item.id}`, { body: { body: 'no precondition' } }), 428) as { code: string };
    assert.equal(missing.code, 'PRECONDITION_REQUIRED');
    assert.equal((await stored(item.id)).body, 'first');

    const updated = await author.browser.request('PATCH', `/api/v1/drafts/${item.id}`, { body: { body: 'second' }, headers: { 'if-match': '"1"' } });
    assert.equal(updated.status, 200);
    assert.equal((updated.json as Draft).version, 2);
    assert.equal(updated.headers.get('etag'), '"2"');

    const stale = expectStatus(await author.browser.request('PATCH', `/api/v1/drafts/${item.id}`, { body: { body: 'lost update' }, headers: { 'if-match': '"1"' } }), 409) as VersionConflict;
    assert.equal(stale.code, 'VERSION_CONFLICT');
    assert.equal(stale.currentVersion, 2);
    assert.equal(stale.current.body, 'second', 'conflict returns the latest authorized object');
    assert.deepEqual(await stored(item.id), { title: 'Plan', body: 'second', visibility: 'private', project_id: null, version: 2 }, 'stale write did not overwrite');

    const viaBody = expectStatus(await author.browser.request('PATCH', `/api/v1/drafts/${item.id}`, { body: { body: 'third', expectedVersion: 2 } }), 200) as Draft;
    assert.equal(viaBody.version, 3);
    expectStatus(await author.browser.request('PATCH', `/api/v1/drafts/${item.id}`, { body: { body: 'x', expectedVersion: 3 }, headers: { 'if-match': '"2"' } }), 400, 'header and body disagree');
    expectStatus(await author.browser.request('PATCH', `/api/v1/drafts/${item.id}`, { body: { body: 'x' }, headers: { 'if-match': '*' } }), 400, 'wildcard is not a version');
  });

  test('share and move need the expected version too', async () => {
    const room = await project(author, ws.id, 'Room', 'workspace');
    const item = await draft(author, ws.id, 'Movable', { projectId: room.id });
    expectStatus(await author.browser.request('POST', `/api/v1/drafts/${item.id}/share`, { body: { scope: 'workspace' } }), 428, 'share without precondition');
    expectStatus(await author.browser.request('POST', `/api/v1/drafts/${item.id}/move`, { body: { projectId: null, visibility: 'private' } }), 428, 'move without precondition');
    expectStatus(await author.browser.request('POST', `/api/v1/drafts/${item.id}/share`, { body: { scope: 'workspace' }, headers: { 'if-match': '"1"' } }), 200);
    expectStatus(await author.browser.request('POST', `/api/v1/drafts/${item.id}/move`, { body: { projectId: null, visibility: 'private' }, headers: { 'if-match': '"1"' } }), 409, 'stale move');
    expectStatus(await author.browser.request('POST', `/api/v1/drafts/${item.id}/share`, { body: { scope: 'private' }, headers: { 'if-match': '"1"' } }), 409, 'stale share');
    assert.deepEqual(await stored(item.id), { title: 'Movable', body: '', visibility: 'workspace', project_id: room.id, version: 2 });
  });

  test('authorization is decided before the precondition, so nothing leaks', async () => {
    const item = await draft(author, ws.id, 'Hidden');
    expectStatus(await stranger.browser.request('PATCH', `/api/v1/drafts/${item.id}`, { body: { body: 'x' } }), 404, 'no precondition, invisible');
    expectStatus(await stranger.browser.request('PATCH', `/api/v1/drafts/${item.id}`, { body: { body: 'x' }, headers: { 'if-match': '"9"' } }), 404, 'stale precondition, invisible');
  });
});

describe('idempotency keys', () => {
  let author: Person;
  let colleague: Person;
  let ws: Workspace;
  let second: Workspace;

  before(async () => {
    [author, colleague] = await Promise.all(['idempotent-author', 'idempotent-colleague'].map(person));
    ws = expectStatus(await author.browser.request('POST', '/api/v1/workspaces', { body: { name: 'Idempotent' } }), 201) as Workspace;
    second = expectStatus(await author.browser.request('POST', '/api/v1/workspaces', { body: { name: 'Idempotent two' } }), 201) as Workspace;
    await addMember(author, ws.id, colleague, 'member');
  });

  const create = (who: Person, workspaceId: string, title: string, key: string) =>
    who.browser.request('POST', `/api/v1/workspaces/${workspaceId}/drafts`, { body: { title }, headers: { 'idempotency-key': key } });
  const countTitled = async (title: string) => (await pool.query('SELECT count(*)::int AS n FROM drafts WHERE title = $1', [title])).rows[0].n as number;

  test('a matching retry returns the stored response and creates one row', async () => {
    const key = randomUUID();
    const title = `Once ${key}`;
    const first = await create(author, ws.id, title, key);
    assert.equal(first.status, 201);
    assert.equal(first.headers.get('idempotent-replayed'), null);
    const retry = await create(author, ws.id, title, key);
    assert.equal(retry.status, 201, 'same status');
    assert.deepEqual(retry.json, first.json, 'same body');
    assert.equal(retry.headers.get('idempotent-replayed'), 'true');
    assert.equal(retry.headers.get('etag'), '"1"');
    assert.equal(await countTitled(title), 1);
    const events = await pool.query("SELECT count(*)::int AS n FROM events WHERE object_id = $1 AND kind = 'draft.created.v1'", [(first.json as Draft).id]);
    assert.equal(events.rows[0].n, 1, 'one event');
  });

  test('the same key with a different body is rejected with 422', async () => {
    const key = randomUUID();
    expectStatus(await create(author, ws.id, `Original ${key}`, key), 201);
    const reused = expectStatus(await create(author, ws.id, `Changed ${key}`, key), 422) as { code: string };
    assert.equal(reused.code, 'IDEMPOTENCY_KEY_REUSED');
    assert.equal(await countTitled(`Changed ${key}`), 0);
  });

  test('keys are scoped by principal, workspace and operation', async () => {
    const key = randomUUID();
    const title = `Scoped ${key}`;
    const mine = expectStatus(await create(author, ws.id, title, key), 201) as Draft;
    const theirs = expectStatus(await create(colleague, ws.id, title, key), 201) as Draft;
    const elsewhere = expectStatus(await create(author, second.id, title, key), 201) as Draft;
    assert.equal(new Set([mine.id, theirs.id, elsewhere.id]).size, 3, 'independent scopes run independently');
    const otherOperation = await author.browser.request('POST', `/api/v1/workspaces/${ws.id}/projects`, { body: { name: title }, headers: { 'idempotency-key': key } });
    assert.equal(otherOperation.status, 201, 'another operation in the same workspace is independent');
    assert.equal(await countTitled(title), 3);
  });

  test('a retried PATCH is not executed again', async () => {
    const item = await draft(author, ws.id, 'Retried patch');
    const key = randomUUID();
    const request = () => author.browser.request('PATCH', `/api/v1/drafts/${item.id}`, { body: { body: 'edited once' }, headers: { 'if-match': '"1"', 'idempotency-key': key } });
    const first = expectStatus(await request(), 200) as Draft;
    const retry = await request();
    assert.equal(retry.status, 200, 'a re-execution would be a 409 conflict');
    assert.deepEqual(retry.json, first);
    assert.equal((await stored(item.id)).version, 2);
  });

  test('concurrent duplicates execute once', async () => {
    const key = randomUUID();
    const title = `Concurrent ${key}`;
    const results = await Promise.all([create(author, ws.id, title, key), create(author, ws.id, title, key), create(author, ws.id, title, key)]);
    assert.deepEqual(results.map((r) => r.status), [201, 201, 201]);
    assert.equal(new Set(results.map((r) => (r.json as Draft).id)).size, 1);
    assert.equal(await countTitled(title), 1);
  });

  test('a replay after losing access is denied like any invisible object and reveals nothing', async () => {
    const owner = await person('replay-owner');
    const admin = await person('replay-admin');
    const space = expectStatus(await owner.browser.request('POST', '/api/v1/workspaces', { body: { name: 'Replay' } }), 201) as Workspace;
    await addMember(owner, space.id, admin, 'admin');
    const key = randomUUID();
    const name = `Secret lamp ${key}`;
    const createProject = () => admin.browser.request('POST', `/api/v1/workspaces/${space.id}/projects`, { body: { name, visibility: 'restricted' }, headers: { 'idempotency-key': key } });
    const created = expectStatus(await createProject(), 201) as { id: string };
    const replayed = await createProject();
    assert.equal(replayed.status, 201);
    assert.equal(replayed.headers.get('idempotent-replayed'), 'true', 'replays while still authorized');

    expectStatus(await owner.browser.request('PATCH', `/api/v1/workspaces/${space.id}/members/${admin.id}`, { body: { role: 'member' } }), 200);
    expectStatus(await admin.browser.request('GET', `/api/v1/projects/${created.id}`), 404);
    const denied = await createProject();
    assert.equal(denied.status, 404, 'the replay is denied like a read of the project');
    assert.equal(denied.headers.get('idempotent-replayed'), null);
    assert.equal(denied.text.includes(created.id) || denied.text.includes(name), false, 'the stored body is not revealed');
    assert.deepEqual(denied.json, { error: 'Project not found', code: 'PROJECT_NOT_FOUND' });
    const projects = await pool.query('SELECT count(*)::int AS n FROM projects WHERE name = $1', [name]);
    assert.equal(projects.rows[0].n, 1, 'the denied replay did not create another project');
  });

  test('draft create and share replays are denied after the grant is replaced by a deny', async () => {
    const owner = await person('replay-draft-owner');
    const member = await person('replay-draft-member');
    const space = expectStatus(await owner.browser.request('POST', '/api/v1/workspaces', { body: { name: 'Replay drafts' } }), 201) as Workspace;
    await addMember(owner, space.id, member, 'member');
    const room = await project(owner, space.id, 'Replay room', 'restricted');
    await grant(owner, room.id, member, 'contributor');
    const createKey = randomUUID();
    const shareKey = randomUUID();
    const title = `Room plan ${createKey}`;
    const createDraft = () => member.browser.request('POST', `/api/v1/workspaces/${space.id}/drafts`, { body: { title, projectId: room.id }, headers: { 'idempotency-key': createKey } });
    const item = expectStatus(await createDraft(), 201) as Draft;
    const shareDraft = () => member.browser.request('POST', `/api/v1/drafts/${item.id}/share`, { body: { scope: 'project' }, headers: { 'if-match': '"1"', 'idempotency-key': shareKey } });
    expectStatus(await shareDraft(), 200);
    assert.equal((await shareDraft()).headers.get('idempotent-replayed'), 'true');

    await grant(owner, room.id, member, 'denied');
    for (const [label, replay] of [['create', createDraft], ['share', shareDraft]] as const) {
      const response = await replay();
      assert.equal(response.status, 404, `${label} replay is denied`);
      assert.equal(response.headers.get('idempotent-replayed'), null);
      assert.equal(response.text.includes(title), false, `${label} replay reveals no content`);
      assert.equal((response.json as { code: string }).code, 'DRAFT_NOT_FOUND');
    }
    assert.equal(await countTitled(title), 1);
    assert.equal((await stored(item.id)).version, 2);
  });

  test('failures are not stored, invalid keys are rejected, and expired keys are cleaned up', async () => {
    const key = randomUUID();
    const outsider = await person('idempotent-outsider');
    expectStatus(await create(outsider, ws.id, 'Denied', key), 404);
    const stored404 = await pool.query('SELECT count(*)::int AS n FROM idempotency_keys WHERE key = $1', [key]);
    assert.equal(stored404.rows[0].n, 0, 'a failed command stores nothing');
    expectStatus(await create(author, ws.id, 'Bad key', 'has spaces in it'), 400, 'invalid key');

    const expiring = randomUUID();
    const title = `Expiring ${expiring}`;
    const first = expectStatus(await create(author, ws.id, title, expiring), 201) as Draft;
    await pool.query("UPDATE idempotency_keys SET expires_at = now() - interval '1 second' WHERE key = $1", [expiring]);
    const afterExpiry = expectStatus(await create(author, ws.id, title, expiring), 201) as Draft;
    assert.notEqual(afterExpiry.id, first.id, 'an expired key no longer replays');
    const retention = await pool.query("SELECT extract(epoch FROM expires_at - created_at)::int AS seconds FROM idempotency_keys WHERE key = $1", [expiring]);
    assert.deepEqual(retention.rows, [{ seconds: 24 * 3600 }], 'the replacement is retained for 24 hours');
    await pool.query("UPDATE idempotency_keys SET expires_at = now() - interval '1 second' WHERE key = $1", [expiring]);
    assert.ok(await deleteExpiredIdempotencyKeys(idempotencyRepository(db)) >= 1);
    const left = await pool.query('SELECT count(*)::int AS n FROM idempotency_keys WHERE key = $1', [expiring]);
    assert.equal(left.rows[0].n, 0);
  });
});
