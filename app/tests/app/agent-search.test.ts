import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, beforeEach, describe, test } from 'node:test';
import type { Conversation, Project } from '@flux/contracts';
import { pool } from './support/db.js';
import { createSealed, passphrase, unlock } from './support/encryption.js';
import { agentConnection, toolFailure } from './support/mcp-actions.js';
import { mcp, toolValue } from './support/mcp.js';
import { addMember, expectStatus, grant, person, project as createProject, removeFromSpace, removeMember, type Person } from './support/people.js';
import { ensureSpaceAiAllowed, setSpaceAi } from './support/space-ai.js';
import { assistantScene, human, type AssistantScene, type Message } from './support/assistant-scene.js';

// F-042, AG-12, #1290: `flux_search` and `flux_read_around`, for the owner's Claude Code and Codex (an OAuth client) and for a run (the server's
// engine and the CLIs' runs both reach them through a run token). Access is the owner's rights at the moment of the call, nothing stored: a lost
// grant, a space whose AI was turned off, an owner who became a guest or left, an edited, removed or deleted message show in the very next call,
// on the same token. A run reaches its own place (C-12, C-37): a space's run that space, a run in a direct message that direct message, a private
// chat and a client every space their owner reaches. Encrypted spaces are other workspaces: never found. No model is called.

type Hit = { kind: string; id: string; link: string; place: { type: string; id: string; name: string } | null; conversationId?: string; sequence?: number;
  version?: number; number?: number; status?: string; title?: string; snippet?: string; author?: { kind: string; id: string; name: string }; at: string;
  discussion?: { messages: number } };
type Found = { results: Hit[]; more?: boolean; note?: string };
type Around = { aroundMessageId: string; projectId?: string; dmId?: string; conversationId?: string; hasMoreBefore: boolean; hasMoreAfter: boolean;
  messages: { id: string; sequence: number; body: string; author: { kind: string; id: string; name: string } }[] };

const rename = (who: Person, name: string) => pool.query('UPDATE auth_users SET name = $1 WHERE id = $2', [name, who.id]);
const failure = (message: Message) => toolFailure(message).code;
const inSpace = (found: Found, spaceId: string) => found.results.filter((hit) => hit.place?.id === spaceId);
const bodies = (found: Found) => found.results.map((hit) => (hit.snippet ?? hit.title ?? '').replace(/\*\*/g, ''));

describe('flux_search and flux_read_around: the owner\'s rights at the moment of the call, in every space they reach (#1290)', () => {
  let scene: AssistantScene;
  let lamp: Project; // restricted: the owner, the peer, the viewer
  let open: Project; // visible to the company
  let hidden: Project; // restricted, the owner is not in it
  let lampThread: Conversation; let openThread: Conversation; let hiddenThread: Conversation;
  let nextCall = 1000;

  const PL = 'Kalibracja czujników temperatury jest zaplanowana na piątek.';
  const EN = 'The humidity sensors were calibrated yesterday, see the calibration notes.';
  const SECRET = 'Czujnik tajny: budżet kalibracji na przyszły rok.';

  const post = async (who: Person, conversationId: string, body: string) =>
    expectStatus(await who.browser.request('POST', `/api/v1/conversations/${conversationId}/messages`, { body: { body, clientMessageId: randomUUID() } }), 201) as { id: string; sequence: number };
  const start = async (who: Person, projectId: string, body: string) =>
    expectStatus(await who.browser.request('POST', `/api/v1/projects/${projectId}/conversations`, { body: { body, clientMessageId: randomUUID() } }), 201) as Conversation;
  const first = (conversation: Conversation) => conversation.messages[0]!.id;

  /** A call through a bearer: a client's access token or a run's token. The result is the tool's answer, or a refusal. */
  const call = (token: string, name: string, args: Record<string, unknown>) => mcp(token, nextCall++, 'tools/call', { name, arguments: args });
  const search = async (token: string, args: Record<string, unknown>) => toolValue((await call(token, 'flux_search', args)).message) as unknown as Found;
  const around = async (token: string, args: Record<string, unknown>) => toolValue((await call(token, 'flux_read_around', args)).message) as unknown as Around;
  /** Whether a call was refused whole (the route's answer) or as a tool error. */
  const refused = async (token: string, name: string, args: Record<string, unknown>) => {
    const answered = await call(token, name, args);
    return answered.status !== 200 || answered.message?.error !== undefined || (answered.message?.result as { isError?: boolean } | undefined)?.isError === true;
  };

  /** A person with an agent and a client of it (Claude Code on their computer), in the scene's workspace. */
  async function clientOf(label: string, role: 'member' | 'admin' = 'member') {
    const someone = await person(`search-${label}`);
    await addMember(scene.lead, scene.ws.id, someone, role);
    const agent = expectStatus(await someone.browser.request('POST', `/api/v1/workspaces/${scene.ws.id}/agents`, { body: { name: `${label} agent`, owner: 'self' } }), 201) as { id: string };
    const connection = await agentConnection(pool, someone.browser, agent.id, [open.id]);
    return { someone, agentId: agent.id, connection, token: connection.accessToken };
  }

  /** Ada's own agent, connected as Claude Code on her computer: the owner of the scene's assistant, who reads the lamp space and the open one, not the hidden one. */
  let client: { token: string };
  let jonasAgent: string;
  let taskThreadId: string; let taskId: string; let agentMessage: string;
  let plMessage: string; let enMessage: string; let secretMessage: string;

  before(async () => {
    scene = await assistantScene('search');
    await rename(scene.owner, 'Ada Nowak'); await rename(scene.peer, 'Jonas Berg'); await rename(scene.viewer, 'Wera Lis'); await rename(scene.lead, 'Lena Lead');
    lamp = scene.place;
    open = await createProject(scene.lead, scene.ws.id, 'Open notes', 'workspace');
    hidden = await createProject(scene.lead, scene.ws.id, 'Hidden budget', 'restricted');
    lampThread = await start(scene.peer, lamp.id, PL);
    openThread = await start(scene.viewer, open.id, EN);
    hiddenThread = await start(scene.lead, hidden.id, SECRET);
    [plMessage, enMessage, secretMessage] = [first(lampThread), first(openThread), first(hiddenThread)];
    const adaClient = expectStatus(await scene.owner.browser.request('POST', `/api/v1/workspaces/${scene.ws.id}/agents`, { body: { name: 'Claude Code', owner: 'self' } }), 201) as { id: string };
    client = { token: (await agentConnection(pool, scene.owner.browser, adaClient.id, [lamp.id])).accessToken };
    jonasAgent = (expectStatus(await scene.peer.browser.request('POST', `/api/v1/workspaces/${scene.ws.id}/agents`, { body: { name: 'Asystent', owner: 'self' } }), 201) as { id: string }).id;
    // An agent's own message, in a task's discussion: the one that names an agent with whose it is.
    const task = await scene.task(scene.owner, 'Calibrate the anemometer', lamp.id);
    taskId = task.id;
    const jonas = await agentConnection(pool, scene.peer.browser, jonasAgent, [lamp.id]);
    toolValue(await jonas.tool('flux_discuss_task', { projectId: lamp.id, runtimeSessionId: jonas.runtimeSessionId, clientCommandId: randomUUID(), peerRequestClass: 'execute', sources: [],
      taskId, body: 'Anemometer bearings ordered, delivery on Tuesday.' }));
    const discussion = expectStatus(await scene.owner.browser.request('GET', `/api/v1/work/${taskId}/discussion`), 200) as { conversationId: string; root: { id: string } };
    taskThreadId = discussion.conversationId;
    agentMessage = discussion.root.id;
  });
  beforeEach(async () => { await scene.reset(); await ensureSpaceAiAllowed(lamp.id); });
  after(async () => { await ensureSpaceAiAllowed(lamp.id); });

  test('a client finds across every space its owner reads, best match first, in Polish by stem and without accents, and never what the owner may not read', async () => {
    const polish = await search(client.token, { q: 'czujnik piatek' });
    assert.ok(bodies(polish).includes(PL), 'an inflected word and a word without its accent find the Polish message');
    // "czujnik" is in the restricted space the owner is not in, too: it is not found.
    assert.ok(!JSON.stringify(polish).includes('tajny') && !JSON.stringify(polish).includes(hidden.id), 'the space the owner is not in is not found');
    const english = await search(client.token, { q: 'sensor calibrate' });
    assert.ok(bodies(english).includes(EN), 'English stems too: the owner reads this space as a member of the company');
    // Both spaces answer one search (the owner reads them both), each hit says where it is and who wrote it, and links to it.
    const both = await search(client.token, { q: 'czujnik kalibracja sensor' });
    const hit = (id: string) => both.results.find((item) => item.id === id)!;
    assert.deepEqual([hit(plMessage).place, hit(plMessage).author?.name, hit(plMessage).conversationId, hit(plMessage).sequence],
      [{ type: 'space', id: lamp.id, name: lamp.name }, 'Jonas Berg', lampThread.id, 1]);
    assert.equal(hit(plMessage).link, `/projects/${lamp.id}/conversations/${lampThread.id}#message-${plMessage}`);
    assert.deepEqual([hit(enMessage).place?.name, hit(enMessage).author?.name], ['Open notes', 'Wera Lis']);
    assert.match(hit(plMessage).snippet!, /\*\*Kalibracja\*\*|\*\*czujników\*\*/, 'the matching words are marked in bold, as far as the words themselves are');
    assert.ok(Date.parse(hit(plMessage).at) > 0);
  });

  test('a word that is rare ranks above one that is common, any of the words match, and nothing found says what to try', async () => {
    const rare = await post(scene.viewer, openThread.id, 'Anemometr na dachu B wymaga wymiany łożyska.');
    const found = await search(client.token, { q: 'anemometr czujnik' });
    assert.equal(found.results[0]!.id, rare.id, 'the rare word first');
    assert.ok(found.results.length >= 2, 'any of the words matches: the common one alone still finds');
    assert.equal(found.more, undefined);
    const none = await search(client.token, { q: 'zzzyx' });
    assert.deepEqual(none.results, []);
    assert.match(none.note!, /^Nothing matched\. Try other words/);
    const limited = await search(client.token, { q: 'czujnik anemometr kalibracja sensor', limit: 1 });
    assert.equal(limited.results.length, 1);
    assert.equal(limited.more, true, 'there are more than it lists');
  });

  test('the filters: a space, a conversation, a task\'s discussion, an author, a time range and a kind; a place that is not there or not the owner\'s is one answer', async () => {
    const inLamp = await search(client.token, { q: 'czujnik sensor kalibracja', in: lamp.id });
    assert.ok(inLamp.results.length > 0 && inLamp.results.every((item) => item.place?.id === lamp.id), 'one space');
    const inThread = await search(client.token, { q: 'czujnik sensor kalibracja', in: openThread.id });
    assert.ok(inThread.results.length > 0 && inThread.results.every((item) => item.conversationId === openThread.id), 'one conversation');
    const inTask = await search(client.token, { q: 'anemometer bearings', in: taskId });
    assert.deepEqual(inTask.results.map((item) => [item.id, item.conversationId]), [[agentMessage, taskThreadId]], 'a task is its discussion');
    assert.deepEqual(inTask.results[0]!.author, { kind: 'agent', id: jonasAgent, name: 'Asystent (Jonas\'s agent)' }, 'an agent is named with whose it is');
    for (const place of [hidden.id, hiddenThread.id, randomUUID()]) assert.equal(failure((await call(client.token, 'flux_search', { q: 'czujnik', in: place })).message), 'PLACE_NOT_FOUND', place);

    const fromJonas = await search(client.token, { q: 'czujnik sensor kalibracja', from: scene.peer.id });
    assert.deepEqual(fromJonas.results.map((item) => item.id), [plMessage], 'by one person');
    assert.deepEqual((await search(client.token, { q: 'czujnik sensor kalibracja', from: scene.viewer.id })).results.map((item) => item.id), [enMessage]);

    await pool.query(`UPDATE search_documents SET at = '2026-03-15T10:00:00Z' WHERE kind = 'message' AND object_id = $1`, [plMessage]);
    const ids = async (extra: Record<string, unknown>) => (await search(client.token, { q: 'czujnik', ...extra })).results.map((item) => item.id);
    assert.deepEqual(await ids({ after: '2026-03-01', before: '2026-04-01' }), [plMessage], 'a range of dates');
    assert.deepEqual(await ids({ after: '2026-03-15T10:00:00Z' }), [plMessage], 'from a moment, included');
    assert.deepEqual(await ids({ before: '2026-03-15T10:00:00Z' }), [], 'until a moment, not included');
    assert.deepEqual(await ids({ before: '2026-03-15T12:00:00+02:00' }), [], 'a time with its offset: ten o\'clock UTC');
    assert.deepEqual(await ids({ after: '2026-03-16' }), [], 'later');
    for (const bad of [{ after: 'last week' }, { before: '2026-02-31' }, { after: '2026-04-01', before: '2026-03-01' }])
      assert.equal(failure((await call(client.token, 'flux_search', { q: 'czujnik', ...bad })).message), 'INVALID_TIME', JSON.stringify(bad));

    const doc = expectStatus(await scene.owner.browser.request('POST', `/api/v1/projects/${lamp.id}/docs`, { body: { title: 'Calibration notes', body: 'Czujnik temperatury: sprawdź kalibrację co kwartał.' } }), 201) as { id: string };
    const task = await scene.task(scene.owner, 'Order a czujnik for the north roof', open.id);
    assert.deepEqual((await search(client.token, { q: 'czujnik', kind: 'doc' })).results.map((item) => [item.kind, item.id, item.title, item.version]), [['doc', doc.id, 'Calibration notes', 1]]);
    assert.deepEqual((await search(client.token, { q: 'czujnik', kind: 'task' })).results.map((item) => [item.kind, item.id, item.number, item.status]), [['task', task.id, task.number, 'open']]);
    assert.ok((await search(client.token, { q: 'czujnik', kind: 'message' })).results.every((item) => item.kind === 'message'));
    // A map's thought: a private map is never found by an agent, not even its owner's.
    const privateMap = expectStatus(await scene.owner.browser.request('POST', `/api/v1/workspaces/${scene.ws.id}/sketches`, { body: { title: 'My notes', scope: 'private' } }), 201) as { id: string };
    expectStatus(await scene.owner.browser.request('POST', `/api/v1/sketches/${privateMap.id}/thoughts`, { body: { text: 'Czujnik: a private thought', x: 0, y: 0 } }), 201);
    assert.ok(!JSON.stringify(await search(client.token, { q: 'czujnik prywatna private thought' })).includes('private thought'));
  });

  test('from takes a person\'s or an agent\'s name among those the caller may see named there, and an id as before (#1410)', async () => {
    const q = 'czujnik sensor kalibracja anemometer bearings';
    const ids = async (token: string, from: string) => (await search(token, { q, from })).results.map((item) => item.id);
    for (const name of ['Jonas', 'jonas berg', 'Jonasa', 'Jonas Berg']) assert.deepEqual(await ids(client.token, name), [plMessage], name);
    const wera = await search(client.token, { q, from: 'Wera' });
    assert.ok(wera.results.some((item) => item.id === enMessage) && wera.results.every((item) => item.author?.id === scene.viewer.id), 'another person');
    assert.deepEqual(await ids(client.token, scene.peer.id), [plMessage], 'an id works as before');
    assert.equal(failure((await call(client.token, 'flux_search', { q, from: 'Zbigniew' })).message), 'AUTHOR_NOT_FOUND');
    // None of the author's words match: what they wrote within the other filters, newest first, and said so; never what the caller may not read.
    const byJonas = await search(client.token, { q: 'zzzyx', from: 'Jonas' });
    assert.deepEqual([byJonas.results.map((item) => item.id), byJonas.note], [[plMessage], 'Nothing this author wrote has these words: these are what they wrote within the other filters, newest first.']);
    assert.deepEqual((await search(client.token, { q: 'zzzyx', from: 'Jonas', after: '2099-01-01' })).results, []);
    const byLena = await call(client.token, 'flux_search', { q: 'zzzyx', from: 'Lena' });
    assert.ok(!JSON.stringify(byLena.message).includes('tajny') && !JSON.stringify(byLena.message).includes(hiddenThread.id), 'the hidden space she wrote in is not read');
    // Two agents of one name: the tool lists both with whose they are and their ids; the name as people see it picks one.
    const adaAsystent = (expectStatus(await scene.owner.browser.request('POST', `/api/v1/workspaces/${scene.ws.id}/agents`, { body: { name: 'Asystent', owner: 'self' } }), 201) as { id: string }).id;
    const ambiguous = toolFailure((await call(client.token, 'flux_search', { q, from: 'Asystent' })).message);
    assert.equal(ambiguous.code, 'AUTHOR_AMBIGUOUS');
    assert.ok(ambiguous.error.includes(jonasAgent) && ambiguous.error.includes(adaAsystent) && ambiguous.error.includes('Jonas Berg\'s agent'), ambiguous.error);
    assert.deepEqual(await ids(client.token, 'Asystent (Jonas\'s agent)'), [agentMessage], 'an agent as reads name it');
    // Someone outside the run's space is not named there, though the owner's client, which reaches the open space, may name her.
    const outsider = await person('search-zofia');
    await addMember(scene.lead, scene.ws.id, outsider, 'member');
    await rename(outsider, 'Zofia Obca');
    const said = await post(outsider, openThread.id, 'Czujnik sensor na dachu C.');
    assert.deepEqual(await ids(client.token, 'Zofia'), [said.id]);
    const run = await scene.liveRun(lampThread);
    assert.equal(failure((await call(run.token, 'flux_search', { q, from: 'Zofia' })).message), 'AUTHOR_NOT_FOUND', 'a run in the lamp space cannot name her');
    assert.deepEqual(await ids(run.token, 'Jonas'), [plMessage]);
    await scene.complete(run.runId);
  });

  test('a task hit and the task read say that its discussion holds messages and how to read them (#1410)', async () => {
    const tasks = await search(client.token, { q: 'anemometer calibrate', kind: 'task' });
    assert.deepEqual(tasks.results.map((item) => [item.id, item.discussion]), [[taskId, { messages: 1 }]]);
    const quiet = await scene.task(scene.owner, 'Calibrate the barometer', lamp.id);
    const both = await search(client.token, { q: 'calibrate', kind: 'task' });
    assert.equal(both.results.find((item) => item.id === quiet.id)?.discussion, undefined, 'a task nobody discussed says nothing');
    const work = toolValue((await call(client.token, 'flux_get_work', { projectId: lamp.id, id: taskId })).message) as { id: string; discussion?: { messages: number } };
    assert.deepEqual(work.discussion, { messages: 1 });
    const listed = (await mcp(client.token, nextCall++, 'tools/list', {})).message?.result as { tools: { name: string; description: string }[] };
    const described = (name: string) => listed.tools.find((tool) => tool.name === name)!.description;
    assert.match(described('flux_search'), /discussion\.messages has a discussion: flux_get_task_discussion reads it/);
    assert.match(described('flux_search'), /each part of the question has its source/);
    assert.match(described('flux_get_work'), /flux_get_task_discussion/);
  });

  test('a message read around: its neighbours oldest first, the same author labels, and where more can be read', async () => {
    const thread = await start(scene.peer, lamp.id, 'Message one about the roof lamp.');
    const ids = [first(thread)];
    for (let n = 2; n <= 7; n += 1) ids.push((await post(n % 2 ? scene.peer : scene.viewer, thread.id, `Message ${'x'.repeat(n)} about the roof lamp.`)).id);
    const middle = await around(client.token, { messageId: ids[3], before: 2, after: 1 });
    assert.deepEqual(middle.messages.map((message) => message.id), ids.slice(1, 5), 'two before it, it, one after');
    assert.deepEqual(middle.messages.map((message) => message.sequence), [2, 3, 4, 5]);
    assert.deepEqual([middle.hasMoreBefore, middle.hasMoreAfter, middle.aroundMessageId, middle.conversationId, middle.projectId], [true, true, ids[3], thread.id, lamp.id]);
    assert.deepEqual(middle.messages.map((message) => message.author.name), ['Wera Lis', 'Jonas Berg', 'Wera Lis', 'Jonas Berg']);
    const wholeThread = await around(client.token, { messageId: ids[0] });
    assert.deepEqual([wholeThread.messages.length, wholeThread.hasMoreBefore, wholeThread.hasMoreAfter], [6, false, true], 'the default is five after, none before the first');
    const last = await around(client.token, { messageId: ids[6], before: 25, after: 25 });
    assert.deepEqual([last.messages.length, last.hasMoreBefore, last.hasMoreAfter], [7, false, false]);
    assert.equal(await refused(client.token, 'flux_read_around', { messageId: ids[3], before: 26 }), true, 'at most 25 on a side');
    // The agent's own message in a task's discussion names it with whose it is.
    const discussion = await around(client.token, { messageId: agentMessage });
    assert.deepEqual(discussion.messages[0]!.author, { kind: 'agent', id: jonasAgent, name: 'Asystent (Jonas\'s agent)' });
    // A hit is read around by its id: the hit's own message is among them.
    const hit = (await search(client.token, { q: 'czujnik piatek' })).results.find((item) => item.id === plMessage)!;
    assert.ok((await around(client.token, { messageId: hit.id })).messages.some((message) => message.id === plMessage));
    assert.equal(failure((await call(client.token, 'flux_read_around', { messageId: randomUUID() })).message), 'MESSAGE_NOT_FOUND');
    assert.equal(failure((await call(client.token, 'flux_read_around', { messageId: secretMessage })).message), 'MESSAGE_NOT_FOUND', 'a message of a space the owner is not in is one answer with one that is not there');
  });

  test('a grant lost, AI turned off: the very next call, on the same token, finds nothing there and reads nothing around', async () => {
    const lost = await clientOf('lena-lost');
    await grant(scene.lead, lamp.id, lost.someone, 'contributor');
    assert.ok(bodies(await search(lost.token, { q: 'czujnik piatek' })).includes(PL));
    assert.equal((await around(lost.token, { messageId: plMessage })).messages.length, 1);
    await removeFromSpace(scene.lead, lamp.id, lost.someone);
    assert.deepEqual(inSpace(await search(lost.token, { q: 'czujnik piatek' }), lamp.id), [], 'a grant lost: nothing of that space; the open one is still read');
    assert.equal(failure((await call(lost.token, 'flux_read_around', { messageId: plMessage })).message), 'MESSAGE_NOT_FOUND');
    assert.equal(failure((await call(lost.token, 'flux_search', { q: 'czujnik', in: lamp.id })).message), 'PLACE_NOT_FOUND');

    try {
      await setSpaceAi(lamp.id, 'blocked');
      assert.deepEqual(inSpace(await search(client.token, { q: 'czujnik piatek' }), lamp.id), [], 'AI turned off in the space');
      assert.equal(failure((await call(client.token, 'flux_read_around', { messageId: plMessage })).message), 'MESSAGE_NOT_FOUND');
      assert.ok(bodies(await search(client.token, { q: 'sensor calibrate' })).includes(EN), 'the other spaces are found as before');
      assert.ok(JSON.stringify((await scene.peer.browser.request('GET', `/api/v1/search?q=${encodeURIComponent('Kalibracja czujników')}`)).json).includes('piątek'), 'people still find it');
    } finally {
      await setSpaceAi(lamp.id, 'allowed');
    }
    assert.ok(bodies(await search(client.token, { q: 'czujnik piatek' })).includes(PL), 'and it is back when AI is on');
  });

  test('an owner who becomes a guest, and one who leaves the company, is refused at once, on the same token', async () => {
    const guest = await clientOf('gus-guest');
    const leaver = await clientOf('lea-leaver');
    assert.ok(bodies(await search(guest.token, { q: 'sensor calibrate' })).includes(EN));
    assert.ok(bodies(await search(leaver.token, { q: 'sensor calibrate' })).includes(EN));
    expectStatus(await scene.lead.browser.request('PATCH', `/api/v1/workspaces/${scene.ws.id}/members/${guest.someone.id}`, { body: { role: 'guest' } }), 200);
    assert.equal(await refused(guest.token, 'flux_search', { q: 'sensor calibrate' }), true, 'a guest has no AI');
    assert.equal(await refused(guest.token, 'flux_read_around', { messageId: enMessage }), true);
    await removeMember(scene.lead, scene.ws.id, leaver.someone);
    assert.equal(await refused(leaver.token, 'flux_search', { q: 'sensor calibrate' }), true, 'someone who left the company');
    assert.equal(await refused(leaver.token, 'flux_read_around', { messageId: enMessage }), true);
  });

  test('an edited, a removed and a deleted message are reflected by the next call', async () => {
    const thread = await start(scene.peer, lamp.id, 'Pierwszy pomiar barometru.');
    const message = await post(scene.peer, thread.id, 'Barograf stoi w szopie.');
    assert.deepEqual(bodies(await search(client.token, { q: 'barograf' })), ['Barograf stoi w szopie.']);
    expectStatus(await scene.peer.browser.request('PATCH', `/api/v1/conversations/${thread.id}/messages/${message.id}`, { body: { body: 'Wiatrak stoi w szopie.' } }), 200);
    assert.deepEqual((await search(client.token, { q: 'barograf' })).results, [], 'the words that are gone find nothing');
    assert.deepEqual(bodies(await search(client.token, { q: 'wiatrak' })), ['Wiatrak stoi w szopie.']);
    assert.equal((await around(client.token, { messageId: message.id })).messages.find((item) => item.id === message.id)?.body, 'Wiatrak stoi w szopie.', 'read around, the new words');
    const removed = await scene.peer.browser.request('DELETE', `/api/v1/conversations/${thread.id}/messages/${message.id}`);
    assert.ok(removed.status === 200 || removed.status === 204, removed.text);
    assert.deepEqual((await search(client.token, { q: 'wiatrak' })).results, [], 'a removed message is not found');
    const gone = await post(scene.peer, thread.id, 'Pluwiometr kalibrowany ręcznie.');
    assert.equal((await search(client.token, { q: 'pluwiometr' })).results.length, 1);
    await pool.query('DELETE FROM project_messages WHERE id = $1', [gone.id]);
    assert.deepEqual((await search(client.token, { q: 'pluwiometr' })).results, [], 'a deleted row is not found');
    assert.equal(failure((await call(client.token, 'flux_read_around', { messageId: gone.id })).message), 'MESSAGE_NOT_FOUND', 'nor read around');
  });

  describe('a run reaches its own place (C-12, C-37)', () => {
    const chatRun = async () => scene.liveOf((await scene.runs.invoke(human(scene.owner), { kind: 'chat', agentId: scene.agentId }, { clientRunId: randomUUID(), kind: 'ask', prompt: 'Find it' })).run.id);
    const dmRun = async (dmId: string) => scene.liveOf((await scene.runs.invoke(human(scene.owner), { kind: 'dm', dmId, threadRootId: null }, { clientRunId: randomUUID(), kind: 'ask', prompt: 'Find it' })).run.id);
    let dm: string; let dmMessage: string; let otherDm: string; let otherDmMessage: string;
    const DM_WORDS = 'Zamówienie diody wysłane przez Kaia we wtorek.';
    const OTHER_DM_WORDS = 'Zamówienie diody od Wery dla Jonasa.';

    before(async () => {
      const opened = await scene.owner.browser.request('POST', `/api/v1/workspaces/${scene.ws.id}/dms`, { body: { participantIds: [scene.peer.id] } });
      assert.ok(opened.status === 201 || opened.status === 200, opened.text);
      dm = (opened.json as { id: string }).id;
      dmMessage = ((expectStatus(await scene.peer.browser.request('POST', `/api/v1/dms/${dm}/messages`, { body: { body: DM_WORDS, clientMessageId: randomUUID() } }), 201)) as { id: string }).id;
      expectStatus(await scene.owner.browser.request('POST', `/api/v1/dms/${dm}/messages`, { body: { body: 'Dziękuję, zamówienie diody zapisane.', clientMessageId: randomUUID() } }), 201);
      // Another direct message of the same owner's, with someone else: a run in the first must not find it.
      const other = await scene.owner.browser.request('POST', `/api/v1/workspaces/${scene.ws.id}/dms`, { body: { participantIds: [scene.viewer.id] } });
      assert.ok(other.status === 201 || other.status === 200, other.text);
      otherDm = (other.json as { id: string }).id;
      otherDmMessage = ((expectStatus(await scene.viewer.browser.request('POST', `/api/v1/dms/${otherDm}/messages`, { body: { body: OTHER_DM_WORDS, clientMessageId: randomUUID() } }), 201)) as { id: string }).id;
    });

    test('a run in a space finds that space and no other, and cannot be pointed at another; a private chat finds every space its owner reads', async () => {
      const run = await scene.liveRun(lampThread);
      const inLamp = await search(run.token, { q: 'czujnik sensor kalibracja' });
      assert.ok(inLamp.results.length > 0 && inLamp.results.every((item) => item.place?.id === lamp.id), 'its own space only, though the owner reads the other, which says "sensors" too');
      assert.ok(!JSON.stringify(inLamp).includes('Open notes'));
      assert.equal(failure((await call(run.token, 'flux_search', { q: 'sensor', in: open.id })).message), 'PLACE_NOT_FOUND', 'it cannot be sent elsewhere');
      assert.equal(failure((await call(run.token, 'flux_read_around', { messageId: enMessage })).message), 'MESSAGE_NOT_FOUND', 'nor read around a message of another space');
      assert.equal((await around(run.token, { messageId: plMessage })).messages.length, 1, 'its own space is read around');
      assert.deepEqual((await search(run.token, { q: 'czujnik', in: lampThread.id })).results.map((item) => item.id), [plMessage], 'a conversation of its space');
      // None of its owner's direct messages, in any run but one in that direct message.
      assert.deepEqual((await search(run.token, { q: 'zamówienie diody' })).results, []);
      assert.equal(failure((await call(run.token, 'flux_read_around', { messageId: dmMessage })).message), 'MESSAGE_NOT_FOUND');

      await scene.complete(run.runId);
      const chat = await chatRun();
      const everywhere = await search(chat.token, { q: 'czujnik sensor kalibracja' });
      assert.deepEqual(new Set(everywhere.results.map((item) => item.place?.id)), new Set([lamp.id, open.id]), 'every space its owner reads, and not the one it is not in');
      assert.ok(!JSON.stringify(everywhere).includes('tajny'));
      assert.deepEqual((await search(chat.token, { q: 'zamówienie diody' })).results, [], 'a private chat finds no direct message either');
      assert.equal(failure((await call(chat.token, 'flux_read_around', { messageId: dmMessage })).message), 'MESSAGE_NOT_FOUND');
      assert.ok(!JSON.stringify(await search(chat.token, { q: 'czujnik private thought' })).includes('private thought'), 'a private map is never found');
    });

    test('a run in a direct message finds the messages of that direct message and reads around them, and nothing else, while its owner is one of its people', async () => {
      const run = await dmRun(dm);
      assert.deepEqual(run.tools.slice().sort(), ['flux_read_around', 'flux_read_web', 'flux_search', 'flux_summarize'], 'a direct message run is minted these four tools');
      const found = await search(run.token, { q: 'zamówienie diody' });
      assert.deepEqual(found.results.map((item) => [item.kind, item.place?.type, item.place?.id, item.author?.name]).sort(),
        [['message', 'dm', dm, 'Ada Nowak'], ['message', 'dm', dm, 'Jonas Berg']], 'the two messages of this direct message, not the other one of the same words');
      const mine = found.results.find((item) => item.id === dmMessage)!;
      assert.equal(mine.link, `/dm/${dm}#message-${dmMessage}`);
      assert.equal(mine.sequence, 1);
      const read = await around(run.token, { messageId: dmMessage });
      assert.deepEqual([read.dmId, read.messages.map((message) => message.body), read.hasMoreBefore, read.hasMoreAfter], [dm, [DM_WORDS, 'Dziękuję, zamówienie diody zapisane.'], false, false]);
      // Nothing else: a space's words, another direct message of the same owner's, a space or a direct message named by the model.
      assert.deepEqual((await search(run.token, { q: 'czujnik sensor kalibracja anemometr' })).results, [], 'no space');
      assert.deepEqual((await search(run.token, { q: 'Wery' })).results, [], 'no other direct message');
      for (const messageId of [plMessage, enMessage, otherDmMessage]) assert.equal(failure((await call(run.token, 'flux_read_around', { messageId })).message), 'MESSAGE_NOT_FOUND', messageId);
      for (const place of [lamp.id, otherDm]) assert.equal(failure((await call(run.token, 'flux_search', { q: 'zamówienie', in: place })).message), 'PLACE_NOT_FOUND', place);
      assert.equal((await search(run.token, { q: 'zamówienie', in: dm })).results.length, 2, 'it may name its own direct message');
      // Its owner leaves the direct message: the next call on the same token finds nothing and reads nothing.
      const row = (await pool.query(`SELECT workspace_id, joined_at FROM dm_participants WHERE dm_id = $1 AND user_id = $2`, [dm, scene.owner.id])).rows[0] as { workspace_id: string; joined_at: Date };
      await pool.query('DELETE FROM dm_participants WHERE dm_id = $1 AND user_id = $2', [dm, scene.owner.id]);
      try {
        assert.deepEqual((await search(run.token, { q: 'zamówienie diody' })).results, []);
        assert.equal(failure((await call(run.token, 'flux_read_around', { messageId: dmMessage })).message), 'MESSAGE_NOT_FOUND');
      } finally {
        await pool.query('INSERT INTO dm_participants (workspace_id, dm_id, user_id, joined_at) VALUES ($1, $2, $3, $4)', [row.workspace_id, dm, scene.owner.id, row.joined_at]);
      }
      assert.equal((await search(run.token, { q: 'zamówienie diody' })).results.length, 2, 'and it is back with them');
    });

    test('no client of the owner finds a direct message, and a run in another direct message finds only its own', async () => {
      assert.deepEqual((await search(client.token, { q: 'zamówienie diody' })).results, [], 'a local client has no direct messages');
      assert.equal(failure((await call(client.token, 'flux_read_around', { messageId: dmMessage })).message), 'MESSAGE_NOT_FOUND');
      const other = await dmRun(otherDm);
      assert.deepEqual((await search(other.token, { q: 'zamówienie diody' })).results.map((item) => item.id), [otherDmMessage], 'its own and not the first one\'s, of the same words');
      assert.equal(failure((await call(other.token, 'flux_read_around', { messageId: dmMessage })).message), 'MESSAGE_NOT_FOUND');
    });
  });

  test('an encrypted space is never found, and none of its messages is read around', async () => {
    const pw = passphrase();
    const sealed = (await createSealed(scene.owner, 'Garden club', pw)).workspace;
    assert.equal((await unlock(scene.owner.browser, sealed.id, { password: pw })).status, 200);
    const space = await createProject(scene.owner, sealed.id, 'Beds', 'workspace');
    const thread = await start(scene.owner, space.id, 'Lampa nad grządką ukrytego sekretu kalibracja czujnik sensor.');
    const chat = await scene.liveOf((await scene.runs.invoke(human(scene.owner), { kind: 'chat', agentId: scene.agentId }, { clientRunId: randomUUID(), kind: 'ask', prompt: 'Find it' })).run.id);
    for (const token of [client.token, chat.token]) {
      const found = await search(token, { q: 'ukrytego sekretu kalibracja czujnik sensor' });
      assert.ok(!JSON.stringify(found).includes('ukrytego') && !JSON.stringify(found).includes(space.id), 'nothing of it');
      assert.equal(failure((await call(token, 'flux_read_around', { messageId: first(thread) })).message), 'MESSAGE_NOT_FOUND');
      assert.equal(failure((await call(token, 'flux_search', { q: 'lampa', in: space.id })).message), 'PLACE_NOT_FOUND');
    }
    const indexed = await pool.query(`SELECT count(*)::int AS n FROM search_documents WHERE workspace_id = $1 AND kind = 'message' AND NOT sealed`, [sealed.id]);
    assert.equal((indexed.rows[0] as { n: number }).n, 0, 'the BM25 index holds no message of it');
  });

  test('the tools tell the agent to search before it says it does not know, in each language, and a client and a run list the same two', async () => {
    const run = await scene.liveRun(lampThread);
    for (const token of [client.token, run.token]) {
      const listed = ((await mcp(token, nextCall++, 'tools/list')).message?.result as { tools: { name: string; description: string }[] }).tools;
      const names = listed.map((tool) => tool.name);
      assert.ok(names.includes('flux_search') && names.includes('flux_read_around'), 'both');
      assert.ok(!names.includes('flux_search_project'), 'the old one-space search is gone');
      const searchTool = listed.find((tool) => tool.name === 'flux_search')!;
      assert.match(searchTool.description, /Search before you say you do not know/);
      assert.match(searchTool.description, /in each language the people here write in/);
      assert.match(searchTool.description, /try other words/);
      assert.match(listed.find((tool) => tool.name === 'flux_read_around')!.description, /Authors are named as people see them, as flux_get_conversation names them/);
    }
    assert.ok(run.tools.includes('flux_search') && run.tools.includes('flux_read_around'), 'a run is minted both');
  });
});
