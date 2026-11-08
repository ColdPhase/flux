import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { before, describe, test } from 'node:test';
import type { Sketch, VersionConflict, Workspace } from '@flux/contracts';
import { idempotencyRepository } from '@flux/db';
import { deleteExpiredIdempotencyKeys } from '@flux/core';
import { db, pool } from './support/db.js';
import { addMember, expectStatus, grant, person, project, type Person } from './support/people.js';

// If-Match preconditions and idempotency keys over HTTP (issue #29, AC-4). The versioned object is a map in a space.

async function stored(sketchId: string) {
  const result = await pool.query('SELECT title, scope, project_id, version FROM sketches WHERE id = $1', [sketchId]);
  return result.rows[0];
}

const rename = (actor: Person, sketchId: string, body: Record<string, unknown>, headers: Record<string, string> = {}) =>
  actor.browser.request('PATCH', `/api/v1/sketches/${sketchId}`, { body, headers });

describe('If-Match preconditions', () => {
  let author: Person;
  let stranger: Person;
  let ws: Workspace;
  let room: string;

  /** A map in the space: the versioned object these tests write. */
  const mapIn = async (title: string) =>
    expectStatus(await author.browser.request('POST', `/api/v1/workspaces/${ws.id}/sketches`, { body: { title, scope: 'project', projectId: room } }), 201) as Sketch;

  before(async () => {
    [author, stranger] = await Promise.all(['precondition-author', 'precondition-stranger'].map(person));
    ws = expectStatus(await author.browser.request('POST', '/api/v1/workspaces', { body: { name: 'Preconditions' } }), 201) as Workspace;
    room = (await project(author, ws.id, 'Room', 'restricted')).id;
  });

  test('map responses carry the version as ETag', async () => {
    const created = await author.browser.request('POST', `/api/v1/workspaces/${ws.id}/sketches`, { body: { title: 'Tagged', scope: 'project', projectId: room } });
    assert.equal(created.status, 201);
    assert.equal(created.headers.get('etag'), '"1"');
    const read = await author.browser.request('GET', `/api/v1/sketches/${(created.json as Sketch).id}`);
    assert.equal(read.headers.get('etag'), '"1"');
  });

  test('a missing precondition is 428 and a stale one is 409 with the latest version; neither writes', async () => {
    const item = await mapIn('Plan');
    const missing = expectStatus(await rename(author, item.id, { title: 'no precondition' }), 428) as { code: string };
    assert.equal(missing.code, 'PRECONDITION_REQUIRED');
    assert.equal((await stored(item.id)).title, 'Plan');

    const updated = await rename(author, item.id, { title: 'second' }, { 'if-match': '"1"' });
    assert.equal(updated.status, 200);
    assert.equal((updated.json as Sketch).version, 2);
    assert.equal(updated.headers.get('etag'), '"2"');

    const stale = expectStatus(await rename(author, item.id, { title: 'lost update' }, { 'if-match': '"1"' }), 409) as VersionConflict<Sketch>;
    assert.equal(stale.code, 'VERSION_CONFLICT');
    assert.equal(stale.currentVersion, 2);
    assert.equal(stale.current.title, 'second', 'conflict returns the latest authorized object');
    assert.deepEqual(await stored(item.id), { title: 'second', scope: 'project', project_id: room, version: 2 }, 'stale write did not overwrite');

    const viaBody = expectStatus(await rename(author, item.id, { title: 'third', expectedVersion: 2 }), 200) as Sketch;
    assert.equal(viaBody.version, 3);
    expectStatus(await rename(author, item.id, { title: 'x', expectedVersion: 3 }, { 'if-match': '"2"' }), 400, 'header and body disagree');
    expectStatus(await rename(author, item.id, { title: 'x' }, { 'if-match': '*' }), 400, 'wildcard is not a version');
  });

  test('authorization is decided before the precondition, so nothing leaks', async () => {
    const item = await mapIn('Hidden');
    expectStatus(await rename(stranger, item.id, { title: 'x' }), 404, 'no precondition, invisible');
    expectStatus(await rename(stranger, item.id, { title: 'x' }, { 'if-match': '"9"' }), 404, 'stale precondition, invisible');
  });
});

describe('idempotency keys', () => {
  let author: Person;
  let colleague: Person;
  let ws: Workspace;
  let second: Workspace;
  let room: string;
  let secondRoom: string;

  before(async () => {
    [author, colleague] = await Promise.all(['idempotent-author', 'idempotent-colleague'].map(person));
    ws = expectStatus(await author.browser.request('POST', '/api/v1/workspaces', { body: { name: 'Idempotent' } }), 201) as Workspace;
    second = expectStatus(await author.browser.request('POST', '/api/v1/workspaces', { body: { name: 'Idempotent two' } }), 201) as Workspace;
    await addMember(author, ws.id, colleague, 'member');
    room = (await project(author, ws.id, 'Room', 'workspace')).id;
    secondRoom = (await project(author, second.id, 'Room', 'workspace')).id;
  });

  const create = (who: Person, workspaceId: string, title: string, key: string, projectId = workspaceId === ws.id ? room : secondRoom) =>
    who.browser.request('POST', `/api/v1/workspaces/${workspaceId}/sketches`, { body: { title, scope: 'project', projectId }, headers: { 'idempotency-key': key } });
  const countTitled = async (title: string) => (await pool.query('SELECT count(*)::int AS n FROM sketches WHERE title = $1', [title])).rows[0].n as number;

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
    const events = await pool.query("SELECT count(*)::int AS n FROM events WHERE object_id = $1 AND kind = 'sketch.created.v1'", [(first.json as Sketch).id]);
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
    const mine = expectStatus(await create(author, ws.id, title, key), 201) as Sketch;
    const theirs = expectStatus(await create(colleague, ws.id, title, key), 201) as Sketch;
    const elsewhere = expectStatus(await create(author, second.id, title, key), 201) as Sketch;
    assert.equal(new Set([mine.id, theirs.id, elsewhere.id]).size, 3, 'independent scopes run independently');
    const otherOperation = await author.browser.request('POST', `/api/v1/workspaces/${ws.id}/projects`, { body: { name: title }, headers: { 'idempotency-key': key } });
    assert.equal(otherOperation.status, 201, 'another operation in the same workspace is independent');
    assert.equal(await countTitled(title), 3);
  });

  test('a retried PATCH is not executed again', async () => {
    const item = expectStatus(await create(author, ws.id, 'Retried patch', randomUUID()), 201) as Sketch;
    const key = randomUUID();
    const request = () => rename(author, item.id, { title: 'edited once' }, { 'if-match': '"1"', 'idempotency-key': key });
    const first = expectStatus(await request(), 200) as Sketch;
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
    assert.equal(new Set(results.map((r) => (r.json as Sketch).id)).size, 1);
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
    // F-037: the creator is the new space's admin by its own grant; the owner removes them from the space as well.
    const grants = expectStatus(await owner.browser.request('GET', `/api/v1/projects/${created.id}/grants`), 200) as { id: string; principal: { id: string } }[];
    // A space always keeps an admin (C-16): the owner becomes one too, so the creator's own grant can go.
    await grant(owner, created.id, owner, 'manager');
    const own = grants.find((item) => item.principal.id === admin.id)!;
    expectStatus(await owner.browser.request('DELETE', `/api/v1/projects/${created.id}/grants/${own.id}`), 204);
    expectStatus(await admin.browser.request('GET', `/api/v1/projects/${created.id}`), 404);
    const denied = await createProject();
    assert.equal(denied.status, 404, 'the replay is denied like a read of the project');
    assert.equal(denied.headers.get('idempotent-replayed'), null);
    assert.equal(denied.text.includes(created.id) || denied.text.includes(name), false, 'the stored body is not revealed');
    assert.deepEqual(denied.json, { error: 'Space not found', code: 'PROJECT_NOT_FOUND' });
    const projects = await pool.query('SELECT count(*)::int AS n FROM projects WHERE name = $1', [name]);
    assert.equal(projects.rows[0].n, 1, 'the denied replay did not create another project');
  });

  test('map create and rename replays are denied after the author is removed from the company', async () => {
    const owner = await person('replay-map-owner');
    const member = await person('replay-map-member');
    const space = expectStatus(await owner.browser.request('POST', '/api/v1/workspaces', { body: { name: 'Replay maps' } }), 201) as Workspace;
    await addMember(owner, space.id, member, 'member');
    const room = await project(owner, space.id, 'Replay room', 'restricted');
    await grant(owner, room.id, member, 'contributor');
    const createKey = randomUUID();
    const renameKey = randomUUID();
    const title = `Room plan ${createKey}`;
    const createMap = () => create(member, space.id, title, createKey, room.id);
    const item = expectStatus(await createMap(), 201) as Sketch;
    const renameMap = () => rename(member, item.id, { title: `${title} v2` }, { 'if-match': '"1"', 'idempotency-key': renameKey });
    expectStatus(await renameMap(), 200);
    assert.equal((await renameMap()).headers.get('idempotent-replayed'), 'true');

    expectStatus(await owner.browser.request('DELETE', `/api/v1/workspaces/${space.id}/members/${member.id}`), 204);
    for (const [label, replay] of [['create', createMap], ['rename', renameMap]] as const) {
      const response = await replay();
      assert.equal(response.status, 404, `${label} replay is denied`);
      assert.equal(response.headers.get('idempotent-replayed'), null);
      assert.equal(response.text.includes(title), false, `${label} replay reveals no content`);
      assert.match((response.json as { code: string }).code, /_NOT_FOUND$/, `${label} replay answers as for a missing object`);
    }
    assert.equal(await countTitled(title), 0, 'the original title was renamed once, and the denied replays made nothing');
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
    const first = expectStatus(await create(author, ws.id, title, expiring), 201) as Sketch;
    await pool.query("UPDATE idempotency_keys SET expires_at = now() - interval '1 second' WHERE key = $1", [expiring]);
    const afterExpiry = expectStatus(await create(author, ws.id, title, expiring), 201) as Sketch;
    assert.notEqual(afterExpiry.id, first.id, 'an expired key no longer replays');
    const retention = await pool.query("SELECT extract(epoch FROM expires_at - created_at)::int AS seconds FROM idempotency_keys WHERE key = $1", [expiring]);
    assert.deepEqual(retention.rows, [{ seconds: 24 * 3600 }], 'the replacement is retained for 24 hours');
    await pool.query("UPDATE idempotency_keys SET expires_at = now() - interval '1 second' WHERE key = $1", [expiring]);
    assert.ok(await deleteExpiredIdempotencyKeys(idempotencyRepository(db)) >= 1);
    const left = await pool.query('SELECT count(*)::int AS n FROM idempotency_keys WHERE key = $1', [expiring]);
    assert.equal(left.rows[0].n, 0);
  });
});
