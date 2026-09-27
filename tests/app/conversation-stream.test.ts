import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, test } from 'node:test';
import { createDatabase } from '@flux/db';
import type { Conversation, Material, Project, Workspace } from '@flux/contracts';
import { Browser, register, uniqueEmail } from './support/http.js';
import { StreamClient } from './support/stream.js';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required');
const { pool } = createDatabase(connectionString);
after(() => pool.end());
const password = 'correct horse battery staple';

async function person(label: string) {
  const { browser } = await register(uniqueEmail(label), password, label);
  const me = await browser.request('GET', '/api/v1/me');
  assert.equal(me.status, 200, me.text);
  return { browser, id: (me.json as { user: { id: string } }).user.id };
}
async function post<T>(browser: Browser, path: string, body: unknown): Promise<T> {
  const response = await browser.request('POST', path, { body });
  assert.equal(response.status, 201, response.text);
  return response.json as T;
}

const kinds = [
  'project.conversation_created.v1',
  'project.message_sent.v1',
  'project.material_created.v1',
  'project.material_updated.v1',
];

test('conversation and material commits reach only current project readers through stream and replay', async () => {
  const [owner, partner, outsider] = await Promise.all(['stream-capture-owner', 'stream-capture-partner', 'stream-capture-outsider'].map(person));
  const ws = await post<Workspace>(owner.browser, '/api/v1/workspaces', { name: 'Shared workshop' });
  for (const account of [partner, outsider]) {
    const response = await owner.browser.request('POST', `/api/v1/workspaces/${ws.id}/members`, { body: { userId: account.id, role: 'member' } });
    assert.equal(response.status, 201, response.text);
  }
  const project = await post<Project>(owner.browser, `/api/v1/workspaces/${ws.id}/projects`, { name: 'Sensor idea', visibility: 'restricted' });
  await post(owner.browser, `/api/v1/projects/${project.id}/grants`, { principal: { kind: 'human', id: partner.id }, role: 'contributor' });
  const [ownerLive, partnerLive, outsiderLive] = await Promise.all([owner, partner, outsider].map(({ browser }) => StreamClient.connect(browser)));
  try {
    const [ownerReady, partnerReady, outsiderReady] = await Promise.all([ownerLive.ready(), partnerLive.ready(), outsiderLive.ready()]);
    const openingKey = randomUUID();
    const openingCommand = { body: 'Could a PIR sensor work?', clientMessageId: openingKey };
    const thread = await post<Conversation>(owner.browser, `/api/v1/projects/${project.id}/conversations`, openingCommand);
    await Promise.all([ownerLive.event(project.id, kinds[0]), partnerLive.event(project.id, kinds[0])]);
    const replyKey = randomUUID();
    const replyCommand = { body: 'Test it in low light', clientMessageId: replyKey };
    const reply = await post<{ id: string }>(partner.browser, `/api/v1/conversations/${thread.id}/messages`, replyCommand);
    await Promise.all([ownerLive.event(project.id, kinds[1]), partnerLive.event(project.id, kinds[1])]);
    const privateDraft = await post<{ id: string; version: number }>(owner.browser, `/api/v1/workspaces/${ws.id}/drafts`,
      { title: 'private address', body: 'home address 123; redact this before sharing' });
    const createKey = randomUUID();
    const createCommand = { clientMutationId: createKey, title: 'Sensor options', body: 'PIR works without images', sourceDraftId: privateDraft.id, sourceDraftVersion: privateDraft.version };
    const material = await post<Material>(owner.browser, `/api/v1/projects/${project.id}/materials`, createCommand);
    await Promise.all([ownerLive.event(project.id, kinds[2]), partnerLive.event(project.id, kinds[2])]);
    const editKey = randomUUID();
    const editCommand = { clientMutationId: editKey, expectedVersion: 1, body: 'PIR works, camera failed in low light' };
    const edited = await owner.browser.request('PATCH', `/api/v1/materials/${material.materialId}`, { body: editCommand });
    assert.equal(edited.status, 200, edited.text);
    await Promise.all([ownerLive.event(project.id, kinds[3]), partnerLive.event(project.id, kinds[3])]);

    const rows = await pool.query('SELECT id, kind, workspace_id, object_id, data FROM events WHERE object_id = $1 AND kind = ANY($2) ORDER BY seq', [project.id, kinds]);
    assert.deepEqual(rows.rows.map((row) => row.kind), kinds);
    for (const row of rows.rows) {
      assert.equal(row.workspace_id, ws.id);
      assert.equal(row.object_id, project.id);
      assert.deepEqual(row.data, {}, 'event storage has no content or private draft provenance');
    }
    const audience = await pool.query('SELECT DISTINCT recipient FROM event_audience WHERE event_id = ANY($1)', [rows.rows.map((row) => row.id)]);
    assert.deepEqual(audience.rows.map((row) => row.recipient).sort(), [`human:${owner.id}`, `human:${partner.id}`].sort());
    assert.deepEqual(ownerLive.events.filter((event) => kinds.includes(event.kind)).map((event) => event.kind), kinds);
    assert.deepEqual(partnerLive.events.filter((event) => kinds.includes(event.kind)).map((event) => event.kind), kinds);
    assert.equal(outsiderLive.events.some((event) => event.objectId === project.id), false);
    const outsiderFresh = await StreamClient.connect(outsider.browser);
    try { assert.equal((await outsiderFresh.ready()).cursor, outsiderReady.cursor, 'restricted work does not change an outsider cursor'); }
    finally { await outsiderFresh.close(); }

    // Repeating the exact client command is an authorized read of its original result,
    // not a second write or stream event. A changed key payload must fail closed.
    assert.equal((await post<Conversation>(owner.browser, `/api/v1/projects/${project.id}/conversations`, openingCommand)).id, thread.id);
    assert.equal((await post<{ id: string }>(partner.browser, `/api/v1/conversations/${thread.id}/messages`, replyCommand)).id, reply.id);
    assert.equal((await post<Material>(owner.browser, `/api/v1/projects/${project.id}/materials`, createCommand)).materialId, material.materialId);
    assert.equal((await owner.browser.request('PATCH', `/api/v1/materials/${material.materialId}`, { body: editCommand })).status, 200);
    assert.equal((await owner.browser.request('POST', `/api/v1/conversations/${thread.id}/messages`, { body: { ...openingCommand, body: 'different' } })).status, 409);
    assert.equal((await owner.browser.request('PATCH', `/api/v1/materials/${material.materialId}`, { body: { ...editCommand, body: 'different' } })).status, 409);
    assert.equal((await owner.browser.request('PATCH', `/api/v1/materials/${material.materialId}`, { body: { clientMutationId: randomUUID(), expectedVersion: 1, body: 'stale' } })).status, 409);
    assert.equal((await owner.browser.request('POST', `/api/v1/conversations/${thread.id}/messages`, { body: { body: 'bad source', clientMessageId: randomUUID(), source: { materialId: randomUUID(), version: 1 } } })).status, 404);
    const laterRows = await pool.query('SELECT count(*)::int AS count FROM events WHERE object_id = $1 AND kind = ANY($2)', [project.id, kinds]);
    assert.equal(laterRows.rows[0].count, 4, 'retries and conflicts create no events');

    const ownerReplay = await StreamClient.connect(owner.browser, { cursor: ownerReady.cursor });
    const partnerReplay = await StreamClient.connect(partner.browser, { cursor: partnerReady.cursor });
    try {
      await Promise.all([ownerReplay.ready(), partnerReplay.ready()]);
      for (const stream of [ownerReplay, partnerReplay]) {
        const delivered = stream.events.filter((event) => kinds.includes(event.kind));
        assert.deepEqual(delivered.map((event) => event.kind), kinds);
        assert.ok(delivered.every((event) => event.objectType === 'project' && event.objectId === project.id && event.workspaceId === ws.id));
        assert.ok(delivered.every((event) => !JSON.stringify(event).includes('home address 123') && !JSON.stringify(event).includes(privateDraft.id)));
      }
    } finally { await ownerReplay.close(); await partnerReplay.close(); }

    const grants = await owner.browser.request('GET', `/api/v1/projects/${project.id}/grants`);
    assert.equal(grants.status, 200);
    const partnerGrant = (grants.json as { id: string; principal: { id: string } }[]).find((grant) => grant.principal.id === partner.id)!;
    assert.equal((await owner.browser.request('DELETE', `/api/v1/projects/${project.id}/grants/${partnerGrant.id}`)).status, 204);
    const revokedReplay = await StreamClient.connect(partner.browser, { cursor: partnerReady.cursor });
    try {
      await revokedReplay.ready();
      assert.equal(revokedReplay.events.some((event) => event.objectId === project.id), false, 'replay rechecks current access');
    } finally { await revokedReplay.close(); }
    assert.equal((await partner.browser.request('GET', `/api/v1/conversations/${thread.id}`)).status, 404);
    await post(owner.browser, `/api/v1/conversations/${thread.id}/messages`, { body: 'After revocation', clientMessageId: randomUUID() });
    await ownerLive.until(() => ownerLive.events.filter((event) => event.kind === 'project.message_sent.v1').length === 2, 8000, 'second reply event for owner');
    const deniedAudience = await pool.query('SELECT recipient FROM event_audience WHERE event_id = (SELECT id FROM events WHERE object_id = $1 AND kind = $2 ORDER BY seq DESC LIMIT 1)', [project.id, 'project.message_sent.v1']);
    assert.deepEqual(deniedAudience.rows.map((row) => row.recipient), [`human:${owner.id}`]);
    assert.equal(partnerLive.events.filter((event) => event.kind === 'project.message_sent.v1').length, 1, 'revoked live stream receives no new reply event');
  } finally { await Promise.all([ownerLive.close(), partnerLive.close(), outsiderLive.close()]); }
});
