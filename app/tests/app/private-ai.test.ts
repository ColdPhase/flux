import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { before, describe, test } from 'node:test';
import { createPersonalRunProcessor, postToAgentChat, type Principal } from '@flux/core';
import { ME_TIME_ZONE_PATH, type AssistantRun, type Conversation, type ConversationRootWindow, type Dm, type DmMessage, type DmThread, type Page, type Project, type ShowAnswerResult, type Workspace } from '@flux/contracts';
import { personalRunUseCases } from '../../apps/server/src/personal-runs/adapters.js';
import { personalRunWorkerUnitOfWork } from '../../apps/worker/src/personal-runs/adapters.js';
import { db, pool } from './support/db.js';
import { addMember, expectStatus, grant, person, project as createProject, type Person } from './support/people.js';
import { echo, FakeCompute, FakeConnections, FakeQueue } from './support/personal-runs.js';
import { StreamClient } from './support/stream.js';

// `/ai` in every conversation, answered privately (#842, F-036 AG-4, C-12): a space's conversation and its threads, a direct message and the
// private chat with an agent. The answer is its asker's alone; Show everyone posts it as the asker's own message, "Ada · via Assistant". What
// the answer draws on is only what the place's audience can see; a DM's thread has the DM's people as its audience, and the model is given that
// thread and nothing else (#1016). Fake compute: no provider pass is claimed.

const connections = new FakeConnections();
const compute = new FakeCompute();
const queue = new FakeQueue();
const runs = personalRunUseCases(db, { queue: queue.factory, connections, providerEnabled: true });
const processor = createPersonalRunProcessor({ uow: personalRunWorkerUnitOfWork(db), connections, compute, stopPollMs: 20 });
const human = (someone: Person): Principal => ({ kind: 'human', id: someone.id });

const TOKENS = {
  space: `LAMP-${randomUUID()}`,
  thread: `THREAD-${randomUUID()}`,
  otherSpace: `PAYROLL-${randomUUID()}`,
  dm: `BETWEEN-US-${randomUUID()}`,
  dmThread: `IN-THE-THREAD-${randomUUID()}`,
  dmReply: `THREAD-REPLY-${randomUUID()}`,
  otherDmThread: `ANOTHER-THREAD-${randomUUID()}`,
  otherDm: `HUBERT-AND-ADA-${randomUUID()}`,
  chat: `CHAT-${randomUUID()}`,
};

async function post<T>(someone: Person, path: string, body: unknown, status = 201): Promise<T> {
  return expectStatus(await someone.browser.request('POST', path, { body }), status, `POST ${path}`) as T;
}
const get = async <T>(someone: Person, path: string): Promise<T> => expectStatus(await someone.browser.request('GET', path), 200, `GET ${path}`) as T;
const row = async (runId: string) => (await pool.query('SELECT project_id, conversation_id, dm_id, dm_thread_root_id, ai_epoch, status, answer_body, shown_at, dismissed_at FROM personal_runs WHERE id = $1', [runId])).rows[0] as {
  project_id: string | null; conversation_id: string | null; dm_id: string | null; dm_thread_root_id: string | null; ai_epoch: string | null; status: string; answer_body: string | null; shown_at: Date | null; dismissed_at: Date | null };
const reply = (someone: Person, dmId: string, rootId: string, body: string) => post<DmMessage>(someone, `/api/v1/dms/${dmId}/threads/${rootId}/replies`, { body, clientMessageId: randomUUID() });

describe('/ai everywhere, answered privately (#842)', () => {
  let ada: Person; let hubert: Person; let kai: Person; let maurycy: Person; let gus: Person;
  let ws: Workspace; let lamp: Project; let payroll: Project;
  let thread: Conversation; let dm: Dm; let otherDm: Dm;
  /** A thread of the DM between Hubert and Kai (its root is Kai's), and another thread of the same DM. */
  let dmRoot: DmMessage; let otherRoot: DmMessage;
  let agentId = '';
  const connection = randomUUID();

  const sentToTheModel = () => compute.dispatched.at(-1)!.input;
  const finish = async (runId: string) => assert.equal(await processor.process(runId), 'completed');

  before(async () => {
    [ada, hubert, kai, maurycy, gus] = await Promise.all(['pai-ada', 'pai-hubert', 'pai-kai', 'pai-maurycy', 'pai-gus'].map(person));
    ws = expectStatus(await ada.browser.request('POST', '/api/v1/workspaces', { body: { name: 'Gesture lamp' } }), 201) as Workspace;
    for (const member of [hubert, kai, maurycy]) await addMember(ada, ws.id, member, 'member');
    await addMember(ada, ws.id, gus, 'guest');
    lamp = await createProject(ada, ws.id, 'Lamp sensor', 'restricted');
    payroll = await createProject(ada, ws.id, 'Payroll', 'restricted');
    for (const member of [hubert, kai]) await grant(ada, lamp.id, member, 'contributor');
    await grant(ada, payroll.id, hubert, 'contributor');
    thread = await post<Conversation>(kai, `/api/v1/projects/${lamp.id}/conversations`, { body: `Camera fails below 5 lux ${TOKENS.space}`, clientMessageId: randomUUID() });
    await post(hubert, `/api/v1/conversations/${thread.id}/messages`, { body: `The ToF sensor kept working ${TOKENS.thread}`, clientMessageId: randomUUID() });
    await post(ada, `/api/v1/projects/${payroll.id}/conversations`, { body: `Salaries ${TOKENS.otherSpace}`, clientMessageId: randomUUID() });
    dm = await post<Dm>(hubert, `/api/v1/workspaces/${ws.id}/dms`, { participantIds: [kai.id] });
    dmRoot = await post<DmMessage>(kai, `/api/v1/dms/${dm.id}/messages`, { body: `Thread root ${TOKENS.dmThread}`, clientMessageId: randomUUID() });
    await reply(hubert, dm.id, dmRoot.id, `Thread reply ${TOKENS.dmReply}`);
    otherRoot = await post<DmMessage>(kai, `/api/v1/dms/${dm.id}/messages`, { body: `A different thread ${TOKENS.otherDmThread}`, clientMessageId: randomUUID() });
    await reply(kai, dm.id, otherRoot.id, 'More of the different thread');
    await post(hubert, `/api/v1/dms/${dm.id}/messages`, { body: `Between us: ${TOKENS.dm}`, clientMessageId: randomUUID() });
    otherDm = await post<Dm>(hubert, `/api/v1/workspaces/${ws.id}/dms`, { participantIds: [ada.id] });
    await post(hubert, `/api/v1/dms/${otherDm.id}/messages`, { body: `Only Ada and I: ${TOKENS.otherDm}`, clientMessageId: randomUUID() });
    agentId = (await post<{ id: string }>(hubert, `/api/v1/workspaces/${ws.id}/agents`, { name: 'Assistant', owner: 'self' })).id;
    connections.connect(hubert.id, connection);
    await runs.enable(human(hubert), { agentId, connection, model: 'claude-sonnet-5' });
  });

  const ask = (place: Parameters<typeof runs.invoke>[1], prompt = 'Summarise this', extra: Record<string, unknown> = {}) =>
    runs.invoke(human(hubert), place, { clientRunId: randomUUID(), kind: 'ask', prompt, ...extra });

  test('in a thread: the answer is the asker\'s alone, nobody learns of the run, and Show everyone posts it once as "Ada · via Assistant"', async () => {
    const live = await StreamClient.connect(kai.browser);
    await live.ready();
    const started = await ask(thread.id);
    assert.deepEqual([started.run.projectId, started.run.conversationId, started.run.dmId], [lamp.id, thread.id, null]);
    await finish(started.run.id);
    assert.match(sentToTheModel(), new RegExp(TOKENS.space));
    for (const hidden of [TOKENS.otherSpace, TOKENS.dm]) assert.equal(sentToTheModel().includes(hidden), false, `the model was given ${hidden}`);
    // The brief (#1064): who asks, where and when; each message with its author and time; the request last.
    assert.match(compute.dispatched.at(-1)!.system, /^You are Assistant, the AI agent of pai-hubert in Flux[^]*\nWho reads your answer\nOnly pai-hubert\. They may post it with Show everyone/);
    assert.match(compute.dispatched.at(-1)!.system, /It is now \w+day, \d{4}-\d\d-\d\d \d\d:\d\d in pai-hubert's time zone, UTC\./);
    assert.ok(sentToTheModel().startsWith('<place space="Lamp sensor" conversation="thread"/>'), sentToTheModel());
    assert.match(sentToTheModel(), /^All 2 messages of this thread, oldest first\.\n<conversation>\n<message ref="S1" from="pai-kai" by="person" at="\d{4}-\d\d-\d\d \d\d:\d\d">Camera fails below 5 lux /m);
    assert.match(sentToTheModel(), /<request from="pai-hubert" at="[^"]+">Summarise this<\/request>$/);

    // The people of the space see nothing: not the run, not the answer, not that an assistant is working.
    for (const other of [kai, ada, maurycy]) {
      assert.equal((await other.browser.request('GET', `/api/v1/assistant-runs/${started.run.id}`)).status, 404);
      assert.equal((await other.browser.request('POST', `/api/v1/assistant-runs/${started.run.id}/show`)).status, 404, 'only the asker shows it');
      assert.equal((await other.browser.request('POST', `/api/v1/assistant-runs/${started.run.id}/dismiss`)).status, 404);
    }
    assert.equal((await kai.browser.request('GET', `/api/v1/conversations/${thread.id}/assistant-activity`)).status, 404, 'there is no line that says someone is asking');
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(live.events.some((event) => event.kind.startsWith('project.assistant_')), false, 'the space heard nothing');
    await live.close();
    const events = await pool.query(`SELECT kind FROM events WHERE data->>'runId' = $1 AND kind LIKE 'project.assistant%'`, [started.run.id]);
    assert.equal(events.rowCount, 0);

    // The asker's own view: the answer, with the agent by name.
    const own = await get<Page<AssistantRun>>(hubert, `/api/v1/assistant-runs?conversationId=${thread.id}`);
    assert.equal(own.items[0]!.id, started.run.id);
    assert.deepEqual([own.items[0]!.answer?.audience, own.items[0]!.answer?.assistant.label], [{ kind: 'owner' }, 'Assistant']);

    // Show everyone: the asker's own message in the thread, naming the agent; a second press posts nothing more.
    const shown = expectStatus(await hubert.browser.request('POST', `/api/v1/assistant-runs/${started.run.id}/show`), 200) as ShowAnswerResult;
    assert.ok(shown.run.shownAt);
    const again = expectStatus(await hubert.browser.request('POST', `/api/v1/assistant-runs/${started.run.id}/show`), 200) as ShowAnswerResult;
    assert.equal(again.messageId, shown.messageId);
    const conversation = await get<Conversation>(kai, `/api/v1/conversations/${thread.id}`);
    const message = conversation.messages.find((item) => item.id === shown.messageId)!;
    assert.deepEqual([message.authorId, message.via], [hubert.id, 'Assistant']);
    assert.equal(conversation.messages.filter((item) => item.via).length, 1);
    assert.equal(message.body.includes('[1]'), false, 'citations point at the asker\'s card, not at a message');
    // A dismissed run, or one already shown, cannot be dismissed into nothing or shown again.
    assert.equal((expectStatus(await hubert.browser.request('POST', `/api/v1/assistant-runs/${started.run.id}/dismiss`), 200) as AssistantRun).dismissedAt ?? null, null);
  });

  test('in the space\'s main conversation: no conversation of its own; Show everyone starts a root', async () => {
    const started = await ask({ kind: 'space', projectId: lamp.id, conversationId: null });
    assert.deepEqual([started.run.projectId, started.run.conversationId], [lamp.id, null]);
    assert.equal((await row(started.run.id)).ai_epoch !== null, true, 'a space run is admitted under the space\'s AI epoch');
    await finish(started.run.id);
    assert.match(sentToTheModel(), new RegExp(TOKENS.space), 'the main conversation is what its roots say');
    assert.match(sentToTheModel(), new RegExp(`<message ref="S\\d+" thread="Camera fails below 5 lux ${TOKENS.space}" from="pai-kai"`), 'a message names its thread when the thread changes (#1064)');
    assert.equal(sentToTheModel().includes(TOKENS.otherSpace), false);
    // The route of the space's main conversation, and a person outside the space.
    // The route exists and reaches the same use case (this API composes no provider, so it answers that, not that the place is unknown).
    const viaRoute = await hubert.browser.request('POST', `/api/v1/projects/${lamp.id}/assistant-runs`, { body: { clientRunId: randomUUID(), kind: 'ask', prompt: 'x' } });
    assert.deepEqual([viaRoute.status, (viaRoute.json as { code: string }).code], [503, 'PERSONAL_RUN_UNAVAILABLE']);
    assert.equal((await maurycy.browser.request('POST', `/api/v1/projects/${lamp.id}/assistant-runs`, { body: { clientRunId: randomUUID(), kind: 'ask', prompt: 'x' } })).status, 404);

    const roots = (await get<ConversationRootWindow>(kai, `/api/v1/projects/${lamp.id}/conversation-roots`)).roots.length;
    const shown = expectStatus(await hubert.browser.request('POST', `/api/v1/assistant-runs/${started.run.id}/show`), 200) as ShowAnswerResult;
    const after = await get<ConversationRootWindow>(kai, `/api/v1/projects/${lamp.id}/conversation-roots`);
    assert.equal(after.roots.length, roots + 1);
    const root = after.roots.find((item) => item.message.id === shown.messageId)!;
    assert.deepEqual([root.message.authorId, root.message.via], [hubert.id, 'Assistant']);
  });

  test('the brief tells the time in the asker\'s own zone and says when older messages were left out (#1064)', async () => {
    // The asker's zone is their browser's, which the web app saves on them (#1168, C-57).
    expectStatus(await hubert.browser.request('PUT', ME_TIME_ZONE_PATH, { body: { timeZone: 'Asia/Tokyo' } }), 204);
    const long = await post<Conversation>(kai, `/api/v1/projects/${lamp.id}/conversations`, { body: 'Count to forty-one: 1', clientMessageId: randomUUID() });
    for (let n = 2; n <= 41; n++) await post(kai, `/api/v1/conversations/${long.id}/messages`, { body: `Count to forty-one: ${n}`, clientMessageId: randomUUID() });
    try {
      const started = await ask(long.id, 'Where did the count end?');
      await finish(started.run.id);
      assert.match(compute.dispatched.at(-1)!.system, /in pai-hubert's time zone, Asia\/Tokyo\. Every time below is in that zone\./);
      const input = sentToTheModel();
      assert.match(input, /^The latest 40 messages of this thread, oldest first\. Older messages were left out\.$/m);
      assert.equal(input.includes('>Count to forty-one: 1</message>'), false, 'the oldest is the one left out');
      assert.ok(input.includes('>Count to forty-one: 41</message>'));
    } finally {
      expectStatus(await hubert.browser.request('PUT', ME_TIME_ZONE_PATH, { body: { timeZone: 'UTC' } }), 204);
    }
  });

  test('Dismiss puts an answer away for good: it cannot be shown afterwards', async () => {
    const started = await ask(thread.id);
    assert.equal((await hubert.browser.request('POST', `/api/v1/assistant-runs/${started.run.id}/dismiss`)).status, 409, 'a run still working is stopped, not dismissed');
    await finish(started.run.id);
    const dismissed = expectStatus(await hubert.browser.request('POST', `/api/v1/assistant-runs/${started.run.id}/dismiss`), 200) as AssistantRun;
    assert.ok(dismissed.dismissedAt);
    const refused = await hubert.browser.request('POST', `/api/v1/assistant-runs/${started.run.id}/show`);
    assert.deepEqual([refused.status, (refused.json as { code: string }).code], [409, 'ASSISTANT_RUN_NOT_SHOWABLE']);
    assert.equal((await row(started.run.id)).shown_at, null);
  });

  test('in a direct message: both people see one line, only the asker the answer, and the model reads the DM and nothing else', async () => {
    const before = await get<Dm>(kai, `/api/v1/dms/${dm.id}`);
    const started = await ask({ kind: 'dm', dmId: dm.id, threadRootId: null });
    assert.deepEqual([started.run.projectId, started.run.conversationId, started.run.dmId], [null, null, dm.id]);
    assert.equal((await row(started.run.id)).ai_epoch, null, 'a DM has no space, so no AI epoch');
    // The line, for both people, at the moment AI is used (not when it answers).
    for (const someone of [hubert, kai]) {
      const view = await get<Dm>(someone, `/api/v1/dms/${dm.id}`);
      const line = view.messages.at(-1)!;
      assert.deepEqual([line.notice, line.body, line.authorId], ['ai_used', 'Claude', hubert.id], `${someone.email} sees the line`);
      assert.equal(view.messages.length, before.messages.length + 1);
    }
    assert.match(String((await get<{ items: { lastMessageBody: string }[] }>(kai, `/api/v1/workspaces/${ws.id}/dms`)).items.find((item) => (item as unknown as { id: string }).id === dm.id)?.lastMessageBody), /Between us/, 'the line is no preview');
    await finish(started.run.id);
    const input = sentToTheModel();
    assert.match(input, new RegExp(TOKENS.dm));
    for (const hidden of [TOKENS.space, TOKENS.thread, TOKENS.otherSpace]) assert.equal(input.includes(hidden), false, `the model was given ${hidden}`);
    assert.ok(input.startsWith('<place direct_message_with="pai-kai"/>'), 'the DM names its other people as data (#1064)');
    assert.equal(compute.dispatched.at(-1)!.system.includes('pai-kai'), false, 'and never in the instructions');
    assert.equal(compute.dispatched.at(-1)!.tools?.length ?? 0, 0, 'no tool reads anything of the owner\'s other places');
    // A third person cannot ask in it, and Kai cannot read the run.
    assert.equal((await maurycy.browser.request('POST', `/api/v1/dms/${dm.id}/assistant-runs`, { body: { clientRunId: randomUUID(), kind: 'ask', prompt: 'x' } })).status, 404);
    assert.equal((await kai.browser.request('GET', `/api/v1/assistant-runs/${started.run.id}`)).status, 404);
    assert.equal((await get<Page<AssistantRun>>(kai, '/api/v1/assistant-runs')).items.length, 0);
    // Show everyone posts into the DM, "via Assistant", and the search does not find the line.
    const shown = expectStatus(await hubert.browser.request('POST', `/api/v1/assistant-runs/${started.run.id}/show`), 200) as ShowAnswerResult;
    const view = await get<Dm>(kai, `/api/v1/dms/${dm.id}`);
    const message = view.messages.find((item) => item.id === shown.messageId)!;
    assert.deepEqual([message.authorId, message.via], [hubert.id, 'Assistant']);
    const hits = await pool.query(`SELECT 1 FROM search_documents WHERE doc_key = $1`, [`dm_message:${started.run.id}`]);
    assert.equal(hits.rowCount, 0, 'the line "used AI here" is not searchable');
  });

  test('in a thread of a direct message (#1016): a private answer, one line in the DM, the model reads that thread and nothing else, Show everyone replies in it', async () => {
    const place = { kind: 'dm', dmId: dm.id, threadRootId: dmRoot.id } as const;
    const lines = async (someone: Person) => (await get<Dm>(someone, `/api/v1/dms/${dm.id}`)).messages.filter((item) => item.notice === 'ai_used').length;
    const [hubertLines, kaiLines] = [await lines(hubert), await lines(kai)];
    const started = await ask(place);
    assert.deepEqual([started.run.projectId, started.run.conversationId, started.run.dmId, started.run.dmThreadRootId], [null, null, dm.id, dmRoot.id]);
    assert.deepEqual(Object.values(await row(started.run.id)).slice(0, 4), [null, null, dm.id, dmRoot.id], 'the run is stored with its thread');
    assert.equal((await row(started.run.id)).ai_epoch, null, 'a DM thread has no space, so no AI epoch');

    // Both people see one line, in the DM's conversation where they look; it is not a reply of the thread.
    for (const [someone, before] of [[hubert, hubertLines], [kai, kaiLines]] as const) {
      const view = await get<Dm>(someone, `/api/v1/dms/${dm.id}`);
      const line = view.messages.at(-1)!;
      assert.deepEqual([line.notice, line.body, line.authorId, line.threadRootId], ['ai_used', 'Claude', hubert.id, null], `${someone.email} sees the line`);
      assert.equal(await lines(someone), before + 1);
      assert.equal(((await get<DmThread>(someone, `/api/v1/dms/${dm.id}/threads/${dmRoot.id}`)).replies).some((item) => item.notice), false, 'the thread holds no line');
    }
    await finish(started.run.id);
    const input = sentToTheModel();
    // The model is given this thread: its root and its replies. Not the DM's other messages, another thread, another DM, nor any space.
    for (const given of [TOKENS.dmThread, TOKENS.dmReply]) assert.match(input, new RegExp(given));
    for (const hidden of [TOKENS.dm, TOKENS.otherDmThread, TOKENS.otherDm, TOKENS.space, TOKENS.thread, TOKENS.otherSpace]) assert.equal(input.includes(hidden), false, `the model was given ${hidden}`);
    assert.equal(compute.dispatched.at(-1)!.tools?.length ?? 0, 0, 'no tool reads anything of the owner\'s other places');
    assert.match(compute.dispatched.at(-1)!.system, /in a thread of a direct message[^]*Only pai-hubert\. They may post it with Show everyone, as their own message, for the other people of this direct message/);
    assert.ok(input.startsWith('<place direct_message_with="pai-kai" thread="yes"/>'));

    // The answer is the asker's: Kai cannot read, show or dismiss it, and finds no run in this place; the run is listed in its thread and not in the DM's main line.
    for (const [method, path] of [['GET', ''], ['POST', '/show'], ['POST', '/dismiss']] as const)
      assert.equal((await kai.browser.request(method, `/api/v1/assistant-runs/${started.run.id}${path}`)).status, 404, path);
    assert.equal((await get<Page<AssistantRun>>(kai, `/api/v1/assistant-runs?dmId=${dm.id}&dmThreadRootId=${dmRoot.id}`)).items.length, 0);
    assert.deepEqual((await get<Page<AssistantRun>>(hubert, `/api/v1/assistant-runs?dmId=${dm.id}&dmThreadRootId=${dmRoot.id}`)).items.map((item) => item.id), [started.run.id]);
    assert.equal((await get<Page<AssistantRun>>(hubert, `/api/v1/assistant-runs?dmId=${dm.id}&dmThreadRootId=${otherRoot.id}`)).items.length, 0, 'another thread has not got it');
    assert.equal((await get<Page<AssistantRun>>(hubert, `/api/v1/assistant-runs?dmId=${dm.id}`)).items.some((item) => item.id === started.run.id), false, 'the DM\'s main line has not got it');
    assert.equal((await hubert.browser.request('GET', `/api/v1/assistant-runs?dmThreadRootId=${dmRoot.id}`)).status, 400, 'a thread belongs to a DM');

    // Show everyone: a reply in this thread, "via Assistant", once; the DM's conversation gains no message and the root counts one more reply.
    const mainBefore = (await get<Dm>(kai, `/api/v1/dms/${dm.id}`)).messages.map((item) => item.id);
    const repliesBefore = (await get<DmThread>(kai, `/api/v1/dms/${dm.id}/threads/${dmRoot.id}`)).replies.length;
    const shown = expectStatus(await hubert.browser.request('POST', `/api/v1/assistant-runs/${started.run.id}/show`), 200) as ShowAnswerResult;
    const again = expectStatus(await hubert.browser.request('POST', `/api/v1/assistant-runs/${started.run.id}/show`), 200) as ShowAnswerResult;
    assert.equal(again.messageId, shown.messageId);
    const opened = await get<DmThread>(kai, `/api/v1/dms/${dm.id}/threads/${dmRoot.id}`);
    const message = opened.replies.find((item) => item.id === shown.messageId)!;
    assert.deepEqual([message.authorId, message.via, message.threadRootId], [hubert.id, 'Assistant', dmRoot.id]);
    assert.equal(opened.replies.length, repliesBefore + 1);
    assert.equal(opened.root.replyCount, repliesBefore + 1);
    assert.deepEqual((await get<Dm>(kai, `/api/v1/dms/${dm.id}`)).messages.map((item) => item.id), mainBefore, 'the DM\'s main line gained nothing');
    assert.equal((await get<DmThread>(kai, `/api/v1/dms/${dm.id}/threads/${otherRoot.id}`)).replies.some((item) => item.id === shown.messageId), false);
    assert.equal((await pool.query(`SELECT 1 FROM search_documents WHERE doc_key = $1`, [`dm_message:${started.run.id}`])).rowCount, 0, 'the line is not searchable');

    // The run is the thread's, whoever retries it: a retry stays in the thread and a Dismiss is final there too.
    const retried = await runs.retry(human(hubert), started.run.id, { clientRunId: randomUUID() });
    assert.equal(retried.run.dmThreadRootId, dmRoot.id);
    await finish(retried.run.id);
    assert.equal((await row(retried.run.id)).dm_thread_root_id, dmRoot.id);
    expectStatus(await hubert.browser.request('POST', `/api/v1/assistant-runs/${retried.run.id}/dismiss`), 200);
    assert.equal((await hubert.browser.request('POST', `/api/v1/assistant-runs/${retried.run.id}/show`)).status, 409);
    // Another place with the same client id is another run.
    const clientRunId = randomUUID();
    await runs.invoke(human(hubert), place, { clientRunId, kind: 'ask', prompt: 'Hello' });
    await assert.rejects(runs.invoke(human(hubert), { kind: 'dm', dmId: dm.id, threadRootId: otherRoot.id }, { clientRunId, kind: 'ask', prompt: 'Hello' }), { code: 'IDEMPOTENCY_CONFLICT' });
    await assert.rejects(runs.invoke(human(hubert), { kind: 'dm', dmId: dm.id, threadRootId: null }, { clientRunId, kind: 'ask', prompt: 'Hello' }), { code: 'IDEMPOTENCY_CONFLICT' });
  });

  test('a DM\'s thread has the DM\'s people as its audience: outsiders, other DMs\' messages, replies and lines cannot be a thread; a guest has no AI', async () => {
    const via = (someone: Person, dmId: string, rootId: string) => someone.browser.request('POST', `/api/v1/dms/${dmId}/threads/${rootId}/assistant-runs`, { body: { clientRunId: randomUUID(), kind: 'ask', prompt: 'x' } });
    // A person outside the DM, and a person in the DM, are told the same about a thread they cannot ask in.
    assert.equal((await via(maurycy, dm.id, dmRoot.id)).status, 404, 'someone outside the DM');
    assert.equal((await via(gus, dm.id, dmRoot.id)).status, 404, 'a guest outside the DM');
    // What is no root of this DM is no thread: another DM's message, a reply, the line "used AI here", an id that is no message.
    const reply1 = (await get<DmThread>(hubert, `/api/v1/dms/${dm.id}/threads/${dmRoot.id}`)).replies.find((item) => item.body.includes(TOKENS.dmReply))!;
    const theLine = (await get<Dm>(hubert, `/api/v1/dms/${dm.id}`)).messages.find((item) => item.notice === 'ai_used')!;
    const elsewhere = (await get<Dm>(hubert, `/api/v1/dms/${otherDm.id}`)).messages[0]!;
    for (const [label, rootId] of [['another DM\'s message', elsewhere.id], ['a reply', reply1.id], ['the line', theLine.id], ['nothing', randomUUID()], ['not an id', 'x']] as const) {
      const refused = await via(hubert, dm.id, rootId);
      assert.deepEqual([refused.status, (refused.json as { code: string }).code], [404, 'DM_MESSAGE_NOT_FOUND'], label);
    }
    assert.equal((await via(hubert, otherDm.id, dmRoot.id)).status, 404, 'a root of this DM is no thread of another');
    // A guest has no AI, in a thread of a DM too (AG-2).
    await pool.query(`UPDATE workspace_members SET role = 'guest' WHERE workspace_id = $1 AND user_id = $2`, [ws.id, hubert.id]);
    try {
      await assert.rejects(ask({ kind: 'dm', dmId: dm.id, threadRootId: dmRoot.id }), { code: 'PERSONAL_RUN_NO_AGENT' });
    } finally {
      await pool.query(`UPDATE workspace_members SET role = 'member' WHERE workspace_id = $1 AND user_id = $2`, [ws.id, hubert.id]);
    }
    // Taken out of the DM, the asker can no longer ask in its thread, nor post what they were answered.
    const started = await ask({ kind: 'dm', dmId: dm.id, threadRootId: dmRoot.id });
    await finish(started.run.id);
    expectStatus(await hubert.browser.request('POST', `/api/v1/dms/${dm.id}/leave`), 204, 'leave');
    try {
      assert.equal((await hubert.browser.request('POST', `/api/v1/assistant-runs/${started.run.id}/show`)).status, 404);
      assert.equal((await via(hubert, dm.id, dmRoot.id)).status, 404);
      assert.equal((await row(started.run.id)).shown_at, null);
    } finally {
      await post(hubert, `/api/v1/workspaces/${ws.id}/dms`, { participantIds: [kai.id] }, 200);
    }
  });

  test('the private chat with an agent belongs to no space; it remembers its turns; there is nobody to show it to', async () => {
    const first = await ask({ kind: 'chat', agentId }, `Remember the number ${TOKENS.chat}`);
    assert.deepEqual([first.run.projectId, first.run.conversationId, first.run.dmId, first.run.agentId], [null, null, null, agentId]);
    await finish(first.run.id);
    const second = await ask({ kind: 'chat', agentId }, 'What number was it?');
    await finish(second.run.id);
    assert.match(sentToTheModel(), new RegExp(TOKENS.chat), 'the earlier turn of the chat is told to the model');
    assert.match(compute.dispatched.at(-1)!.system, /pai-hubert is talking to you in your private chat\.[^]*Only pai-hubert: nobody else reads this chat/);
    assert.match(sentToTheModel(), new RegExp(`<chat>\\n<turn from="pai-hubert">Remember the number ${TOKENS.chat}</turn>`));
    const chat = await get<Page<AssistantRun>>(hubert, `/api/v1/assistant-runs?chatAgentId=${agentId}`);
    assert.deepEqual(chat.items.map((item) => item.id), [second.run.id, first.run.id]);
    // The chat's answers are no one else's: not Kai's, not the agent owner's other places.
    assert.equal((await get<Page<AssistantRun>>(kai, `/api/v1/assistant-runs?chatAgentId=${agentId}`)).items.length, 0);
    assert.equal((await kai.browser.request('POST', `/api/v1/my-agents/${agentId}/assistant-runs`, { body: { clientRunId: randomUUID(), kind: 'ask', prompt: 'x' } })).status, 404, 'another person\'s agent is not found');
    const shown = await hubert.browser.request('POST', `/api/v1/assistant-runs/${second.run.id}/show`);
    assert.deepEqual([shown.status, (shown.json as { code: string }).code], [409, 'ASSISTANT_RUN_NOT_SHOWABLE']);
    // "remember that …" adds one memory item, and a retry of that run adds none (AG-1).
    const memories = async () => Number((await pool.query('SELECT count(*)::int AS n FROM agent_memory_items WHERE agent_id = $1', [agentId])).rows[0].n);
    const before = await memories();
    const remembered = await ask({ kind: 'chat', agentId }, `remember that the lamp is blue ${randomUUID()}`);
    await finish(remembered.run.id);
    assert.equal(await memories(), before + 1);
    await runs.retry(human(hubert), remembered.run.id, { clientRunId: randomUUID() });
    assert.equal(await memories(), before + 1, 'a retry does not remember it again');
    // The same id and the same words are one run; another place is another run.
    const clientRunId = randomUUID();
    const one = await runs.invoke(human(hubert), { kind: 'chat', agentId }, { clientRunId, kind: 'ask', prompt: 'Hello' });
    assert.equal((await runs.invoke(human(hubert), { kind: 'chat', agentId }, { clientRunId, kind: 'ask', prompt: 'Hello' })).run.id, one.run.id);
    await assert.rejects(runs.invoke(human(hubert), thread.id, { clientRunId, kind: 'ask', prompt: 'Hello' }), { code: 'IDEMPOTENCY_CONFLICT' });
  });

  test('a guest has no AI, someone outside the space cannot ask in it, and losing the place stops Show everyone', async () => {
    // A guest has no agent to ask; an agent a person had before becoming a guest is refused (AG-2).
    await assert.rejects(runs.invoke(human(gus), { kind: 'dm', dmId: dm.id, threadRootId: null }, { clientRunId: randomUUID(), kind: 'ask', prompt: 'x' }), { code: 'DM_NOT_FOUND' });
    assert.equal((await gus.browser.request('POST', `/api/v1/conversations/${thread.id}/assistant-runs`, { body: { clientRunId: randomUUID(), kind: 'ask', prompt: 'x' } })).status, 404);
    assert.equal((await maurycy.browser.request('POST', `/api/v1/conversations/${thread.id}/assistant-runs`, { body: { clientRunId: randomUUID(), kind: 'ask', prompt: 'x' } })).status, 404);

    const started = await ask(thread.id);
    await finish(started.run.id);
    await pool.query(`UPDATE workspace_members SET role = 'guest' WHERE workspace_id = $1 AND user_id = $2`, [ws.id, hubert.id]);
    try {
      await assert.rejects(ask(thread.id, 'Again'), { code: 'PERSONAL_RUN_NO_AGENT' });
      await assert.rejects(runs.invoke(human(hubert), { kind: 'chat', agentId }, { clientRunId: randomUUID(), kind: 'ask', prompt: 'x' }), { code: 'PERSONAL_RUN_NO_AGENT' });
    } finally {
      await pool.query(`UPDATE workspace_members SET role = 'member' WHERE workspace_id = $1 AND user_id = $2`, [ws.id, hubert.id]);
    }
    // Taken out of the space, the asker can no longer post what they were answered.
    const grants = await get<{ id: string; principal: { id: string } }[]>(ada, `/api/v1/projects/${lamp.id}/grants`);
    const hers = grants.find((item) => item.principal.id === hubert.id)!;
    expectStatus(await ada.browser.request('DELETE', `/api/v1/projects/${lamp.id}/grants/${hers.id}`), 204);
    try {
      assert.equal((await hubert.browser.request('POST', `/api/v1/assistant-runs/${started.run.id}/show`)).status, 404);
      assert.equal((await row(started.run.id)).shown_at, null);
    } finally {
      await grant(ada, lamp.id, hubert, 'contributor');
    }
  });

  test('an agent says something on its own in its chat: posted once, unread until its owner opens the chat, nobody else\'s', async () => {
    const started = await ask({ kind: 'chat', agentId }, 'Say hello');
    await finish(started.run.id);
    await runs.readAgentChat(human(hubert), agentId);
    const unread = async () => (await runs.agentChats(human(hubert))).find((item) => item.agentId === agentId)!.unread;
    assert.equal(await unread(), 0, 'opening the chat reads it');

    const post = (key: string, body: string, runId = started.run.id) => personalRunWorkerUnitOfWork(db).run((ports) => postToAgentChat(ports, { agentId, runId, key, body }));
    const live = await StreamClient.connect(hubert.browser);
    await live.ready();
    const line = (await post('report:4', 'Done: #4 Calibrate the probes · 3 changes'))!;
    assert.equal((await post('report:4', 'Done: #4 Calibrate the probes · 3 changes'))!.id, line.id, 'a report tried twice posts once');
    assert.equal(await unread(), 1);
    assert.deepEqual((await runs.agentChatMessages(human(hubert), agentId)).map((item) => item.body), ['Done: #4 Calibrate the probes · 3 changes']);
    await live.until(() => live.events.find((event) => event.kind === 'assistant_run.changed.v1' && event.objectId === started.run.id), 8000, 'the owner is told the chat changed');
    await live.close();

    // A chat answer that arrives after the owner read counts too, and a token-shaped string never gets into a line.
    const later = await ask({ kind: 'chat', agentId }, 'And now?');
    await finish(later.run.id);
    assert.equal(await unread(), 2);
    assert.equal((await post('report:5', 'Key sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789 stays out'))!.body.includes('sk-ant-'), false);
    await runs.readAgentChat(human(hubert), agentId);
    assert.equal(await unread(), 0);

    // Only the owner: another person has no such chat, and a run of another agent is no report of this one.
    await assert.rejects(runs.agentChatMessages(human(kai), agentId), { code: 'AGENT_NOT_FOUND' });
    await assert.rejects(runs.readAgentChat(human(kai), agentId), { code: 'AGENT_NOT_FOUND' });
    assert.deepEqual(await runs.agentChats(human(kai)), []);
    // A report is about a run of that agent, wherever the run was (a task's run is in a space); empty words say nothing.
    const inSpace = await ask(thread.id);
    assert.equal((await post('report:space', 'Stopped by Maja', inSpace.run.id))?.runId, inSpace.run.id);
    assert.equal(await post('report:empty', '   '), null);
    assert.equal(await post('report:nobody', 'x', randomUUID()), null);
  });

  test('attack: nobody can label their own words "via Assistant", forge the line "used AI here", or post through someone else\'s answer', async () => {
    // The schemas drop what a message does not take (or refuse it): either way the words stay plain, and no label or line is made.
    const labelled = await kai.browser.request('POST', `/api/v1/conversations/${thread.id}/messages`, { body: { body: 'Looks official', clientMessageId: randomUUID(), via: 'Assistant' } });
    assert.ok([201, 400].includes(labelled.status), labelled.text);
    const forged = await kai.browser.request('POST', `/api/v1/dms/${dm.id}/messages`, { body: { body: 'Claude', clientMessageId: randomUUID(), kind: 'ai_used', via: 'Assistant' } });
    assert.ok([201, 400].includes(forged.status), forged.text);
    const read = await get<Conversation>(hubert, `/api/v1/conversations/${thread.id}`);
    assert.deepEqual(read.messages.filter((message) => message.body === 'Looks official').map((message) => message.via ?? null), labelled.status === 201 ? [null] : []);
    const dmView = await get<Dm>(hubert, `/api/v1/dms/${dm.id}`);
    assert.equal(dmView.messages.filter((message) => message.authorId === kai.id && (message.notice || message.via)).length, 0, 'no forged line or label');
    const started = await ask(thread.id, 'Something to show');
    await finish(started.run.id);
    // Kai cannot show, dismiss or read Hubert's answer, and Hubert's answer is not in any conversation until Hubert shows it.
    for (const [method, path] of [['POST', 'show'], ['POST', 'dismiss'], ['GET', '']] as const)
      assert.equal((await kai.browser.request(method, `/api/v1/assistant-runs/${started.run.id}${path ? `/${path}` : ''}`)).status, 404, path);
    const before = (await get<Conversation>(kai, `/api/v1/conversations/${thread.id}`)).messages.length;
    assert.equal((await get<Conversation>(hubert, `/api/v1/conversations/${thread.id}`)).messages.length, before);
    await runs.invoke(human(hubert), thread.id, { clientRunId: randomUUID(), kind: 'ask', prompt: 'x' });
    assert.equal((await get<Conversation>(kai, `/api/v1/conversations/${thread.id}`)).messages.length, before, 'asking posts nothing');
  });

  test('echo keeps the fake provider honest', () => {
    assert.equal(compute.respond, echo);
  });
});
