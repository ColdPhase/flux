import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { createDatabase } from '@flux/db';
import type { Conversation, ConversationMessage, ConversationRootWindow, Material, Project, Workspace } from '@flux/contracts';
import { Browser, register, uniqueEmail, type ClientResponse } from './support/http.js';

// One project conversation (UI116-1, 2026-10-02): the stream of roots, their reply counts and the
// cursor window, read under current project access only.

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required');
const { pool } = createDatabase(connectionString);
after(() => pool.end());
const password = 'correct horse battery staple';

interface Person { id: string; email: string; browser: Browser }
async function person(label: string): Promise<Person> {
  const email = uniqueEmail(label);
  const { browser } = await register(email, password, label);
  const me = await browser.request('GET', '/api/v1/me');
  assert.equal(me.status, 200);
  return { id: (me.json as { user: { id: string } }).user.id, email, browser };
}
function expect(response: ClientResponse, status: number, label = 'request') {
  assert.equal(response.status, status, `${label}: ${response.text}`);
  return response.json;
}

describe('project conversation roots', () => {
  let owner: Person;
  let partner: Person;
  let reader: Person;
  let outsider: Person;
  let ws: Workspace;
  let project: Project;
  const roots = (who: Person, query = '', projectId = project.id) => who.browser.request('GET', `/api/v1/projects/${projectId}/conversation-roots${query}`);
  const start = async (who: Person, body: string, extra: Record<string, unknown> = {}) =>
    expect(await who.browser.request('POST', `/api/v1/projects/${project.id}/conversations`, { body: { body, clientMessageId: randomUUID(), ...extra } }), 201) as Conversation;
  const reply = async (who: Person, conversationId: string, body: string) =>
    expect(await who.browser.request('POST', `/api/v1/conversations/${conversationId}/messages`, { body: { body, clientMessageId: randomUUID() } }), 201) as ConversationMessage;

  before(async () => {
    [owner, partner, reader, outsider] = await Promise.all(['roots-owner', 'roots-partner', 'roots-reader', 'roots-outsider'].map(person));
    ws = expect(await owner.browser.request('POST', '/api/v1/workspaces', { body: { name: 'Stream lab' } }), 201) as Workspace;
    for (const member of [partner, reader]) {
      expect(await owner.browser.request('POST', `/api/v1/workspaces/${ws.id}/members`, { body: { email: member.email, role: 'member' } }), 201);
    }
    project = expect(await owner.browser.request('POST', `/api/v1/workspaces/${ws.id}/projects`,
      { body: { name: 'Night lamp', visibility: 'restricted' } }), 201) as Project;
    expect(await owner.browser.request('POST', `/api/v1/projects/${project.id}/grants`,
      { body: { principal: { kind: 'human', id: partner.id }, role: 'contributor' } }), 201);
    expect(await owner.browser.request('POST', `/api/v1/projects/${project.id}/grants`,
      { body: { principal: { kind: 'human', id: reader.id }, role: 'viewer' } }), 201);
  });

  test('an empty project has an empty stream', async () => {
    const empty = expect(await roots(owner), 200) as ConversationRootWindow;
    assert.deepEqual(empty, { projectId: project.id, roots: [], rootPage: { hasMoreBefore: false, nextBefore: null, limit: 50 } });
  });

  test('roots from several people come oldest first with their thread sizes, and a retried start adds no root', async () => {
    const material = expect(await partner.browser.request('POST', `/api/v1/projects/${project.id}/materials`,
      { body: { clientMutationId: randomUUID(), title: 'Lux table', body: '38% at 5 lux' } }), 201) as Material;
    const first = await start(owner, 'Should the lamp react to gestures in the dark?');
    const key = randomUUID();
    const command = { body: 'Camera numbers are in the lux table', clientMessageId: key, source: { materialId: material.materialId, version: 1 } };
    const second = expect(await partner.browser.request('POST', `/api/v1/projects/${project.id}/conversations`, { body: command }), 201) as Conversation;
    expect(await partner.browser.request('POST', `/api/v1/projects/${project.id}/conversations`, { body: command }), 201, 'retry of the same start');
    await reply(partner, first.id, 'Above 50 lux it catches almost every wave');
    await reply(owner, first.id, 'Then the camera cannot be the only sensor');
    const last = await reply(partner, first.id, 'ToF works in the dark');
    await Promise.all(Array.from({ length: 3 }, (_, index) => reply(owner, second.id, `note ${index}`)));

    for (const who of [owner, partner, reader]) {
      const window = expect(await roots(who), 200) as ConversationRootWindow;
      assert.deepEqual(window.roots.map((root) => root.conversationId), [first.id, second.id], 'chronological, one root per conversation');
      assert.deepEqual(window.roots.map((root) => root.message.sequence), [1, 1]);
      assert.deepEqual(window.roots.map((root) => root.message.body), ['Should the lamp react to gestures in the dark?', 'Camera numbers are in the lux table']);
      assert.deepEqual(window.roots.map((root) => root.message.authorId), [owner.id, partner.id]);
      assert.deepEqual(window.roots.map((root) => root.replyCount), [3, 3], 'replies exclude the root');
      assert.equal(window.roots[0]!.lastReplyAt, last.createdAt);
      assert.equal(window.roots[0]!.message.id, first.messages[0]!.id);
      assert.deepEqual(window.roots[1]!.message.source, { materialId: material.materialId, version: 1 });
      assert.deepEqual(window.rootPage, { hasMoreBefore: false, nextBefore: null, limit: 50 });
    }
    const third = await start(partner, 'A root without replies yet');
    const latest = expect(await roots(owner), 200) as ConversationRootWindow;
    assert.equal(latest.roots.at(-1)!.conversationId, third.id);
    assert.equal(latest.roots.at(-1)!.replyCount, 0);
    assert.equal(latest.roots.at(-1)!.lastReplyAt, null);
  });

  test('the cursor window is stable while new roots arrive and reaches every root', async () => {
    const created: string[] = [];
    for (let index = 0; index < 5; index += 1) created.push((await start(owner, `Window root ${index}`)).id);
    const all = (expect(await roots(owner, '?limit=100'), 200) as ConversationRootWindow).roots.map((root) => root.conversationId);
    assert.deepEqual(all.slice(-5), created);

    const newest = expect(await roots(owner, '?limit=2'), 200) as ConversationRootWindow;
    assert.deepEqual(newest.roots.map((root) => root.conversationId), created.slice(-2));
    assert.deepEqual(newest.rootPage, { hasMoreBefore: true, nextBefore: created[3], limit: 2 });
    // A root started between two reads never shifts or repeats the older pages.
    await start(partner, 'Arrives while someone reads earlier roots');
    const seen = [...newest.roots.map((root) => root.conversationId)];
    let cursor: string | null = newest.rootPage.nextBefore;
    while (cursor) {
      const page = expect(await roots(reader, `?limit=2&before=${cursor}`), 200) as ConversationRootWindow;
      seen.unshift(...page.roots.map((root) => root.conversationId));
      cursor = page.rootPage.nextBefore;
      assert.equal(page.rootPage.hasMoreBefore, cursor !== null);
    }
    assert.deepEqual(seen, all, 'every root exactly once, in order');
    const stored = await pool.query('SELECT count(*)::int AS count FROM project_conversations WHERE project_id = $1', [project.id]);
    assert.equal(seen.length, stored.rows[0].count - 1, 'all but the root that arrived after the first read');
  });

  test('bad windows are refused and another project never leaks through the cursor', async () => {
    for (const query of ['?limit=0', '?limit=101', '?limit=two', '?before=not-a-uuid', `?before=${randomUUID()}`]) {
      expect(await roots(owner, query), 400, query);
    }
    const other = expect(await owner.browser.request('POST', `/api/v1/workspaces/${ws.id}/projects`,
      { body: { name: 'Other lamp', visibility: 'restricted' } }), 201) as Project;
    const foreign = expect(await owner.browser.request('POST', `/api/v1/projects/${other.id}/conversations`,
      { body: { body: 'Private to the other project', clientMessageId: randomUUID() } }), 201) as Conversation;
    expect(await roots(owner, `?before=${foreign.id}`), 400, 'a cursor from another project');
    const mine = expect(await roots(owner, '?limit=100'), 200) as ConversationRootWindow;
    assert.equal(mine.roots.some((root) => root.conversationId === foreign.id), false);
    expect(await roots(partner, '', other.id), 404, 'a project without access');
  });

  test('outsiders, revoked and denied people read nothing', async () => {
    expect(await roots(outsider), 404, 'outsider');
    expect(await outsider.browser.request('GET', `/api/v1/projects/${project.id}/conversation-roots?limit=1`), 404);
    expect(await reader.browser.request('POST', `/api/v1/projects/${project.id}/conversations`,
      { body: { body: 'A reader cannot start a root', clientMessageId: randomUUID() } }), 403);
    expect(await owner.browser.request('POST', `/api/v1/projects/${project.id}/grants`,
      { body: { principal: { kind: 'human', id: reader.id }, role: 'denied' } }), 201);
    expect(await roots(reader), 404, 'denied');
    const grants = expect(await owner.browser.request('GET', `/api/v1/projects/${project.id}/grants`), 200) as { id: string; principal: { id: string } }[];
    const partnerGrant = grants.find((grant) => grant.principal.id === partner.id);
    assert.ok(partnerGrant);
    expect(await owner.browser.request('DELETE', `/api/v1/projects/${project.id}/grants/${partnerGrant.id}`), 204);
    expect(await roots(partner), 404, 'revoked');
    expect(await roots(owner), 200, 'the owner still reads');
  });
});
