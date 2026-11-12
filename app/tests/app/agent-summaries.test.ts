import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, beforeEach, describe, test } from 'node:test';
import { ENCRYPTED_WORKSPACES_PATH, type Conversation, type CreateEncryptedWorkspaceResult } from '@flux/contracts';
import { inBatches } from './support/batches.js';
import { pool } from './support/db.js';
import { passphrase } from './support/encryption.js';
import { agentConnection, toolFailure } from './support/mcp-actions.js';
import { addMember, expectStatus, grant, person, removeFromSpace, type Person } from './support/people.js';
import { ensureSpaceAiAllowed, setSpaceAi } from './support/space-ai.js';
import { assistantScene, human, text, type AssistantScene, type Message } from './support/assistant-scene.js';

// F-042, AG-12, #1292: `flux_summarize` reads one place since a date as a compact digest that the calling agent summarises itself. It is the
// same tool for the server engine (a run token) and for the owner's Claude Code or Codex (an OAuth client), and it makes no model call of
// its own: the summary is the agent's work in its own run, which its owner pays for as for any other run. Nothing is stored. What it reads is
// what the caller may read at the moment of the call: the owner's rights, the space's AI switch, a message still there and as it was last written,
// a direct message only in a run in it, and an encrypted space never.

const rename = (who: Person, name: string) => pool.query('UPDATE auth_users SET name = $1 WHERE id = $2', [name, who.id]);
const value = (message: Message) => JSON.parse(text(message)) as Digest;
interface Digest { place: { type: string; id: string; space?: string }; after: string; before?: string; messages: number; complete: boolean; digest?: string; remaining?: number; next?: string; note: string }
const lines = (answer: Digest) => (answer.digest ?? '').split('\n').filter(Boolean);
const failure = (message: Message) => toolFailure(message as Record<string, unknown>);

describe('flux_summarize: a place since a date, on both engines, only what the caller may read now (#1292)', () => {
  let scene: AssistantScene;
  let talk: Conversation; // the scene's thread, the run's own place
  let camera: Conversation; // another thread of the space
  let barrel: { id: string; number: number; version: number }; // a task with a discussion
  let silent: { id: string }; // a task with none
  const say = async (who: Person, conversation: Conversation, body: string, when?: string) => {
    const sent = expectStatus(await who.browser.request('POST', `/api/v1/conversations/${conversation.id}/messages`, { body: { body, clientMessageId: randomUUID() } }), 201) as { id: string };
    if (when) await pool.query('UPDATE project_messages SET created_at = $2 WHERE id = $1', [sent.id, when]);
    return sent;
  };
  const open = async (who: Person, body: string, when: string) => {
    const made = expectStatus(await who.browser.request('POST', `/api/v1/projects/${scene.place.id}/conversations`, { body: { body, clientMessageId: randomUUID() } }), 201) as Conversation;
    await pool.query('UPDATE project_messages SET created_at = $2 WHERE conversation_id = $1 AND sequence = 1', [made.id, when]);
    return made;
  };
  const rows = async () => (await pool.query(`SELECT (SELECT count(*)::int FROM project_messages WHERE workspace_id = $1) AS messages,
    (SELECT count(*)::int FROM dm_messages WHERE workspace_id = $1) AS dms, (SELECT count(*)::int FROM assistant_changes WHERE project_id = $2) AS changes,
    (SELECT count(*)::int FROM personal_runs WHERE owner_user_id = $3) AS runs, (SELECT count(*)::int FROM search_documents WHERE workspace_id = $1) AS indexed`,
  [scene.ws.id, scene.place.id, scene.owner.id])).rows[0] as Record<string, number>;
  /** A run of the owner's assistant in this thread: the server's engine, its calls through the real `/mcp` route. */
  const run = async (conversation = talk) => scene.liveRun(conversation, 'Catch me up');
  const summarize = async (live: Awaited<ReturnType<typeof run>>, args: Record<string, unknown>) => value((await live.call('flux_summarize', args)).message);

  before(async () => {
    scene = await assistantScene('summary');
    for (const [who, name] of [[scene.owner, 'Ada Nowak'], [scene.peer, 'Jonas Berg'], [scene.viewer, 'Vera Lis'], [scene.outsider, 'Olek Mur'], [scene.lead, 'Lea Lead']] as const) await rename(who, name);
    talk = scene.thread;
    await pool.query('UPDATE project_messages SET created_at = $2 WHERE conversation_id = $1 AND sequence = 1', [talk.id, '2026-11-01T09:00:00Z']);
    await say(scene.peer, talk, 'I can take the barrel tasks.', '2026-11-02T10:02:00Z');
    await say(scene.owner, talk, 'Great, the deadline is Friday.', '2026-11-03T08:30:00Z');
    await say(scene.peer, talk, 'Done: barrel tasks tidied.', '2026-11-04T16:45:00Z');
    camera = await open(scene.peer, 'Camera or sensor for the bedside lamp?', '2026-11-02T12:00:00Z');
    await say(scene.viewer, camera, 'Sensor, the camera fails at night.', '2026-11-02T12:05:00Z');
    barrel = await scene.task(scene.peer, 'Tidy the barrel tasks');
    silent = await scene.task(scene.peer, 'Nobody has said anything about this');
    const discussion = async (who: Person, body: string, when: string) => {
      const sent = expectStatus(await who.browser.request('POST', `/api/v1/work/${barrel.id}/discussion`, { body: { body, clientMessageId: randomUUID() } }), 201) as { id: string };
      await pool.query('UPDATE project_messages SET created_at = $2 WHERE id = $1', [sent.id, when]);
    };
    await discussion(scene.peer, 'Blocked on the lid seal.', '2026-11-03T09:00:00Z');
    await discussion(scene.owner, 'Order the seal today.', '2026-11-03T09:10:00Z');
  });
  beforeEach(async () => { await scene.reset(); scene.compute.dispatched.length = 0; await ensureSpaceAiAllowed(scene.place.id); });
  after(async () => { await ensureSpaceAiAllowed(scene.place.id); });

  test('a thread since a date: oldest first, one line each, authors as people see them; the end is exclusive; nothing is stored and no model is called', async () => {
    const live = await run();
    const before = await rows();
    const answer = await summarize(live, { after: '2026-11-02' });
    assert.deepEqual(lines(answer), ['## 2026-11-02', '10:02 Jonas Berg: I can take the barrel tasks.', '## 2026-11-03', '08:30 Ada Nowak: Great, the deadline is Friday.',
      '## 2026-11-04', '16:45 Jonas Berg: Done: barrel tasks tidied.']);
    assert.deepEqual([answer.place.type, answer.place.id, answer.place.space, answer.messages, answer.complete], ['thread', talk.id, 'Lamp sensor', 3, true], 'the run\'s own thread, as it was not named');
    assert.match(answer.note, /Summarise them now/);
    assert.equal(answer.remaining, undefined);
    assert.equal(answer.after, '2026-11-02T00:00:00.000Z');
    const ended = await summarize(live, { after: '2026-11-02T10:02:00Z', before: '2026-11-04' });
    assert.deepEqual(lines(ended), ['## 2026-11-02', '10:02 Jonas Berg: I can take the barrel tasks.', '## 2026-11-03', '08:30 Ada Nowak: Great, the deadline is Friday.'], 'a message at the start is in, the end is out');
    assert.equal(ended.before, '2026-11-04T00:00:00.000Z');
    const empty = await summarize(live, { after: '2026-12-01' });
    assert.deepEqual([empty.messages, empty.complete, empty.digest], [0, true, undefined]);
    assert.match(empty.note, /No messages in this range/);
    assert.deepEqual(await rows(), before, 'no message, change, run or summary is made');
    assert.equal(scene.compute.dispatched.length, 0, 'and the tool calls no model: the summary is the agent\'s own work in its own run');
    await scene.complete(live.runId);
  });

  test('a space is all its conversations with a heading for each thread; a task\'s discussion is not among them', async () => {
    const live = await run();
    const answer = await summarize(live, { in: scene.place.id, after: '2026-11-02', before: '2026-11-03' });
    assert.equal(answer.place.type, 'space');
    assert.deepEqual(lines(answer), ['## 2026-11-02', '# thread “Please tidy the sensor tasks”', '10:02 Jonas Berg: I can take the barrel tasks.',
      '# thread “Camera or sensor for the bedside lamp?”', '12:00 Jonas Berg: Camera or sensor for the bedside lamp?', '12:05 Vera Lis: Sensor, the camera fails at night.']);
    const all = await summarize(live, { in: scene.place.id, after: '2026-11-03', before: '2026-11-04' });
    assert.ok(!JSON.stringify(all).includes('lid seal'), 'the discussion of a task lives in the task');
    await scene.complete(live.runId);
  });

  test('a task is its discussion, by the task or by its conversation; a task nobody has spoken about has nothing', async () => {
    const live = await run();
    const answer = await summarize(live, { in: barrel.id, after: '2026-11-01' });
    assert.equal(answer.place.type, 'task');
    assert.deepEqual(lines(answer), ['## 2026-11-03', '09:00 Jonas Berg: Blocked on the lid seal.', '09:10 Ada Nowak: Order the seal today.']);
    const discussion = expectStatus(await scene.owner.browser.request('GET', `/api/v1/work/${barrel.id}/discussion`), 200) as { conversationId: string };
    assert.deepEqual(lines(await summarize(live, { in: discussion.conversationId, after: '2026-11-01' })), lines(answer), 'the same read through its conversation');
    const none = await summarize(live, { in: silent.id, after: '2026-11-01' });
    assert.deepEqual([none.place.type, none.messages, none.complete], ['task', 0, true]);
    await scene.complete(live.runId);
  });

  test('a long range comes in answers that fit a run: it says it stopped early, and its next goes on without a gap or a repeat', async () => {
    const long = await open(scene.peer, 'Long running check-in', '2026-10-01T08:00:00Z');
    const written = await inBatches(44, (index) => say(scene.peer, long, `Entry ${String(index + 1).padStart(2, '0')} ${'z'.repeat(470)}`));
    assert.equal(written.length, 44);
    const live = await run(long);
    const seen: string[] = [];
    let next: string | undefined;
    let pages = 0;
    for (;;) {
      const answer = await summarize(live, { after: '2026-10-01', ...(next ? { next } : {}) });
      pages += 1;
      assert.ok((answer.digest ?? '').length <= 16_000, 'an answer is at most 16,000 characters');
      seen.push(...lines(answer).filter((line) => /: Entry \d\d /.test(line)).map((line) => /Entry (\d\d) /.exec(line)![1]!));
      if (answer.complete) { assert.equal(answer.next, undefined); assert.match(answer.note, /Summarise them now/); break; }
      assert.ok(answer.next && answer.remaining! > 0, 'it says how many are left and how to go on');
      assert.match(answer.note, new RegExp(`Stopped early: this answer ends at .* and ${answer.remaining} later messages? (is|are) not in it`));
      next = answer.next;
      assert.ok(pages < 6, 'it ends');
    }
    assert.ok(pages >= 2, `${pages} answers for 45 messages of 480 characters`);
    // The root message ("Long running check-in") is the first line; the 44 entries follow, each once.
    assert.equal(seen.length, 44);
    assert.equal(new Set(seen).size, 44, 'no repeat');
    assert.deepEqual([...seen].sort(), Array.from({ length: 44 }, (_, index) => String(index + 1).padStart(2, '0')), 'and no gap');
    await scene.complete(live.runId);
  });

  test('only what is still there and as it was last written: a removed message, an edited one and someone who left', async () => {
    const thread = await open(scene.peer, 'Fresh words', '2026-11-05T08:00:00Z');
    await say(scene.peer, thread, 'Kept as written.', '2026-11-05T08:01:00Z');
    const edited = await say(scene.peer, thread, 'First wording of the plan.', '2026-11-05T08:02:00Z');
    const removed = await say(scene.peer, thread, 'A secret nobody should read.', '2026-11-05T08:03:00Z');
    const leaver = await person('summary-leaver');
    await rename(leaver, 'Gerd Gone');
    await addMember(scene.lead, scene.ws.id, leaver, 'member');
    await grant(scene.lead, scene.place.id, leaver, 'contributor');
    await say(leaver, thread, 'I promised the stamp.', '2026-11-05T08:04:00Z');
    const live = await run(thread);
    const first = await summarize(live, { after: '2026-11-05' });
    assert.ok(lines(first).includes('08:03 Jonas Berg: A secret nobody should read.'));
    expectStatus(await scene.peer.browser.request('PATCH', `/api/v1/conversations/${thread.id}/messages/${edited.id}`, { body: { body: 'Second wording of the plan.' } }), 200);
    const gone = await scene.peer.browser.request('DELETE', `/api/v1/conversations/${thread.id}/messages/${removed.id}`);
    assert.ok(gone.status === 200 || gone.status === 204, gone.text);
    await removeFromSpace(scene.lead, scene.place.id, leaver);
    const now = await summarize(live, { after: '2026-11-05' });
    assert.deepEqual(lines(now), ['## 2026-11-05', '08:00 Jonas Berg: Fresh words', '08:01 Jonas Berg: Kept as written.', '08:02 Jonas Berg: Second wording of the plan.', '08:04 Former member: I promised the stamp.']);
    assert.ok(!JSON.stringify(now).includes('secret') && !JSON.stringify(now).includes('First wording') && !JSON.stringify(now).includes('Gerd'), 'not the removed words, not the old wording, not the name of a person who left');
    await scene.complete(live.runId);
  });

  test('the owner\'s rights and the space\'s AI switch at the moment of the call: a lost grant and AI turned off are the answer of a place that is not there', async () => {
    const live = await run();
    assert.equal((await summarize(live, { after: '2026-11-02' })).messages, 3);
    await setSpaceAi(scene.place.id, 'blocked');
    for (const args of [{ after: '2026-11-02' }, { in: scene.place.id, after: '2026-11-02' }, { in: barrel.id, after: '2026-11-02' }]) {
      const refused = failure((await live.call('flux_summarize', args)).message);
      assert.equal(refused.code, 'PLACE_NOT_FOUND', JSON.stringify(args));
      for (const words of ['barrel', 'Jonas', 'lid seal', 'Lamp sensor']) assert.ok(!JSON.stringify(refused).includes(words), `${words} is not told`);
    }
    await ensureSpaceAiAllowed(scene.place.id);
    assert.equal((await summarize(live, { after: '2026-11-02' })).messages, 3, 'and again once it is on');
    await removeFromSpace(scene.lead, scene.place.id, scene.owner);
    try {
      const refused = failure((await live.call('flux_summarize', { after: '2026-11-02' })).message);
      assert.equal(refused.code, 'PLACE_NOT_FOUND');
      assert.ok(!JSON.stringify(refused).includes('barrel'));
    } finally { await grant(scene.lead, scene.place.id, scene.owner, 'manager'); }
    assert.equal((await summarize(live, { after: '2026-11-02' })).messages, 3, 'the grant is back');
    await scene.complete(live.runId);
  });

  test('a direct message is read only inside a run in it, by its own people; nothing else is reachable from there, and nothing reaches it from elsewhere', async () => {
    const opened = await scene.owner.browser.request('POST', `/api/v1/workspaces/${scene.ws.id}/dms`, { body: { participantIds: [scene.peer.id] } });
    assert.ok(opened.status === 201 || opened.status === 200, opened.text);
    const dmId = (opened.json as { id: string }).id;
    const post = async (who: Person, body: string, when: string) => {
      const sent = expectStatus(await who.browser.request('POST', `/api/v1/dms/${dmId}/messages`, { body: { body, clientMessageId: randomUUID() } }), 201) as { id: string };
      await pool.query('UPDATE dm_messages SET created_at = $2 WHERE id = $1', [sent.id, when]);
    };
    await post(scene.owner, 'Can you send me the invoice?', '2026-11-06T07:00:00Z');
    await post(scene.peer, 'Sure, tonight.', '2026-11-06T07:05:00Z');
    const started = await scene.runs.invoke(human(scene.owner), { kind: 'dm', dmId, threadRootId: null }, { clientRunId: randomUUID(), kind: 'ask', prompt: 'Catch me up' });
    const inDm = await scene.liveOf(started.run.id);
    assert.deepEqual(inDm.tools.slice().sort(), ['flux_read_around', 'flux_read_web', 'flux_search', 'flux_summarize'], 'a run in a direct message is minted the tool');
    const answer = await summarize(inDm, { after: '2026-11-06' });
    assert.deepEqual([answer.place.type, answer.place.id], ['dm', dmId]);
    assert.deepEqual(lines(answer), ['## 2026-11-06', '07:00 Ada Nowak: Can you send me the invoice?', '07:05 Jonas Berg: Sure, tonight.']);
    assert.equal((await summarize(inDm, { in: dmId, after: '2026-11-06' })).messages, 2, 'it may name its own direct message');
    for (const place of [scene.place.id, talk.id, barrel.id, randomUUID()]) assert.equal(failure((await inDm.call('flux_summarize', { in: place, after: '2026-11-01' })).message).code, 'PLACE_NOT_FOUND', place);
    // Not from a run in a space, and not from the owner's own client, whoever asks for its id.
    const inSpace = await run();
    assert.equal(failure((await inSpace.call('flux_summarize', { in: dmId, after: '2026-11-01' })).message).code, 'PLACE_NOT_FOUND', 'a run in a space');
    const code = (expectStatus(await scene.owner.browser.request('POST', `/api/v1/workspaces/${scene.ws.id}/agents`, { body: { name: 'Claude Code', owner: 'self' } }), 201) as { id: string }).id;
    const client = await agentConnection(pool, scene.owner.browser, code, [scene.place.id]);
    assert.equal(failure(await client.tool('flux_summarize', { in: dmId, after: '2026-11-01' })).code, 'PLACE_NOT_FOUND', 'the owner\'s own client');
    // The run in it ends reading when its owner is no longer one of its people.
    expectStatus(await scene.owner.browser.request('POST', `/api/v1/dms/${dmId}/leave`), 204);
    assert.equal(failure((await inDm.call('flux_summarize', { after: '2026-11-06' })).message).code, 'PLACE_NOT_FOUND', 'after its owner left');
    await scene.complete(inSpace.runId);
    await scene.complete(started.run.id);
  });

  test('the owner\'s Claude Code or Codex reads the same digest; it must say where, and what it asks is checked', async () => {
    const code = (expectStatus(await scene.owner.browser.request('POST', `/api/v1/workspaces/${scene.ws.id}/agents`, { body: { name: 'Codex', owner: 'self' } }), 201) as { id: string }).id;
    const client = await agentConnection(pool, scene.owner.browser, code, [scene.place.id]);
    assert.ok((await client.toolNames()).includes('flux_summarize'), 'a client is offered the tool');
    const live = await run();
    for (const args of [{ in: talk.id, after: '2026-11-02' }, { in: scene.place.id, after: '2026-11-02', before: '2026-11-04' }, { in: barrel.id, after: '2026-11-01' }]) {
      const viaClient = value(await client.tool('flux_summarize', args));
      const viaRun = await summarize(live, args);
      assert.deepEqual(lines(viaClient), lines(viaRun), JSON.stringify(args));
      assert.deepEqual([viaClient.place, viaClient.complete, viaClient.messages], [viaRun.place, viaRun.complete, viaRun.messages]);
    }
    assert.equal(failure(await client.tool('flux_summarize', { after: '2026-11-02' })).code, 'PLACE_REQUIRED', 'a client that names no place is told to');
    for (const [args, code] of [[{ in: talk.id, after: 'yesterday' }, 'INVALID_TIME'], [{ in: talk.id, after: '2026-11-03', before: '2026-11-02' }, 'INVALID_TIME'],
      [{ in: talk.id, after: '2026-11-02', next: 'x' }, 'INVALID_CURSOR'], [{ in: randomUUID(), after: '2026-11-02' }, 'PLACE_NOT_FOUND']] as const)
      assert.equal(failure(await client.tool('flux_summarize', args)).code, code, JSON.stringify(args));
    assert.equal(scene.compute.dispatched.length, 0, 'no model is called for any of it');
    await scene.complete(live.runId);
  });

  test('an encrypted space is refused: its words never reach the tool, and nothing is told about it', async () => {
    await pool.query('DELETE FROM encrypted_workspace_creations WHERE user_id = $1', [scene.owner.id]);
    const sealed = expectStatus(await scene.owner.browser.request('POST', ENCRYPTED_WORKSPACES_PATH,
      { body: { creationId: randomUUID(), password: passphrase(), companyId: scene.ws.id, name: 'Secret contracts' } }), 201) as CreateEncryptedWorkspaceResult;
    const place = sealed.project!;
    const secret = expectStatus(await scene.owner.browser.request('POST', `/api/v1/projects/${place.id}/conversations`,
      { body: { body: 'Sealed words about the merger', clientMessageId: randomUUID() }, headers: { 'idempotency-key': randomUUID() } }), 201) as Conversation;
    const code = (expectStatus(await scene.owner.browser.request('POST', `/api/v1/workspaces/${scene.ws.id}/agents`, { body: { name: 'Claude Code', owner: 'self' } }), 201) as { id: string }).id;
    const client = await agentConnection(pool, scene.owner.browser, code, [scene.place.id]);
    const live = await run();
    for (const args of [{ in: place.id, after: '2020-01-01' }, { in: secret.id, after: '2020-01-01' }]) {
      for (const message of [await client.tool('flux_summarize', args), (await live.call('flux_summarize', args)).message]) {
        const refused = failure(message);
        assert.equal(refused.code, 'PLACE_NOT_FOUND', JSON.stringify(args));
        for (const words of ['Sealed words', 'merger', 'Secret contracts']) assert.ok(!JSON.stringify(refused).includes(words), `${words}: ${refused.error}`);
      }
    }
    await scene.complete(live.runId);
  });
});
