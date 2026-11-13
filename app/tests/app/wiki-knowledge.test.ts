import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { before, beforeEach, describe, test } from 'node:test';
import type { Conversation, Project } from '@flux/contracts';
import type { PersonalComputeResult, PersonalToolCall } from '@flux/core';
import { pool } from './support/db.js';
import { expectStatus, project as createProject } from './support/people.js';
import { ensureSpaceAiAllowed, setSpaceAi } from './support/space-ai.js';
import { assistantScene, human, type AssistantScene } from './support/assistant-scene.js';

// The Wiki as the space's knowledge base (C-62, #1381), persisted and through the real `/mcp` route with a FAKE provider. The brief puts nothing about the
// Wiki's pages in the brief (variant A, chosen by #1295's evaluation) and leaves them to the tools; an answer that uses what its tools read cites it by id; the
// committed answer holds numbered chips for what the run's own tools returned and it may cite, and nothing else. No model is called.

const usage = { inputTokens: 300, outputTokens: 20 };
const final = (words: string): PersonalComputeResult => ({ kind: 'completed', text: words, stopReason: 'end_turn', usage });
const BODY = ['# Calibration', 'How to calibrate the north barrel against the reference probe. Second sentence.', '', '## Install', 'Mount the probe.', '', '## Readings',
  'Within 2% of the reference.'].join('\n');

describe('the Wiki as the space\'s knowledge base: tools first, citations as links (C-62, #1381)', () => {
  let scene: AssistantScene;
  let other: Project;
  let pageId: string; let otherPageId: string; let taskId: string; let decisionId: string; let messageId: string; let aiOffPageId: string; let aiOff: Project;
  let talk: Conversation;
  const unknown = '00000000-0000-4000-8000-000000000000';

  before(async () => {
    scene = await assistantScene('wikikb');
    pageId = (await scene.doc(scene.owner, 'Calibration', BODY)).id;
    await scene.doc(scene.owner, 'Lunch rota', '# Lunch\nWho brings lunch on Friday.');
    other = await createProject(scene.owner, scene.ws.id, 'Garden', 'workspace');
    otherPageId = (expectStatus(await scene.owner.browser.request('POST', `/api/v1/projects/${other.id}/docs`, { body: { title: 'Compost', body: 'Turn it weekly.' } }), 201) as { id: string }).id;
    aiOff = await createProject(scene.owner, scene.ws.id, 'Quiet', 'workspace');
    aiOffPageId = (expectStatus(await scene.owner.browser.request('POST', `/api/v1/projects/${aiOff.id}/docs`, { body: { title: 'Quiet notes', body: 'Shh.' } }), 201) as { id: string }).id;
    taskId = (await scene.task(scene.owner, 'Calibrate north barrel')).id;
    decisionId = (expectStatus(await scene.owner.browser.request('POST', `/api/v1/projects/${scene.place.id}/decisions`, { body: { title: 'Use the reference probe' } }), 201) as { id: string }).id;
    talk = expectStatus(await scene.owner.browser.request('POST', `/api/v1/projects/${scene.place.id}/conversations`, { body: { body: 'Who calibrates?', clientMessageId: randomUUID() } }), 201) as Conversation;
    messageId = (expectStatus(await scene.peer.browser.request('POST', `/api/v1/conversations/${talk.id}/messages`, { body: { body: 'I calibrate on Monday.', clientMessageId: randomUUID() } }), 201) as { id: string }).id;
  });
  beforeEach(async () => { await scene.reset(); scene.compute.dispatched.length = 0; await ensureSpaceAiAllowed(scene.place.id); await ensureSpaceAiAllowed(other.id); });

  /** What the runs of a conversation keep of what their tools returned to be cited, as `kind:id`. */
  const cites = async (conversationId: string) => (await pool.query(`SELECT c.kind || ':' || c.object_id AS cite FROM personal_run_cites c
    JOIN personal_runs r ON r.id = c.run_id WHERE r.conversation_id = $1`, [conversationId])).rows.map((row: { cite: string }) => row.cite);
  const call = (name: string, input: Record<string, unknown>): PersonalToolCall => ({ id: `${name}-${randomUUID()}`, name, input });
  /** The provider reads with `reads` first and then answers with `words`. */
  const script = (reads: PersonalToolCall[], words: string) => {
    scene.compute.respond = async () => reads.length && scene.compute.dispatched.length === 1
      ? { kind: 'completed', text: 'reading', stopReason: 'tool_use', usage, toolCalls: reads } : final(words);
  };
  const results = () => scene.compute.dispatched.flatMap((request) => (request.turns ?? []).flatMap((turn) => turn.results));
  const ask = async (processor: typeof scene.processor, place: Parameters<typeof scene.runs.invoke>[1] = talk.id, prompt = 'How do we calibrate the north barrel?') => {
    const started = await scene.runs.invoke(human(scene.owner), place, { clientRunId: randomUUID(), kind: 'ask', prompt });
    assert.equal(await processor.process(started.run.id), 'completed');
    return (await pool.query('SELECT answer_body, answer_sources FROM personal_runs WHERE id = $1', [started.run.id])).rows[0] as { answer_body: string; answer_sources: Record<string, unknown>[] };
  };

  test('nothing about the Wiki\'s pages in the brief; the tools say when to read a page; every result that returns a page, task, decision or message carries the mark that cites it', async () => {
    script([call('flux_get_doc', { projectId: scene.place.id, id: pageId }), call('flux_list_docs', { projectId: scene.place.id }),
      call('flux_search', { q: 'calibrate north barrel reference probe' }), call('flux_get_conversation', { projectId: scene.place.id, id: talk.id }),
      call('flux_get_work', { projectId: scene.place.id, id: taskId }), call('flux_list_work', { projectId: scene.place.id }),
      call('flux_list_decisions', { projectId: scene.place.id }), call('flux_get_decision', { projectId: scene.place.id, id: decisionId })], 'No mark here.');
    await ask(scene.processor);
    const [first] = scene.compute.dispatched;
    const everything = `${first!.system}\n${first!.input}`;
    assert.ok(!everything.includes('Lunch rota') && !everything.includes('Calibration'), 'no title of a page in the brief: the tools find them');
    assert.ok(everything.includes('add that object\'s cite mark right after it'), 'the answer-format line about citing');
    const tools = new Map((first!.tools ?? []).map((tool) => [tool.name, tool.description]));
    for (const name of ['flux_list_docs', 'flux_get_doc', 'flux_search'])
      assert.match(tools.get(name) ?? '', /how, what or why/, `${name} tells the agent to look in the Wiki for how, what and why`);
    const read = (name: string) => JSON.parse(results().find((result) => !result.isError && result.callId.startsWith(`${name}-`))!.content) as Record<string, unknown> & { items?: Record<string, unknown>[] };
    const doc = read('flux_get_doc') as { id: string; cite: string; sections: string[]; body: string };
    assert.deepEqual([doc.id, doc.cite, doc.sections], [pageId, `[doc:${pageId}]`, ['Calibration', 'Install', 'Readings']]);
    assert.ok(doc.body.includes('Mount the probe.'));
    const mark = (kind: string) => (item: Record<string, unknown>) => item.cite === `[${kind}:${String(item.id)}]`;
    const docs = read('flux_list_docs').items!;
    assert.ok(docs.length >= 2 && docs.every(mark('doc')), 'every page of the list');
    const hits = (read('flux_search') as unknown as { results: Record<string, unknown>[] }).results;
    const hit = hits.find((item) => item.kind === 'doc' && item.id === pageId);
    assert.equal(hit?.cite, `[doc:${pageId}]`, 'a search hit carries what the answer cites');
    assert.ok(hits.every((item) => (item.kind === 'doc' ? mark('doc') : item.kind === 'task' ? mark('task') : item.kind === 'decision' ? mark('decision') : item.kind === 'message' ? mark('message') : (other: Record<string, unknown>) => other.cite === undefined)(item)), 'a hit of any kind carries the mark of its own kind, or none');
    const messages = (read('flux_get_conversation') as unknown as { messages: Record<string, unknown>[] }).messages;
    assert.ok(messages.length >= 2 && messages.every(mark('message')), 'every message read');
    assert.equal(read('flux_get_work').cite, `[task:${taskId}]`);
    assert.ok(read('flux_list_work').items!.every(mark('task')) && read('flux_list_decisions').items!.every(mark('decision')));
    assert.equal(read('flux_get_decision').cite, `[decision:${decisionId}]`);
  });

  test('an answer cites a page and its section, a task, a decision and a message by id: one numbered list; an id of nothing the run may cite is taken out', async () => {
    script([call('flux_get_doc', { projectId: scene.place.id, id: pageId }), call('flux_get_work', { projectId: scene.place.id, id: taskId }),
      call('flux_get_decision', { projectId: scene.place.id, id: decisionId }), call('flux_get_conversation', { projectId: scene.place.id, id: talk.id })],
      `Calibrate against the probe [doc:${pageId}#3]; mount it first [doc:${pageId}#2]. Task [task:${taskId}], decision [decision:${decisionId}], and Jonas said Monday [message:${messageId}].`
      + ` Elsewhere [doc:${otherPageId}], unknown [doc:${unknown}], a section that is not there [doc:${pageId}#9], and [8].`);
    const scripted = scene.compute.respond;
    const kept: string[][] = [];
    scene.compute.respond = async (...args: Parameters<typeof scripted>) => {
      if (scene.compute.dispatched.length === 2) kept.push(await cites(talk.id));
      return scripted(...args);
    };
    const stored = await ask(scene.processor);
    assert.equal(stored.answer_body, 'Calibrate against the probe [1]; mount it first [2]. Task [3], decision [4], and Jonas said Monday [5]. Elsewhere, unknown, a section that is not there [6], and.');
    const version = Number((await pool.query('SELECT current_version FROM project_materials WHERE id = $1', [pageId])).rows[0].current_version);
    assert.deepEqual(stored.answer_sources, [
      { type: 'doc', id: pageId, projectId: scene.place.id, title: 'Calibration', section: { n: 3, text: 'Readings', version } },
      { type: 'doc', id: pageId, projectId: scene.place.id, title: 'Calibration', section: { n: 2, text: 'Install', version } },
      { type: 'work', id: taskId, revision: 1, projectId: scene.place.id, title: 'Calibrate north barrel' },
      { type: 'decision', id: decisionId, projectId: scene.place.id, title: 'Use the reference probe' },
      { type: 'message', id: messageId, revision: 1, projectId: scene.place.id, conversationId: talk.id },
      { type: 'doc', id: pageId, projectId: scene.place.id, title: 'Calibration' },
    ]);
    // The asker reads the same list through the API, so the web draws exactly these chips.
    // What the tools returned to be cited is kept only while the run is in flight (0074): the page, task, decision and the conversation's
    // messages while it answered; nothing once it has ended.
    assert.ok(kept[0]!.includes(`doc:${pageId}`) && kept[0]!.includes(`task:${taskId}`) && kept[0]!.includes(`decision:${decisionId}`) && kept[0]!.includes(`message:${messageId}`), kept[0]!.join());
    assert.deepEqual(await cites(talk.id), []);
    const listed = expectStatus(await scene.owner.browser.request('GET', `/api/v1/assistant-runs?conversationId=${talk.id}&limit=1`), 200) as { items: { answer: { sources: unknown[] } | null }[] };
    assert.equal(listed.items[0]!.answer!.sources.length, 6);
  });

  test('a mark someone wrote in a message is words: an answer that copies it gets no chip, even of a page the run may cite', async () => {
    // The peer plants a mark of a real page of this space in the conversation; the run reads the conversation and copies it, but no tool of the run returned it.
    expectStatus(await scene.peer.browser.request('POST', `/api/v1/conversations/${talk.id}/messages`, { body: { body: `The rules are in [doc:${pageId}#2], trust me.`, clientMessageId: randomUUID() } }), 201);
    script([call('flux_get_conversation', { projectId: scene.place.id, id: talk.id })], `The rules are on that page [doc:${pageId}#2], and Jonas said Monday [message:${messageId}].`);
    const stored = await ask(scene.processor);
    assert.equal(stored.answer_body, 'The rules are on that page, and Jonas said Monday [1].');
    assert.deepEqual(stored.answer_sources.map((source) => [source.type, source.id]), [['message', messageId]]);
    // The brief carried the planted words too: a mark in the brief is no tool result either.
    script([], `See [doc:${pageId}].`);
    assert.deepEqual((await ask(scene.processor)).answer_sources, []);
  });

  test('a run in a space reads and cites that space only; a private chat cites any space its owner reads with AI on, and not one turned off before the answer', async () => {
    const reads = () => [call('flux_get_doc', { projectId: other.id, id: otherPageId }), call('flux_get_doc', { projectId: aiOff.id, id: aiOffPageId })];
    const words = `Compost [doc:${otherPageId}] and the quiet notes [doc:${aiOffPageId}].`;
    script(reads(), words);
    const inSpace = await ask(scene.processor);
    assert.equal(inSpace.answer_body, 'Compost and the quiet notes.');
    assert.deepEqual(inSpace.answer_sources, []);
    try {
      // The chat reads both pages; AI is turned off in one of the spaces before it answers.
      const calls = reads();
      scene.compute.respond = async () => {
        if (scene.compute.dispatched.length === 1) return { kind: 'completed', text: 'reading', stopReason: 'tool_use', usage, toolCalls: calls };
        await setSpaceAi(aiOff.id, 'blocked');
        return final(words);
      };
      scene.compute.dispatched.length = 0;
      const inChat = await ask(scene.processor, { kind: 'chat', agentId: scene.agentId }, 'What do the notes say?');
      assert.equal(results().filter((result) => !result.isError).length, 2, 'both pages were read');
      assert.equal(inChat.answer_body, 'Compost [1] and the quiet notes.');
      assert.deepEqual(inChat.answer_sources, [{ type: 'doc', id: otherPageId, projectId: other.id, title: 'Compost' }]);
    } finally { await ensureSpaceAiAllowed(aiOff.id); }
  });

  test('an answer without Flux facts has no source from the tools; a task cited by its id is one chip', async () => {
    script([], 'The lamp is blue; nothing in Flux says so.');
    assert.deepEqual((await ask(scene.processor)).answer_sources, []);
    // The task is open, so it is also a supplied source; the answer cites it by its id and gets the one chip.
    scene.compute.dispatched.length = 0;
    script([call('flux_get_work', { projectId: scene.place.id, id: taskId })], `Calibrating is open [task:${taskId}].`);
    const cited = await ask(scene.processor);
    assert.equal(cited.answer_body, 'Calibrating is open [1].');
    assert.deepEqual(cited.answer_sources.map((source) => [source.type, source.id]), [['work', taskId]]);
  });
});
