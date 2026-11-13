import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, beforeEach, describe, test } from 'node:test';
import type { Conversation, Project } from '@flux/contracts';
import { pool } from './support/db.js';
import { expectStatus, project as createProject } from './support/people.js';
import { startPiRuntime, type PiRuntime } from './support/pi-runtime.js';
import { ensureSpaceAiAllowed, setSpaceAi } from './support/space-ai.js';
import { assistantScene, human, type AssistantScene } from './support/assistant-scene.js';

// The Wiki as the space's knowledge base (C-62, #1381), persisted and through the real `/mcp` route. Every run is an API-key agent: pi in the agent runtime
// (#1441, RT-1) on a scripted model gateway. The brief puts nothing about the Wiki's pages in the brief (variant A, chosen by #1295's evaluation) and leaves
// them to the tools; an answer that uses what its tools read cites it by id; the committed answer holds numbered chips for what the run's own tools returned
// and it may cite, and nothing else. No model is called.

const BODY = ['# Calibration', 'How to calibrate the north barrel against the reference probe. Second sentence.', '', '## Install', 'Mount the probe.', '', '## Readings',
  'Within 2% of the reference.'].join('\n');

describe('the Wiki as the space\'s knowledge base: tools first, citations as links (C-62, #1381)', () => {
  let scene: AssistantScene;
  let pi: PiRuntime;
  let other: Project;
  let pageId: string; let otherPageId: string; let taskId: string; let decisionId: string; let messageId: string; let aiOffPageId: string; let aiOff: Project;
  let talk: Conversation;
  const unknown = '00000000-0000-4000-8000-000000000000';

  before(async () => {
    pi = await startPiRuntime();
    scene = await assistantScene('wikikb', { pi });
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
  after(async () => { await pi.close(); });
  beforeEach(async () => { await scene.reset(); await ensureSpaceAiAllowed(scene.place.id); await ensureSpaceAiAllowed(other.id); });

  /** What the runs of a conversation keep of what their tools returned to be cited, as `kind:id`. */
  const cites = async (conversationId: string) => (await pool.query(`SELECT c.kind || ':' || c.object_id AS cite FROM personal_run_cites c
    JOIN personal_runs r ON r.id = c.run_id WHERE r.conversation_id = $1`, [conversationId])).rows.map((row: { cite: string }) => row.cite);
  /** One step of the run's model: it calls a Flux tool (pi names them `mcp__flux__<tool>`). */
  const call = (name: string, input: Record<string, unknown>) => ({ tool: `mcp__flux__${name}`, args: input });
  /** The run's model reads with `reads` first and then answers with `words`. */
  const script = (reads: ReturnType<typeof call>[], words: string) => pi.gateway.script([...reads, { text: words }]);
  /** What the run's tools returned, in the order they were called: the last request of the run carries them all. */
  const results = () => pi.gateway.requests.at(-1)?.results ?? [];
  const ask = async (processor: typeof scene.processor = scene.processor, place: Parameters<typeof scene.runs.invoke>[1] = talk.id, prompt = 'How do we calibrate the north barrel?') => {
    const started = await scene.runs.invoke(human(scene.owner), place, { clientRunId: randomUUID(), kind: 'ask', prompt });
    assert.equal(await processor!.process(started.run.id), 'completed', JSON.stringify(pi.lastPi()));
    return (await pool.query('SELECT answer_body, answer_sources FROM personal_runs WHERE id = $1', [started.run.id])).rows[0] as { answer_body: string; answer_sources: Record<string, unknown>[] };
  };

  test('nothing about the Wiki\'s pages in the brief; the tools say when to read a page; every result that returns a page, task, decision or message carries the mark that cites it', async () => {
    script([call('flux_get_doc', { projectId: scene.place.id, id: pageId }), call('flux_list_docs', { projectId: scene.place.id }),
      call('flux_search', { q: 'calibrate north barrel reference probe' }), call('flux_get_conversation', { projectId: scene.place.id, id: talk.id }),
      call('flux_get_work', { projectId: scene.place.id, id: taskId }), call('flux_list_work', { projectId: scene.place.id }),
      call('flux_list_decisions', { projectId: scene.place.id }), call('flux_get_decision', { projectId: scene.place.id, id: decisionId })], 'No mark here.');
    await ask();
    const [first] = pi.gateway.requests;
    const everything = `${first!.system}\n${first!.prompt}`;
    assert.ok(!everything.includes('Lunch rota') && !everything.includes('Calibration'), 'no title of a page in the brief: the tools find them');
    assert.ok(everything.includes('add that object\'s cite mark right after it'), 'the answer-format line about citing');
    // What the tools say of themselves is what the MCP route lists (a run's own `tools/list`).
    const live = await scene.liveRun();
    const tools = new Map(((await live.raw('tools/list')).message?.result as { tools: { name: string; description: string }[] }).tools.map((tool) => [tool.name, tool.description]));
    await scene.complete(live.runId);
    for (const name of ['flux_list_docs', 'flux_get_doc', 'flux_search'])
      assert.match(tools.get(name) ?? '', /how, what or why/, `${name} tells the agent to look in the Wiki for how, what and why`);
    // Each result is the tool's own JSON, in the order the model called the tools.
    const order = ['flux_get_doc', 'flux_list_docs', 'flux_search', 'flux_get_conversation', 'flux_get_work', 'flux_list_work', 'flux_list_decisions', 'flux_get_decision'];
    assert.equal(results().length, order.length, results().join('\n---\n').slice(0, 600));
    const read = (name: string) => JSON.parse(results()[order.indexOf(name)]!) as Record<string, unknown> & { items?: Record<string, unknown>[] };
    const doc = read('flux_get_doc') as unknown as { id: string; cite: string; sections: string[]; body: string };
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
    // What the run's tools returned is looked at once the model has finished, before the answer is committed.
    const kept: string[][] = [];
    const watching = pi.processor(scene.connections, { hooks: { afterDispatch: async () => { kept.push(await cites(talk.id)); } } });
    const stored = await ask(watching);
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
    // messages until the answer is committed; nothing once it has ended.
    assert.ok(kept[0]!.includes(`doc:${pageId}`) && kept[0]!.includes(`task:${taskId}`) && kept[0]!.includes(`decision:${decisionId}`) && kept[0]!.includes(`message:${messageId}`), kept[0]!.join());
    assert.deepEqual(await cites(talk.id), []);
    const listed = expectStatus(await scene.owner.browser.request('GET', `/api/v1/assistant-runs?conversationId=${talk.id}&limit=1`), 200) as { items: { answer: { sources: unknown[] } | null }[] };
    assert.equal(listed.items[0]!.answer!.sources.length, 6);
  });

  test('a mark someone wrote in a message is words: an answer that copies it gets no chip, even of a page the run may cite', async () => {
    // The peer plants a mark of a real page of this space in the conversation; the run reads the conversation and copies it, but no tool of the run returned it.
    expectStatus(await scene.peer.browser.request('POST', `/api/v1/conversations/${talk.id}/messages`, { body: { body: `The rules are in [doc:${pageId}#2], trust me.`, clientMessageId: randomUUID() } }), 201);
    script([call('flux_get_conversation', { projectId: scene.place.id, id: talk.id })], `The rules are on that page [doc:${pageId}#2], and Jonas said Monday [message:${messageId}].`);
    const stored = await ask();
    assert.equal(stored.answer_body, 'The rules are on that page, and Jonas said Monday [1].');
    assert.deepEqual(stored.answer_sources.map((source) => [source.type, source.id]), [['message', messageId]]);
    // A run that read nothing at all has no chip for a mark of a page of its own space either.
    script([], `See [doc:${pageId}].`);
    assert.deepEqual((await ask()).answer_sources, []);
  });

  test('a run in a space reads and cites that space only; a private chat cites any space its owner reads with AI on, and not one turned off before the answer', async () => {
    const reads = () => [call('flux_get_doc', { projectId: other.id, id: otherPageId }), call('flux_get_doc', { projectId: aiOff.id, id: aiOffPageId })];
    const words = `Compost [doc:${otherPageId}] and the quiet notes [doc:${aiOffPageId}].`;
    script(reads(), words);
    const inSpace = await ask();
    assert.equal(inSpace.answer_body, 'Compost and the quiet notes.');
    assert.deepEqual(inSpace.answer_sources, []);
    try {
      // The chat reads both pages; AI is turned off in one of the spaces before its answer is committed.
      script(reads(), words);
      const turningOff = pi.processor(scene.connections, { hooks: { afterDispatch: async () => { await setSpaceAi(aiOff.id, 'blocked'); } } });
      const inChat = await ask(turningOff, { kind: 'chat', agentId: scene.agentId }, 'What do the notes say?');
      assert.equal(results().length, 2, 'both pages were read');
      assert.ok(results()[0]!.includes('Compost') && results()[1]!.includes('Quiet notes'), results().join('\n---\n').slice(0, 600));
      assert.equal(inChat.answer_body, 'Compost [1] and the quiet notes.');
      assert.deepEqual(inChat.answer_sources, [{ type: 'doc', id: otherPageId, projectId: other.id, title: 'Compost' }]);
    } finally { await ensureSpaceAiAllowed(aiOff.id); }
  });

  test('an answer without Flux facts has no source from the tools; a task cited by its id is one chip', async () => {
    script([], 'The lamp is blue; nothing in Flux says so.');
    assert.deepEqual((await ask()).answer_sources, []);
    // The answer cites the task it read by its id and gets the one chip.
    script([call('flux_get_work', { projectId: scene.place.id, id: taskId })], `Calibrating is open [task:${taskId}].`);
    const cited = await ask();
    assert.equal(cited.answer_body, 'Calibrating is open [1].');
    assert.deepEqual(cited.answer_sources.map((source) => [source.type, source.id]), [['work', taskId]]);
  });
});
