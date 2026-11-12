import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { before, describe, test } from 'node:test';
import {
  orderSpaces, READ_ALL_PATH, READ_ALL_UNDO_PATH, SPACE_ORDER_CHANGED_EVENT, SPACE_ORDER_PATH,
  type Conversation, type NeedsYouResponse, type Project, type ReadAllResult, type ReturnSummary, type SpaceOrder,
} from '@flux/contracts';
import { personalRunRows } from '@flux/db';
import { db, pool } from './support/db.js';
import { addMember, expectStatus, grant, person, project as createProject, removeFromSpace, type Person } from './support/people.js';
import { StreamClient } from './support/stream.js';

// The sidebar's own state (#1250, v0.2.1): the order of a person's Spaces list is theirs alone and is kept on the server, so it is the same
// on every device and in every tab; Everyone is always first and never stored; a new space goes to the end. "Mark all as read" moves every
// space's return point and reads the chats of the person's agents, leaves what needs an action in the Inbox, and Undo puts back exactly that.

const post = (someone: Person, path: string, body?: unknown) => someone.browser.request('POST', path, body === undefined ? {} : { body });
const orderOf = async (someone: Person) => (expectStatus(await someone.browser.request('GET', SPACE_ORDER_PATH), 200) as SpaceOrder).order;
const save = async (someone: Person, order: unknown[]) => expectStatus(await someone.browser.request('PUT', SPACE_ORDER_PATH, { body: { order } }), 200) as SpaceOrder;
const summary = async (someone: Person, projectId: string) =>
  expectStatus(await someone.browser.request('GET', `/api/v1/return?place=project&id=${projectId}`), 200) as ReturnSummary;
const say = async (someone: Person, conversationId: string, body: string) =>
  expectStatus(await post(someone, `/api/v1/conversations/${conversationId}/messages`, { body, clientMessageId: randomUUID() }), 201);
const start = async (someone: Person, projectId: string, body: string) =>
  expectStatus(await post(someone, `/api/v1/projects/${projectId}/conversations`, { body, clientMessageId: randomUUID() }), 201) as Conversation;
/** Views the place, as the web app does when the person leaves it: its point moves to what was shown. */
const view = async (someone: Person, projectId: string) => {
  const seen = await summary(someone, projectId);
  expectStatus(await someone.browser.request('PUT', '/api/v1/return-points', { body: { place: { type: 'project', id: projectId }, mark: seen.mark } }), 200);
};
/** Makes the person an owner of the company, whoever signed up first on this server (the files of this run share it). */
const ownTheCompany = async (someone: Person) => {
  const company = (await pool.query<{ id: string }>('SELECT id FROM workspaces WHERE company')).rows[0]!.id;
  await pool.query("INSERT INTO workspace_members (workspace_id, user_id, role, created_by) VALUES ($1, $2, 'owner', $2) ON CONFLICT (workspace_id, user_id) DO UPDATE SET role = 'owner'", [company, someone.id]);
  return company;
};
const needsYou = async (someone: Person) => expectStatus(await someone.browser.request('GET', '/api/v1/needs-you'), 200) as NeedsYouResponse;

describe('the order of the Spaces list, per person', () => {
  let ada: Person;
  let nia: Person;
  let companyId: string;
  let everyone: string;
  let garden: Project;
  let barrel: Project;
  let library: Project;
  let hidden: Project;

  before(async () => {
    // The first sign-up on this server set the company up, with its Everyone space; Ada is made an owner of it for this test.
    ada = await person('Order Ada');
    nia = await person('Order Nia');
    companyId = await ownTheCompany(ada);
    everyone = (await pool.query<{ id: string }>("SELECT id FROM projects WHERE workspace_id = $1 AND visibility = 'workspace'", [companyId])).rows[0]!.id;
    await addMember(ada, companyId, nia, 'member');
    [garden, barrel, library, hidden] = await Promise.all(['Garden', 'Barrel', 'Library', 'Hidden'].map((name) => createProject(ada, companyId, name, 'restricted')));
    for (const space of [garden, barrel, library]) await grant(ada, space.id, nia, 'contributor');
  });

  test('nobody has an order until they move a space; the list is as it was', async () => {
    assert.deepEqual(await orderOf(ada), []);
    assert.deepEqual(await orderOf(nia), []);
  });

  test('the order is kept on the server, per person: one person moving spaces changes nobody else\'s list', async () => {
    assert.deepEqual(await save(nia, [library.id, garden.id, barrel.id]), { order: [library.id, garden.id, barrel.id] });
    assert.deepEqual(await orderOf(nia), [library.id, garden.id, barrel.id]);
    assert.deepEqual(await orderOf(ada), [], 'Ada\'s list did not move');
    // Another session of the same person, a device they use, reads the same order.
    const phone = await person('Order Nia phone');
    assert.deepEqual(await orderOf(phone), []);
    // The newest save wins whole: the order is not merged.
    assert.deepEqual(await save(nia, [barrel.id, library.id]), { order: [barrel.id, library.id] });
    assert.deepEqual(await orderOf(nia), [barrel.id, library.id]);
    await save(nia, [library.id, garden.id, barrel.id]);
  });

  test('Everyone is never stored and never moves; spaces the person cannot see are not kept; a bad body is refused', async () => {
    assert.deepEqual(await save(nia, [barrel.id, everyone, garden.id, hidden.id, randomUUID(), barrel.id]), { order: [barrel.id, garden.id] },
      'Everyone, a space Nia was not added to, an unknown id and a repeat are left out');
    assert.deepEqual(await orderOf(nia), [barrel.id, garden.id]);
    assert.equal((await pool.query('SELECT 1 FROM space_order WHERE project_id = $1', [everyone])).rowCount, 0);
    for (const order of ['x', [1], ['not-an-id'], Array.from({ length: 501 }, () => randomUUID())]) {
      assert.equal((await nia.browser.request('PUT', SPACE_ORDER_PATH, { body: { order } })).status, 400, JSON.stringify(order).slice(0, 40));
    }
    assert.equal((await nia.browser.request('PUT', SPACE_ORDER_PATH, { body: {} })).status, 400);
    assert.deepEqual(await orderOf(nia), [barrel.id, garden.id], 'a refused body changes nothing');
    assert.deepEqual(await save(nia, []), { order: [] }, 'an empty order is the list as it was');
  });

  test('a space the person lost access to is no longer read back, and comes back with the access', async () => {
    await save(nia, [library.id, garden.id, barrel.id]);
    await removeFromSpace(ada, garden.id, nia);
    assert.deepEqual(await orderOf(nia), [library.id, barrel.id], 'the order answers only spaces Nia can see');
    assert.equal((await pool.query('SELECT 1 FROM space_order WHERE user_id = $1 AND project_id = $2', [nia.id, garden.id])).rowCount, 1, 'the row is only not read; it is the person\'s own record');
    await grant(ada, garden.id, nia, 'contributor');
    assert.deepEqual(await orderOf(nia), [library.id, garden.id, barrel.id], 'added again, the space is where it was');
  });

  test('a new space goes to the end, and Everyone stays first', async () => {
    await save(nia, [library.id, garden.id, barrel.id]);
    const fresh = await createProject(ada, companyId, 'Tool shed', 'restricted');
    await grant(ada, fresh.id, nia, 'contributor');
    assert.deepEqual(await orderOf(nia), [library.id, garden.id, barrel.id], 'the new space has no place of its own yet: it is not put among the others');
    // The list is made of the spaces in the order they were made in; the person's order is laid over it.
    const made = [{ id: everyone }, garden, barrel, library, fresh];
    const list = orderSpaces(made, await orderOf(nia), (space) => space.id === everyone).map((space) => space.id);
    assert.deepEqual(list, [everyone, library.id, garden.id, barrel.id, fresh.id]);
    // Someone who never moved anything sees the spaces as they were made.
    assert.deepEqual(orderSpaces(made, [], (space) => space.id === everyone).map((space) => space.id), made.map((space) => space.id));
    // Even an order that names Everyone last puts it first; an id that is not in the list is ignored.
    assert.deepEqual(orderSpaces(made, [garden.id, randomUUID(), everyone], (space) => space.id === everyone).map((space) => space.id), [everyone, garden.id, barrel.id, library.id, fresh.id]);
    await pool.query('DELETE FROM projects WHERE id = $1', [fresh.id]);
    assert.deepEqual(await orderOf(nia), [library.id, garden.id, barrel.id], 'a deleted space leaves the order with its rows');
  });

  test('a change reaches the person\'s own tabs, and nobody else', async () => {
    const tab = await StreamClient.connect(nia.browser);
    const other = await StreamClient.connect(ada.browser);
    await Promise.all([tab.ready(), other.ready()]);
    await save(nia, [garden.id, library.id, barrel.id]);
    const heard = await tab.event(nia.id, SPACE_ORDER_CHANGED_EVENT);
    assert.equal(heard.objectType, 'person');
    assert.equal(heard.workspaceId, companyId);
    // A short wait for what Ada's stream would have had; her own events (the spaces she made) are older than this connection.
    await new Promise((resolve) => setTimeout(resolve, 600));
    assert.equal(other.events.some((event) => event.kind === SPACE_ORDER_CHANGED_EVENT), false, 'Ada hears nothing of Nia\'s order');
    await Promise.all([tab.close(), other.close()]);
  });
});

describe('Mark all as read', () => {
  let ada: Person;
  let kai: Person;
  let companyId: string;
  let garden: Project;
  let barrel: Project;
  let everyone: string;
  // The agents of the two people, as rows (the stack's AI is not needed): their private chats are read by Mark all as read too.
  let kaisAgent = '';
  let adasAgent = '';
  const agentOf = async (someone: Person) => {
    const [agentId, connectionId] = [randomUUID(), randomUUID()];
    await pool.query(`INSERT INTO agents (id, workspace_id, name, owner_user_id, created_by) VALUES ($1, $2, 'Assistant', $3, $3)`, [agentId, companyId, someone.id]);
    await pool.query(`INSERT INTO agent_connections (id, workspace_id, owner_user_id, agent_id, name, compute_source) VALUES ($1, $2, $3, $4, 'Assistant', 'owner_assistant')`,
      [connectionId, companyId, someone.id, agentId]);
    await pool.query(`INSERT INTO assistant_settings (workspace_id, owner_user_id, agent_id, connection_id, engine, api_key_id, provider, model)
      VALUES ($1, $2, $3, $4, 'server', $5, 'anthropic', 'claude-sonnet-5')`, [companyId, someone.id, agentId, connectionId, randomUUID()]);
    return agentId;
  };

  before(async () => {
    ada = await person('Ada Reader');
    kai = await person('Kai Reader');
    companyId = await ownTheCompany(ada);
    everyone = (await pool.query<{ id: string }>("SELECT id FROM projects WHERE workspace_id = $1 AND visibility = 'workspace'", [companyId])).rows[0]!.id;
    await addMember(ada, companyId, kai, 'member');
    [kaisAgent, adasAgent] = [await agentOf(kai), await agentOf(ada)];
    [garden, barrel] = await Promise.all(['Read garden', 'Read barrel'].map((name) => createProject(ada, companyId, name, 'restricted')));
    for (const space of [garden, barrel]) await grant(ada, space.id, kai, 'contributor');
    // Kai has looked at both once, so what Ada writes now is unread for them.
    for (const space of [garden, barrel]) await view(kai, space.id);
  });

  test('it clears the unread of every space, keeps what needs an action in the Inbox, and Undo brings back what was unread', async () => {
    const thread = await start(ada, garden.id, 'The beds need water before Friday.');
    await start(ada, barrel.id, 'The lid is back on.');
    // A decision Kai can accept needs them: it is computed from the rows, so it is in their Inbox at once.
    expectStatus(await post(ada, `/api/v1/projects/${garden.id}/decisions`, { title: 'Water the beds at dawn', rationale: 'Less evaporates.' }), 201);
    assert.ok((await summary(kai, garden.id)).items.length > 0, 'the garden has news for Kai');
    assert.ok((await summary(kai, barrel.id)).items.length > 0, 'the barrel has news for Kai');
    const waiting = (await needsYou(kai)).items.map((item) => item.key);
    assert.equal(waiting.length, 1, 'the decision needs Kai');

    const result = expectStatus(await post(kai, READ_ALL_PATH), 200) as ReadAllResult;
    assert.deepEqual([...result.undo.spaces].sort(), [everyone, garden.id, barrel.id].sort(), 'Everyone and the two spaces Kai is in were read, and nothing Kai cannot see');
    assert.ok(result.undo.mark);
    assert.deepEqual([(await summary(kai, garden.id)).items.length, (await summary(kai, barrel.id)).items.length], [0, 0], 'nothing is unread');
    assert.deepEqual((await needsYou(kai)).items.map((item) => item.key), waiting, 'the decision that needs Kai is still in the Inbox');
    assert.equal((await summary(ada, garden.id)).point.savedAt === null, true, 'Ada\'s own points did not move');

    // Reading again with nothing new moves nothing.
    const again = expectStatus(await post(kai, READ_ALL_PATH), 200) as ReadAllResult;
    assert.deepEqual(again.undo.spaces, []);

    // Undo puts back the unread of the spaces Kai did not open since; one they opened keeps what they saw.
    await say(ada, thread.id, 'Sorry, Friday afternoon is better.');
    await start(ada, barrel.id, 'One more thing about the barrel.');
    await view(kai, barrel.id);
    expectStatus(await post(kai, READ_ALL_UNDO_PATH, { ...result.undo }), 204);
    assert.ok((await summary(kai, garden.id)).items.length > 0, 'the garden is unread again');
    assert.equal((await summary(kai, barrel.id)).items.length, 0, 'the barrel was opened since: Undo leaves it read');
  });

  test('it reads the chats of the person\'s agents, and Undo puts the time back to the microsecond', async () => {
    const agent = { agentId: kaisAgent };
    await pool.query('INSERT INTO agent_chat_messages (id, workspace_id, agent_id, owner_user_id, key, body) VALUES ($1, $2, $3, $4, $5, $6)',
      [randomUUID(), companyId, agent.agentId, kai.id, `read-all:${randomUUID()}`, 'Done: nothing to report']);
    // What the sidebar's dot and `Mark all as read` both read: the unread lines of each of the person's agents' chats.
    const unread = async () => (await personalRunRows(db).agentChatSummaries(kai.id)).find((item) => item.agentId === agent.agentId)?.unread ?? 0;
    assert.equal(await unread(), 1);
    const result = expectStatus(await post(kai, READ_ALL_PATH), 200) as ReadAllResult;
    assert.deepEqual(result.undo.chats.map((chat) => chat.agentId), [agent.agentId]);
    assert.equal(await unread(), 0);
    expectStatus(await post(kai, READ_ALL_UNDO_PATH, { ...result.undo }), 204);
    assert.equal(await unread(), 1, 'the chat is unread again');
    // A chat the person read themselves since is not undone.
    const second = expectStatus(await post(kai, READ_ALL_PATH), 200) as ReadAllResult;
    await personalRunRows(db).readAgentChat(agent.agentId);
    expectStatus(await post(kai, READ_ALL_UNDO_PATH, { ...second.undo }), 204);
    assert.equal(await unread(), 0, 'what Kai read themselves stays read');
    await pool.query('DELETE FROM agent_chat_messages WHERE agent_id = $1', [agent.agentId]);
  });

  test('another person\'s chats and spaces are never touched, and an Undo that was not made here is refused', async () => {
    const agent = { agentId: adasAgent };
    await pool.query('INSERT INTO agent_chat_messages (id, workspace_id, agent_id, owner_user_id, key, body) VALUES ($1, $2, $3, $4, $5, $6)',
      [randomUUID(), companyId, agent.agentId, ada.id, `read-all:${randomUUID()}`, 'Ada\'s own line']);
    const before = (await pool.query('SELECT count(*)::int AS n FROM return_points WHERE user_id = $1', [ada.id])).rows[0]!.n as number;
    const kaisRead = expectStatus(await post(kai, READ_ALL_PATH), 200) as ReadAllResult;
    assert.deepEqual(kaisRead.undo.chats, [], 'Kai has no unread chat of their own, and Ada\'s was not read for them');
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM return_points WHERE user_id = $1', [ada.id])).rows[0]!.n, before);
    const lines = (await pool.query('SELECT 1 FROM agent_chat_reads WHERE agent_id = $1', [agent.agentId])).rowCount;
    assert.equal(lines, 0, 'Ada\'s chat is still unread');
    // Kai sends an Undo naming Ada's chat: nothing of Ada's moves.
    const forged = { mark: kaisRead.undo.mark, spaces: [], chats: [{ agentId: agent.agentId, before: null, now: '2026-01-01 00:00:00+00' }] };
    expectStatus(await post(kai, READ_ALL_UNDO_PATH, forged), 204);
    // A mark that is not one of Kai's own positions, and a body that is not an Undo, are refused.
    const stolen = (await pool.query("SELECT event_id FROM event_audience WHERE recipient = $1 ORDER BY seq DESC LIMIT 1", [`human:${ada.id}`])).rows[0]!.event_id as string;
    const notMine = await post(kai, READ_ALL_UNDO_PATH, { mark: randomUUID(), spaces: [garden.id], chats: [] });
    assert.equal(notMine.status, 400);
    assert.equal((notMine.json as { code: string }).code, 'INVALID_READ_UNDO');
    assert.ok(stolen);
    for (const body of [{}, { mark: null, spaces: ['x'], chats: [] }, { mark: null, spaces: [], chats: [{ agentId: 'x', before: null, now: 'y' }] }]) {
      assert.equal((await post(kai, READ_ALL_UNDO_PATH, body)).status, 400, JSON.stringify(body));
    }
    await pool.query('DELETE FROM agent_chat_messages WHERE agent_id = $1', [agent.agentId]);
  });
});
