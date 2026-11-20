import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { before, beforeEach, describe, test } from 'node:test';
import { dmAiOffPath, dmPath, pinPath, pinsPath, type Conversation, type Dm, type PinnedMessages, type PinPlace, type Project, type SearchResponse } from '@flux/contracts';
import { pool } from './support/db.js';
import { apiUrl } from './support/http.js';
import { createSealed, lock, passphrase } from './support/encryption.js';
import { toolValue } from './support/mcp.js';
import { expectStatus, type Person } from './support/people.js';
import { assistantScene, human, result, type AssistantScene, type Message } from './support/assistant-scene.js';

// C-74 (#1615, founder decision 2026-11-20): a pin belongs to the conversation and everyone in it sees the same list. Whoever may write pins and
// unpins (a guest too); a reader sees the list without pinning; someone outside sees nothing; agents never pin and read the list with
// `flux_list_pinned` under their run's reach. A deleted message leaves the list, an edited one stays, a lost access hides it, an encrypted
// space stores no words in a pin, and a pinned message is marked and first among the messages of a search, people's and an agent's.

const word = (stem: string) => `${stem}${randomUUID().replace(/-/g, '').slice(0, 10)}`;
const refused = (message: Message) => !!message?.error || result(message)?.isError === true;
type PinnedTool = { place: { type: string; id: string }; pinned: { messageId: string; body: string; pinnedBy: string; inThread?: true }[]; note?: string };
type Hit = { kind: string; id: string; pinned?: true };

describe('pinned messages (C-74, #1615)', () => {
  let scene: AssistantScene;
  let ada: Person; let jonas: Person;
  const space = (): PinPlace => ({ type: 'project', id: scene.place.id });
  const list = async (who: Person, place: PinPlace) => expectStatus(await who.browser.request('GET', pinsPath(place)), 200) as PinnedMessages;
  const pin = (who: Person, place: PinPlace, messageId: string, part?: 'prompt' | 'answer') => who.browser.request('PUT', pinPath(place, messageId, part));
  const unpin = (who: Person, place: PinPlace, messageId: string, part?: 'prompt' | 'answer') => who.browser.request('DELETE', pinPath(place, messageId, part));
  const start = async (who: Person, body: string) => expectStatus(await who.browser.request('POST', `/api/v1/projects/${scene.place.id}/conversations`,
    { body: { body, clientMessageId: randomUUID() } }), 201) as Conversation;
  const reply = async (who: Person, conversationId: string, body: string) => expectStatus(await who.browser.request('POST', `/api/v1/conversations/${conversationId}/messages`,
    { body: { body, clientMessageId: randomUUID() } }), 201) as { id: string };
  const openDm = async () => {
    const opened = await ada.browser.request('POST', `/api/v1/workspaces/${scene.ws.id}/dms`, { body: { participantIds: [jonas.id] } });
    assert.ok(opened.status === 200 || opened.status === 201, opened.text);
    return opened.json as Dm;
  };
  const events = async (kind: string, objectId: string) => Number((await pool.query('SELECT count(*)::int AS n FROM events WHERE kind = $1 AND object_id::text = $2', [kind, objectId])).rows[0].n);

  before(async () => {
    scene = await assistantScene('pins');
    ada = scene.owner; jonas = scene.peer;
  });
  beforeEach(async () => { await scene.reset(); await pool.query('DELETE FROM message_pins WHERE workspace_id = $1', [scene.ws.id]); });

  test('a writer pins and unpins; everyone in the space reads one list; pinning twice changes nothing; an outsider sees nothing', async () => {
    const words = word('gateway');
    const root = await start(jonas, `Gateway login ${words}`);
    const message = root.messages[0]!.id;
    const answer = expectStatus(await pin(ada, space(), message), 200) as PinnedMessages;
    assert.deepEqual(answer.items.map((item) => [item.messageId, item.pinnedBy.id, item.author.id, item.body]), [[message, ada.id, jonas.id, `Gateway login ${words}`]]);
    assert.equal(answer.items[0]!.conversationId, root.id);
    assert.equal(answer.items[0]!.threadRootId, undefined, 'a root is not in a thread');
    // The same list for every reader, the guest who may write too.
    for (const who of [jonas, scene.guest, scene.viewer]) assert.deepEqual((await list(who, space())).items.map((item) => item.messageId), [message]);
    // Twice is once: one row and one event.
    expectStatus(await pin(jonas, space(), message), 200);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM message_pins WHERE project_message_id = $1', [message])).rows[0].n, 1);
    assert.equal(await events('project.pins_changed.v1', scene.place.id), 1);
    // No notification, no Inbox item, no line in the conversation.
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM notifications WHERE url LIKE $1`, [`%${message}%`])).rows[0].n, 0);
    assert.equal((expectStatus(await ada.browser.request('GET', `/api/v1/conversations/${root.id}`), 200) as Conversation).messages.length, 1);
    // An outsider: the space's 404, for the list and for a pin.
    assert.equal((await scene.stranger.browser.request('GET', pinsPath(space()))).status, 404);
    assert.equal((await pin(scene.stranger, space(), message)).status, 404);
    // The guest unpins someone else's pin: a pin is the conversation's.
    assert.deepEqual((expectStatus(await unpin(scene.guest, space(), message), 200) as PinnedMessages).items, []);
    expectStatus(await unpin(scene.guest, space(), message), 200);
    assert.equal(await events('project.pins_changed.v1', scene.place.id), 2, 'an unpin of what is not pinned records nothing');
    // A message of another conversation, or none, is not found.
    assert.equal((await pin(ada, space(), randomUUID())).status, 404);
  });

  test('a reply in a thread is "in a thread"; an edit keeps the pin, a delete takes it; a lost access hides the list', async () => {
    const root = await start(ada, word('rota'));
    const answer = await reply(jonas, root.id, `Watering rota ${word('swap')}`);
    const pinned = expectStatus(await pin(ada, space(), answer.id), 200) as PinnedMessages;
    assert.equal(pinned.items[0]!.threadRootId, root.messages[0]!.id);
    expectStatus(await jonas.browser.request('PATCH', `/api/v1/conversations/${root.id}/messages/${answer.id}`, { body: { body: 'Watering rota, edited' } }), 200);
    assert.equal((await list(ada, space())).items[0]!.body, 'Watering rota, edited', 'an edited message stays pinned with its new words');
    expectStatus(await jonas.browser.request('DELETE', `/api/v1/conversations/${root.id}/messages/${answer.id}`), 200);
    assert.deepEqual((await list(ada, space())).items, [], 'a deleted message leaves the list');
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM message_pins WHERE project_message_id = $1', [answer.id])).rows[0].n, 0);
    assert.equal((await pin(ada, space(), answer.id)).status, 404, 'a deleted message cannot be pinned');
    // Someone whose grant goes sees nothing of the space's pins.
    const kept = await start(ada, word('kept'));
    expectStatus(await pin(ada, space(), kept.messages[0]!.id), 200);
    const grant = (await pool.query('DELETE FROM project_grants WHERE project_id = $1 AND user_id = $2 RETURNING *', [scene.place.id, scene.viewer.id])).rows[0] as Record<string, unknown>;
    try {
      assert.equal((await scene.viewer.browser.request('GET', pinsPath(space()))).status, 404);
      assert.equal((await unpin(scene.viewer, space(), kept.messages[0]!.id)).status, 404);
    } finally {
      const columns = Object.keys(grant);
      await pool.query(`INSERT INTO project_grants (${columns.join(', ')}) VALUES (${columns.map((_, index) => `$${index + 1}`).join(', ')})`, columns.map((column) => grant[column]));
    }
  });

  test('a pinned message is marked and first among the messages of people\'s search and of flux_search', async () => {
    const key = word('probe');
    const first = await start(jonas, `${key} capacitive probes ordered`);
    const second = await start(jonas, `${key} probes and more probes, probes everywhere`);
    const pinned = second.messages[0]!.id;
    expectStatus(await pin(ada, space(), pinned), 200);
    const found = expectStatus(await ada.browser.request('GET', `/api/v1/search?q=${encodeURIComponent(key)}`), 200) as SearchResponse;
    const messages = found.items.filter((item) => item.kind === 'message');
    assert.equal(messages[0]!.id, `message:${pinned}`, JSON.stringify(messages.map((item) => item.id)));
    assert.equal(messages[0]!.pinned, true);
    assert.ok(messages.some((item) => item.id === `message:${first.messages[0]!.id}` && !item.pinned), 'the other is not marked');
    const live = await scene.liveRun();
    const hits = (toolValue((await live.call('flux_search', { q: key })).message) as unknown as { results: Hit[] }).results.filter((hit) => hit.kind === 'message');
    assert.deepEqual([hits[0]!.id, hits[0]!.pinned], [pinned, true], JSON.stringify(hits));
    assert.ok(hits.some((hit) => hit.id === first.messages[0]!.id && !hit.pinned));
    await scene.complete(live.runId);
  });

  test('agents never pin and read the list with flux_list_pinned under their run\'s reach', async () => {
    const root = await start(jonas, `Shed key ${word('box')}`);
    const message = root.messages[0]!.id;
    expectStatus(await pin(jonas, space(), message), 200);
    const live = await scene.liveRun();
    assert.ok(live.tools.includes('flux_list_pinned'));
    assert.deepEqual(live.tools.filter((name) => /pin/.test(name)), ['flux_list_pinned'], 'no tool pins');
    const listed = toolValue((await live.call('flux_list_pinned', { in: scene.place.id })).message) as unknown as PinnedTool;
    assert.deepEqual([listed.place.type, listed.place.id, listed.pinned.map((item) => [item.messageId, item.pinnedBy])], ['space', scene.place.id, [[message, (await pool.query('SELECT name FROM auth_users WHERE id = $1', [jonas.id])).rows[0].name]]]);
    // The run's bearer token is no session: the HTTP route refuses it.
    const viaToken = await fetch(new URL(pinPath(space(), message), apiUrl), { method: 'PUT', headers: { authorization: `Bearer ${live.token}` } });
    assert.ok(viaToken.status === 401 || viaToken.status === 403, `a run token pins nothing: ${viaToken.status}`);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM message_pins WHERE project_message_id = $1', [message])).rows[0].n, 1);
    // A space run reaches no direct message.
    const opened = await openDm();
    assert.ok(refused((await live.call('flux_list_pinned', { in: opened.id })).message));
    await scene.complete(live.runId);
    // With the space's AI off, nothing of it.
    const chat = await scene.liveOf((await scene.runs.invoke(human(ada), { kind: 'chat', agentId: scene.agentId }, { clientRunId: randomUUID(), kind: 'ask', prompt: 'What is pinned?' })).run.id);
    assert.equal((toolValue((await chat.call('flux_list_pinned', { in: scene.place.id })).message) as unknown as PinnedTool).pinned.length, 1, 'a private chat reaches the space');
    await pool.query(`UPDATE project_ai_policies SET state = 'blocked' WHERE project_id = $1`, [scene.place.id]);
    try { assert.ok(refused((await chat.call('flux_list_pinned', { in: scene.place.id })).message), 'nor a space whose AI is off'); }
    finally { await pool.query(`UPDATE project_ai_policies SET state = 'allowed' WHERE project_id = $1`, [scene.place.id]); }
    await scene.complete(chat.runId);
  });

  test('a direct message: its people pin, a reader of a 1:1 whose other person left only reads, AI off keeps the list from every agent', async () => {
    const opened = await openDm();
    const place: PinPlace = { type: 'dm', id: opened.id };
    const words = `Invoice ${word('fv')}`;
    const message = (expectStatus(await jonas.browser.request('POST', `${dmPath(opened.id)}/messages`, { body: { body: words, clientMessageId: randomUUID() } }), 201) as { id: string }).id;
    expectStatus(await pin(ada, place, message), 200);
    assert.deepEqual((await list(jonas, place)).items.map((item) => [item.messageId, item.body, item.pinnedBy.id]), [[message, words, ada.id]]);
    assert.equal(await events('dm.pins_changed.v1', opened.id), 1);
    assert.equal((await scene.outsider.browser.request('GET', pinsPath(place))).status, 404);
    assert.equal((await pin(scene.outsider, place, message)).status, 404);
    // Ada's agent in her private chat reads the list while AI is on; not once Jonas turns it off.
    const chat = await scene.liveOf((await scene.runs.invoke(human(ada), { kind: 'chat', agentId: scene.agentId }, { clientRunId: randomUUID(), kind: 'ask', prompt: 'What did we pin?' })).run.id);
    const listed = toolValue((await chat.call('flux_list_pinned', { in: opened.id })).message) as unknown as PinnedTool;
    assert.deepEqual([listed.place.type, listed.pinned.map((item) => item.body)], ['dm', [words]]);
    expectStatus(await jonas.browser.request('PUT', dmAiOffPath(opened.id)), 200);
    try {
      const off = (await chat.call('flux_list_pinned', { in: opened.id })).message;
      assert.ok(refused(off) && !JSON.stringify(off).includes(words), JSON.stringify(off));
    } finally { expectStatus(await jonas.browser.request('DELETE', dmAiOffPath(opened.id)), 200); }
    await scene.complete(chat.runId);
    // Jonas leaves: Ada still reads the list of her 1:1, but it takes no new messages, so she pins and unpins nothing.
    await pool.query('DELETE FROM dm_participants WHERE dm_id = $1 AND user_id = $2', [opened.id, jonas.id]);
    try {
      assert.equal((await list(ada, place)).items.length, 1);
      const refusedPin = await unpin(ada, place, message);
      assert.equal(refusedPin.status, 403);
      assert.equal((refusedPin.json as { code: string }).code, 'PIN_NOT_ALLOWED');
    } finally { await pool.query('INSERT INTO dm_participants (workspace_id, dm_id, user_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [scene.ws.id, opened.id, jonas.id]); }
    // The delete of the message takes its pin.
    expectStatus(await jonas.browser.request('DELETE', `${dmPath(opened.id)}/messages/${message}`), 200);
    assert.deepEqual((await list(ada, place)).items, []);
  });

  test('an agent\'s chat is its owner\'s: their request and its answer are pinned apart; nobody else reads it', async () => {
    const place: PinPlace = { type: 'agent', id: scene.agentId };
    const started = await scene.runs.invoke(human(ada), { kind: 'chat', agentId: scene.agentId }, { clientRunId: randomUUID(), kind: 'ask', prompt: 'Remember the shed code' });
    const runId = started.run.id;
    assert.equal((await pin(ada, place, runId, 'answer')).status, 404, 'no answer yet');
    assert.equal((await pin(ada, place, runId)).status, 404, 'a run is named with its part');
    expectStatus(await pin(ada, place, runId, 'prompt'), 200);
    await pool.query(`UPDATE personal_runs SET status = 'completed', completed_at = now(), committed_at = now(), answer_body = 'Done', cost_state = 'released', charged_micros = 0 WHERE id = $1`, [runId]);
    const both = expectStatus(await pin(ada, place, runId, 'answer'), 200) as PinnedMessages;
    assert.deepEqual(both.items.map((item) => [item.part, item.author.kind, item.body]), [['answer', 'agent', 'Done'], ['prompt', 'human', 'Remember the shed code']]);
    assert.equal(await events('person.pins_changed.v1', ada.id), 2);
    for (const who of [jonas, scene.lead]) {
      assert.equal((await who.browser.request('GET', pinsPath(place))).status, 404);
      assert.equal((await pin(who, place, runId, 'prompt')).status, 404);
    }
    expectStatus(await unpin(ada, place, runId, 'prompt'), 200);
    assert.deepEqual((await list(ada, place)).items.map((item) => item.part), ['answer']);
  });

  test('an encrypted space: pinning works, the pin holds no words, the list opens them while unlocked, and a locked one refuses', async () => {
    const password = passphrase();
    const sealed = await createSealed(ada, 'Pinned vault', password);
    expectStatus(await ada.browser.request('POST', `/api/v1/workspaces/${sealed.workspace.id}/members`, { body: { email: jonas.email, role: 'member' } }), 201);
    const vault = expectStatus(await ada.browser.request('POST', `/api/v1/workspaces/${sealed.workspace.id}/projects`, { body: { name: 'Vault', visibility: 'workspace' } }), 201) as Project;
    const words = word('sealedpin');
    const root = expectStatus(await jonas.browser.request('POST', `/api/v1/projects/${vault.id}/conversations`, { body: { body: words, clientMessageId: randomUUID() } }), 201) as Conversation;
    const place: PinPlace = { type: 'project', id: vault.id };
    expectStatus(await pin(ada, place, root.messages[0]!.id), 200);
    assert.deepEqual((await list(jonas, place)).items.map((item) => item.body), [words], 'the list shows the words, opened as the stream opens them');
    const row = (await pool.query('SELECT to_jsonb(p) AS row FROM message_pins p WHERE project_message_id = $1', [root.messages[0]!.id])).rows[0].row as Record<string, unknown>;
    assert.ok(!JSON.stringify(row).includes(words), 'the pin holds ids, the pinner and the time only');
    // No agent reaches it: Ada's private chat neither lists the vault's pins nor finds the pinned message.
    const chat = await scene.liveOf((await scene.runs.invoke(human(ada), { kind: 'chat', agentId: scene.agentId }, { clientRunId: randomUUID(), kind: 'ask', prompt: 'What is pinned in the vault?' })).run.id);
    const listed = (await chat.call('flux_list_pinned', { in: vault.id })).message;
    assert.ok(refused(listed) && !JSON.stringify(listed).includes(words), JSON.stringify(listed));
    const searched = (await chat.call('flux_search', { q: words })).message;
    assert.ok(!refused(searched) && !JSON.stringify(searched).includes(words), JSON.stringify(searched));
    await scene.complete(chat.runId);
    expectStatus(await lock(ada.browser, sealed.workspace.id), 200);
    assert.equal((await ada.browser.request('GET', pinsPath(place))).status, 423);
  });
});
