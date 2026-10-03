import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { PgBoss } from 'pg-boss';
import { loadPushSenderConfig, NotFoundError } from '@flux/core';
import type { InboxResponse } from '@flux/contracts';
import { deliverPush } from '../../apps/worker/src/push/index.js';
import { createNotifier } from '../../apps/server/src/push/adapters.js';
import { connectionString, db, pool } from './support/db.js';
import { capturingNotifier } from './support/notifier.js';
import { own, pushRecipient, recordedPushes, subscribe } from './support/push.js';

// The in-app inbox and the notification audience (issue #41), split from push.test.ts (#83):
// a notification is listed, read and pushed only while its recipient can read its source.
const boss = new PgBoss({ connectionString, migrate: false });
before(() => boss.start());
after(() => boss.stop());

const sender = loadPushSenderConfig();
const notify = createNotifier(db, boss);

describe('in-app inbox', () => {
  test('lists my notifications newest first and marks them read; others cannot', async () => {
    const me = await pushRecipient('inbox');
    const other = await pushRecipient('inbox-other');
    const older = await notify(own(me, { title: 'Older', body: 'first' }));
    await new Promise((resolve) => setTimeout(resolve, 5));
    const newer = await notify(own(me, { title: 'Newer', body: 'second', url: '/projects/p' }));
    await notify(own(other, { title: 'Not mine' }));
    await assert.rejects(notify(own(me, { title: 'x', url: '//evil.example' })), /same-origin path/);

    const inbox = (await me.browser.request('GET', '/api/v1/inbox')).json as InboxResponse;
    assert.deepEqual(inbox.items.map((item) => item.title), ['Newer', 'Older']);
    assert.equal(inbox.unread, 2);
    assert.equal(inbox.items[0]!.url, '/projects/p');

    assert.equal((await other.browser.request('POST', `/api/v1/inbox/${newer.id}/read`)).status, 404, 'cannot mark someone else\'s notification');
    assert.equal((await other.browser.request('GET', `/api/v1/inbox/${newer.id}`)).status, 404, 'cannot read someone else\'s notification');
    const direct = await me.browser.request('GET', `/api/v1/inbox/${newer.id}`);
    assert.equal(direct.status, 200);
    assert.deepEqual((direct.json as { source: unknown }).source, { workspaceId: me.workspaceId, type: 'workspace', id: me.workspaceId });
    const read = await me.browser.request('POST', `/api/v1/inbox/${newer.id}/read`);
    assert.equal(read.status, 200);
    const readAt = (read.json as { readAt: string }).readAt;
    assert.ok(readAt);
    const again = await me.browser.request('POST', `/api/v1/inbox/${newer.id}/read`);
    assert.equal((again.json as { readAt: string }).readAt, readAt, 'marking read twice keeps the first time');
    const after = (await me.browser.request('GET', '/api/v1/inbox')).json as InboxResponse;
    assert.equal(after.unread, 1);
    assert.equal(after.items.find((item) => item.id === older.id)?.readAt, null);
    const limited = (await me.browser.request('GET', '/api/v1/inbox?limit=1')).json as InboxResponse;
    assert.equal(limited.items.length, 1);
  });
});

describe('notification audience follows the source (access policy)', () => {
  async function restrictedProjectWithViewer() {
    const owner = await pushRecipient('audience-owner');
    const viewer = await pushRecipient('audience-viewer');
    const outsider = await pushRecipient('audience-outsider');
    const added = await owner.browser.request('POST', `/api/v1/workspaces/${owner.workspaceId}/members`, { body: { email: viewer.email, role: 'member' } });
    assert.equal(added.status, 201, added.text);
    const project = await owner.browser.request('POST', `/api/v1/workspaces/${owner.workspaceId}/projects`, { body: { name: 'Board pack', visibility: 'restricted' } });
    assert.equal(project.status, 201, project.text);
    const projectId = (project.json as { id: string }).id;
    const grant = await owner.browser.request('POST', `/api/v1/projects/${projectId}/grants`, { body: { principal: { kind: 'human', id: viewer.userId }, role: 'viewer' } });
    assert.equal(grant.status, 201, grant.text);
    return { owner, viewer, outsider, projectId, grantId: (grant.json as { id: string }).id };
  }

  test('a notification needs a source the recipient can read now', async () => {
    const { outsider, projectId, owner } = await restrictedProjectWithViewer();
    await assert.rejects(notify({ userId: outsider.userId, source: { type: 'project', id: projectId }, title: 'Board pack updated' }),
      (error: unknown) => error instanceof NotFoundError && error.code === 'SOURCE_NOT_FOUND');
    await assert.rejects(notify({ userId: outsider.userId, source: { type: 'workspace', id: owner.workspaceId }, title: 'x' }), NotFoundError);
    await assert.rejects(notify({ userId: outsider.userId, source: { type: 'nope' as 'project', id: projectId }, title: 'x' }), /source must name/);
    const stored = await pool.query('SELECT 1 FROM notifications WHERE user_id = $1', [outsider.userId]);
    assert.equal(stored.rowCount, 0, 'nothing is stored for an unreadable source');
  });

  test('grant revoked after the push was queued: no push is sent and the inbox hides it (404 by id)', async () => {
    const { owner, viewer, outsider, projectId, grantId } = await restrictedProjectWithViewer();
    const { subscription } = await subscribe(viewer.browser);
    const captured = capturingNotifier();
    const created = await captured.notify({ userId: viewer.userId, source: { type: 'project', id: projectId }, title: 'Q3 numbers are in', body: 'Revenue 4.2M', url: `/projects/${projectId}` });
    assert.equal(captured.jobs.length, 1, 'one job queued for the viewer\'s device');
    const before = (await viewer.browser.request('GET', '/api/v1/inbox')).json as InboxResponse;
    assert.deepEqual(before.items.map((item) => item.id), [created.id]);
    assert.equal(before.unread, 1);
    assert.equal((await viewer.browser.request('GET', `/api/v1/inbox/${created.id}`)).status, 200);

    const revoked = await owner.browser.request('DELETE', `/api/v1/projects/${projectId}/grants/${grantId}`);
    assert.equal(revoked.status, 204, revoked.text);

    assert.deepEqual(await deliverPush({ db, config: sender }, captured.jobs[0]!), { outcome: 'skipped', reason: 'recipient can no longer see the notification source' });
    assert.equal((await recordedPushes(subscription.mockId)).length, 0, 'nothing reached the device');
    const after = (await viewer.browser.request('GET', '/api/v1/inbox')).json as InboxResponse;
    assert.deepEqual(after, { items: [], unread: 0 }, 'not listed and not counted');
    assert.equal((await viewer.browser.request('GET', `/api/v1/inbox/${created.id}`)).status, 404);
    assert.equal((await viewer.browser.request('POST', `/api/v1/inbox/${created.id}/read`)).status, 404);
    assert.equal((await outsider.browser.request('GET', `/api/v1/inbox/${created.id}`)).status, 404, 'another user still gets 404');
    assert.equal((await owner.browser.request('GET', `/api/v1/inbox/${created.id}`)).status, 404, 'even a manager cannot read someone else\'s inbox');

    // Access restored: the row is visible again (it was never shown to anyone else).
    const regrant = await owner.browser.request('POST', `/api/v1/projects/${projectId}/grants`, { body: { principal: { kind: 'human', id: viewer.userId }, role: 'viewer' } });
    assert.equal(regrant.status, 201);
    assert.equal((await viewer.browser.request('GET', `/api/v1/inbox/${created.id}`)).status, 200);
  });

  test('a draft source follows draft visibility; a denied grant hides project notifications', async () => {
    const { owner, viewer, projectId } = await restrictedProjectWithViewer();
    const draft = await owner.browser.request('POST', `/api/v1/workspaces/${owner.workspaceId}/drafts`, { body: { title: 'Minutes', projectId } });
    assert.equal(draft.status, 201, draft.text);
    const { id: draftId, version } = draft.json as { id: string; version: number };
    await assert.rejects(notify({ userId: viewer.userId, source: { type: 'draft', id: draftId }, title: 'Minutes drafted' }), NotFoundError, 'a private draft is not readable by the viewer');
    assert.equal((await owner.browser.request('POST', `/api/v1/drafts/${draftId}/share`, { body: { scope: 'project', projectId }, headers: { 'if-match': `"${version}"` } })).status, 200);
    const aboutDraft = await notify({ userId: viewer.userId, source: { type: 'draft', id: draftId }, title: 'Minutes shared' });
    const aboutProject = await notify({ userId: viewer.userId, source: { type: 'project', id: projectId }, title: 'Board pack' });
    const ownWorkspace = await notify(own(viewer, { title: 'Own space' }));
    const listed = (await viewer.browser.request('GET', '/api/v1/inbox')).json as InboxResponse;
    assert.deepEqual(new Set(listed.items.map((item) => item.id)), new Set([aboutDraft.id, aboutProject.id, ownWorkspace.id]));

    const denied = await owner.browser.request('POST', `/api/v1/projects/${projectId}/grants`, { body: { principal: { kind: 'human', id: viewer.userId }, role: 'denied' } });
    assert.equal(denied.status, 201, denied.text);
    const after = (await viewer.browser.request('GET', '/api/v1/inbox')).json as InboxResponse;
    assert.deepEqual(after.items.map((item) => item.id), [ownWorkspace.id], 'explicit deny hides both project and draft notifications');
    assert.equal(after.unread, 1);
    assert.equal((await viewer.browser.request('GET', `/api/v1/inbox/${aboutDraft.id}`)).status, 404);
  });

  test('removal from the workspace hides every notification from that workspace', async () => {
    const { owner, viewer, projectId } = await restrictedProjectWithViewer();
    const created = await notify({ userId: viewer.userId, source: { type: 'workspace', id: owner.workspaceId }, title: 'Welcome to the space' });
    await notify({ userId: viewer.userId, source: { type: 'project', id: projectId }, title: 'Board pack' });
    const removed = await owner.browser.request('DELETE', `/api/v1/workspaces/${owner.workspaceId}/members/${viewer.userId}`);
    assert.equal(removed.status, 204, removed.text);
    assert.deepEqual((await viewer.browser.request('GET', '/api/v1/inbox')).json, { items: [], unread: 0 });
    assert.equal((await viewer.browser.request('GET', `/api/v1/inbox/${created.id}`)).status, 404);
  });
});
