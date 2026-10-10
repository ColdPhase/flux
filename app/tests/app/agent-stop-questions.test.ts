import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { Agent, AgentQuestion, AgentQuestions, AgentStop, AgentStops, Conversation, OwnWorkingAgents, WorkItem } from '@flux/contracts';
import { pool } from './support/db.js';
import { Browser, type ClientResponse } from './support/http.js';
import { agentConnection, toolFailure } from './support/mcp-actions.js';
import { toolValue } from './support/mcp.js';
import { addMember, expectStatus, grant, person, project, workspace, type Person } from './support/people.js';
import { waitFor } from './support/push.js';

type Reply = ClientResponse & { json: { code?: string; id?: string; answer?: { messageId: string } } };

// An agent's question with ready answers (S14) and a person's Stop of an agent's work on a task (S13), #347.
// docs/product/mcp-cowork.md "Stop and questions". A server fixture over real sessions and OAuth bearers.
async function scene() {
  const hubert = await person('Hubert'), marek = await person('Marek'), ada = await person('Ada'), eve = await person('Eve');
  const ws = await workspace(hubert, 'Stop and questions');
  for (const member of [marek, ada, eve]) await addMember(hubert, ws.id, member, 'member');
  const p = await project(hubert, ws.id, 'Heated bed', 'restricted');
  await grant(hubert, p.id, marek, 'contributor');
  await grant(hubert, p.id, ada, 'contributor');
  await grant(hubert, p.id, eve, 'viewer');
  const agent = expectStatus(await hubert.browser.request('POST', `/api/v1/workspaces/${ws.id}/agents`, { body: { name: 'Hubert Claude', owner: 'self' } }), 201) as Agent;
  expectStatus(await hubert.browser.request('POST', `/api/v1/projects/${p.id}/grants`, { body: { principal: { kind: 'agent', id: agent.id }, role: 'contributor' } }), 201);
  const connected = await agentConnection(pool, hubert.browser, agent.id, [p.id]);
  const run = (role: 'execute' | 'plan' = 'execute') => ({ projectId: p.id, runtimeSessionId: connected.runtimeSessionId, peerRequestClass: role });
  const task = async (who = hubert, title = 'Calibrate the bed') =>
    expectStatus(await who.browser.request('POST', `/api/v1/projects/${p.id}/work`, { body: { title } }), 201) as WorkItem;
  /** The agent takes the task over MCP: a unit it claims, and the task is handed to it and started. */
  const work = async (item: WorkItem) => {
    const create = await connected.grant('cowork.unit.create', 'execute', 5, item.id);
    const unit = toolValue(await connected.tool('flux_create_unit', { ...run(), grantId: create.id, clientCommandId: randomUUID(), taskId: item.id, unitKey: 'take',
      expectedTaskVersion: item.version, assignmentConnectionId: connected.connectionId, parent: null })) as { unitId: string; version: number };
    const claimGrant = await connected.grant('cowork.claim', 'execute', 5, unit.unitId);
    const claim = toolValue(await connected.tool('flux_claim_unit', { ...run(), grantId: claimGrant.id, clientCommandId: randomUUID(), unitId: unit.unitId,
      expectedVersion: unit.version })) as { generation: number; version: number; lease: { id: string } };
    expectStatus(await hubert.browser.request('PATCH', `/api/v1/work/${item.id}`, { body: { owner: { kind: 'agent', id: agent.id }, status: 'in_progress' },
      headers: { 'if-match': `"${item.version}"` } }), 200);
    return { unitId: unit.unitId, claim };
  };
  const stop = (who: Person, taskId: string, headers: Record<string, string> = {}): Promise<Reply> =>
    who.browser.request('POST', `/api/v1/projects/${p.id}/agent-stops`, { body: { taskId, agentId: agent.id }, headers }) as Promise<Reply>;
  const taskRow = async (id: string) => (await pool.query('SELECT status, owner_agent_id, owner_user_id, version FROM project_work_items WHERE id=$1', [id])).rows[0];
  const unitRow = async (id: string) => (await pool.query('SELECT state, generation, version, lease_id FROM cowork_units WHERE id=$1', [id])).rows[0];
  return { hubert, marek, ada, eve, ws, p, agent, connected, run, task, work, stop, taskRow, unitRow };
}

test('a manager stops the agent: the task goes back to nobody, its unit stops, the stop is recorded and the agent is told', async () => {
  const f = await scene();
  const item = await f.task();
  const { unitId, claim } = await f.work(item);
  assert.equal((await f.taskRow(item.id)).owner_agent_id, f.agent.id);
  const working = (viewer: Person) => viewer.browser.request('GET', '/api/v1/working-agents');
  assert.deepEqual((expectStatus(await working(f.hubert), 200) as OwnWorkingAgents).items.map((entry) => [entry.agent.id, entry.task.id, entry.task.number]),
    [[f.agent.id, item.id, 1]], 'the sidebar card lists the owner\'s working agent');
  assert.deepEqual((expectStatus(await working(f.marek), 200) as OwnWorkingAgents).items, [], 'another person\'s agent is never listed');

  // A contributor who is neither a manager, the agent's owner nor the task's creator may not stop it; a viewer cannot write at all.
  const refused = await f.stop(f.marek, item.id);
  assert.deepEqual([refused.status, refused.json.code], [403, 'STOP_NOT_ALLOWED']);
  assert.equal((await f.stop(f.eve, item.id)).status, 403);
  assert.equal((await f.stop(f.hubert, randomUUID())).status, 404);
  assert.equal((await f.taskRow(item.id)).owner_agent_id, f.agent.id, 'a refusal changes nothing');

  const key = randomUUID();
  const stopped = await f.stop(f.hubert, item.id, { 'idempotency-key': key });
  assert.equal(stopped.status, 201, JSON.stringify(stopped.json));
  const stop = stopped.json as AgentStop;
  assert.deepEqual([stop.taskId, stop.taskNumber, stop.agent, stop.stoppedBy.id, stop.unitsStopped], [item.id, 1, { id: f.agent.id, name: 'Hubert Claude' }, f.hubert.id, 1]);
  const after = await f.taskRow(item.id);
  assert.deepEqual([after.status, after.owner_agent_id, after.owner_user_id], ['open', null, null]);
  const ended = await f.unitRow(unitId);
  assert.deepEqual([ended.state, ended.lease_id, ended.generation > claim.generation, ended.version > claim.version], ['stopped', null, true, true]);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM events WHERE kind='project.agent_stopped.v1' AND object_id=$1", [f.p.id])).rows[0].n, 1);

  // A lost response is retried with the same key: the stored stop, no second effect.
  const replay = await f.stop(f.hubert, item.id, { 'idempotency-key': key });
  assert.deepEqual([replay.status, replay.json.id, replay.headers.get('idempotent-replayed')], [201, stop.id, 'true']);
  // A new stop of work that has ended is a conflict, never a second record.
  assert.deepEqual([(await f.stop(f.hubert, item.id)).status, (await f.stop(f.hubert, item.id)).json.code], [409, 'AGENT_NOT_WORKING']);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM agent_stops WHERE project_id=$1', [f.p.id])).rows[0].n, 1);
  assert.deepEqual((expectStatus(await working(f.hubert), 200) as OwnWorkingAgents).items, []);

  // Readers of the project see who stopped what; others do not.
  const list = expectStatus(await f.marek.browser.request('GET', `/api/v1/projects/${f.p.id}/agent-stops`), 200) as AgentStops;
  assert.deepEqual(list.stops.map((entry) => [entry.id, entry.stoppedBy.name, entry.taskNumber]), [[stop.id, 'Hubert', 1]]);
  const outsider = await person('Outsider');
  assert.equal((await outsider.browser.request('GET', `/api/v1/projects/${f.p.id}/agent-stops`)).status, 404);

  // The agent's next calls report the stop, not a generic lost claim; the unit can never be claimed again.
  const renew = await f.connected.grant('cowork.renew', 'execute', 5, unitId);
  const renewed = await f.connected.tool('flux_renew_unit', { ...f.run(), grantId: renew.id, clientCommandId: randomUUID(), unitId, expectedVersion: claim.version,
    generation: claim.generation, leaseId: claim.lease.id });
  assert.equal(toolFailure(renewed).code, 'COWORK_STOPPED');
  const again = await f.connected.grant('cowork.claim', 'execute', 5, unitId);
  assert.equal(toolFailure(await f.connected.tool('flux_claim_unit', { ...f.run(), grantId: again.id, clientCommandId: randomUUID(), unitId,
    expectedVersion: ended.version })).code, 'COWORK_STOPPED');
});

test('the agent\'s owner and the task\'s creator may stop it; a task it does not hold cannot be stopped', async () => {
  const f = await scene();
  // The task's creator (a contributor) stops an agent that works on her task.
  const hers = await f.task(f.marek, 'Marek\'s task');
  await f.work(hers);
  assert.equal((await f.stop(f.ada, hers.id)).status, 403, 'another contributor may not');
  assert.equal((await f.stop(f.marek, hers.id)).status, 201);
  // A task the agent never held, or that is done, is not working.
  const idle = await f.task(f.hubert, 'Nobody holds this');
  assert.deepEqual([(await f.stop(f.hubert, idle.id)).status, (await f.stop(f.hubert, idle.id)).json.code], [409, 'AGENT_NOT_WORKING']);
  // A person who owns the agent, though not a manager and not the creator, can stop it. Marek owns a second agent here.
  const mine = expectStatus(await f.marek.browser.request('POST', `/api/v1/workspaces/${f.ws.id}/agents`, { body: { name: 'Marek Codex', owner: 'self' } }), 201) as Agent;
  expectStatus(await f.hubert.browser.request('POST', `/api/v1/projects/${f.p.id}/grants`, { body: { principal: { kind: 'agent', id: mine.id }, role: 'contributor' } }), 201);
  const handed = await f.task(f.hubert, 'Handed to Marek\'s agent');
  expectStatus(await f.hubert.browser.request('PATCH', `/api/v1/work/${handed.id}`, { body: { owner: { kind: 'agent', id: mine.id }, status: 'in_progress' },
    headers: { 'if-match': `"${handed.version}"` } }), 200);
  const own = await f.marek.browser.request('POST', `/api/v1/projects/${f.p.id}/agent-stops`, { body: { taskId: handed.id, agentId: mine.id } });
  assert.equal(own.status, 201, own.text);
  assert.equal((expectStatus(own, 201) as AgentStop).unitsStopped, 0, 'a task held without a co-work unit still stops');
  assert.equal((await f.taskRow(handed.id)).owner_agent_id, null);
});

test('an agent asks with ready answers: one message, one card, a question notification for the person asked, one recorded answer', async () => {
  const f = await scene();
  const thread = expectStatus(await f.hubert.browser.request('POST', `/api/v1/projects/${f.p.id}/conversations`,
    { body: { body: 'Offsets for the bed probe', clientMessageId: randomUUID() } }), 201) as Conversation;
  const reply = await f.connected.grant('conversation.reply', 'execute', 10);
  const ask = (args: Record<string, unknown>) => f.connected.tool('flux_ask_question', { ...f.run(), grantId: reply.id, clientCommandId: randomUUID(), sources: [],
    conversationId: thread.id, question: 'Should the offsets be per bed, or one value for all six?', options: ['Per bed', 'One value'], askUserId: f.marek.id, ...args });
  const command = randomUUID();
  const asked = toolValue(await ask({ clientCommandId: command })) as { questionId: string; messageId: string; conversationId: string; replayed: boolean };
  assert.equal(asked.conversationId, thread.id);
  assert.equal(toolValue(await ask({ clientCommandId: command })).questionId, asked.questionId, 'a retry returns the stored question');
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM project_messages WHERE conversation_id=$1', [thread.id])).rows[0].n, 2, 'one message for the question');

  // The question is the agent's ordinary message, with the options as a list, and readers see the card data.
  const stored = expectStatus(await f.ada.browser.request('GET', `/api/v1/conversations/${thread.id}`), 200) as Conversation;
  const message = stored.messages.find((item) => item.id === asked.messageId)!;
  assert.equal(message.authorId, null);
  assert.match(message.body, /Should the offsets be per bed.*\n\n1\. Per bed\n2\. One value$/s);
  const read = expectStatus(await f.ada.browser.request('GET', `/api/v1/projects/${f.p.id}/agent-questions`), 200) as AgentQuestions;
  assert.deepEqual(read.questions.map((item) => [item.id, item.messageId, item.options, item.askedUserId, item.answer, item.agent.name]),
    [[asked.questionId, asked.messageId, ['Per bed', 'One value'], f.marek.id, null, 'Hubert Claude']]);
  assert.equal((await new Browser().request('GET', `/api/v1/projects/${f.p.id}/agent-questions`)).status, 401);

  // Exactly the person asked is notified, as a question, and nobody else because of the card.
  const inbox = async (who: Person) => (expectStatus(await who.browser.request('GET', '/api/v1/inbox'), 200) as { items: { reason: string; title: string; url: string | null; body: string }[] }).items;
  const item = await waitFor(async () => (await inbox(f.marek)).find((entry) => entry.url?.endsWith(asked.messageId)), 'Marek\'s question notification');
  assert.deepEqual([item.reason, item.title, item.body], ['question', 'Hubert Claude (agent) asked you in Heated bed', 'Should the offsets be per bed, or one value for all six?']);
  assert.equal((await inbox(f.ada)).filter((entry) => entry.url?.endsWith(asked.messageId)).length, 0);

  // Only the person asked may answer; a viewer cannot even see that it exists.
  const answer = (who: Person, body: object, headers: Record<string, string> = {}) =>
    who.browser.request('POST', `/api/v1/agent-questions/${asked.questionId}/answer`, { body, headers }) as Promise<Reply>;
  assert.deepEqual([(await answer(f.ada, { optionIndex: 0 })).status, (await answer(f.ada, { optionIndex: 0 })).json.code], [403, 'QUESTION_NOT_FOR_YOU']);
  assert.equal((await answer(await person('Outsider'), { optionIndex: 0 })).status, 404);
  assert.equal((await answer(f.marek, { optionIndex: 5 })).status, 400);
  assert.equal((await answer(f.marek, {})).status, 400);
  assert.equal((await answer(f.marek, { optionIndex: 0, text: 'both' })).status, 400);

  const key = randomUUID();
  const given = await answer(f.marek, { optionIndex: 1 }, { 'idempotency-key': key });
  assert.equal(given.status, 200, JSON.stringify(given.json));
  const done = given.json as AgentQuestion;
  assert.deepEqual([done.answer?.optionIndex, done.answer?.text, done.answer?.by.id], [1, 'One value', f.marek.id]);
  // The reply is Marek's own message in the same thread.
  const after = expectStatus(await f.ada.browser.request('GET', `/api/v1/conversations/${thread.id}`), 200) as Conversation;
  const posted = after.messages.find((entry) => entry.id === done.answer!.messageId)!;
  assert.deepEqual([posted.authorId, posted.body, posted.sequence], [f.marek.id, 'One value', 3]);
  // The same answer again, with or without the key, is the stored one; a different answer is a conflict.
  assert.equal((await answer(f.marek, { optionIndex: 1 }, { 'idempotency-key': key })).json.answer?.messageId, done.answer!.messageId);
  assert.equal((await answer(f.marek, { optionIndex: 1 })).json.answer?.messageId, done.answer!.messageId);
  assert.deepEqual([(await answer(f.marek, { optionIndex: 0 })).status, (await answer(f.marek, { text: 'Neither' })).json.code], [409, 'QUESTION_ANSWERED']);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM project_messages WHERE conversation_id=$1', [thread.id])).rows[0].n, 3, 'one reply, however often it is sent');
});

test('a free reply answers a question; invalid questions and people without access are refused and post nothing', async () => {
  const f = await scene();
  const thread = expectStatus(await f.hubert.browser.request('POST', `/api/v1/projects/${f.p.id}/conversations`,
    { body: { body: 'Where do we cut?', clientMessageId: randomUUID() } }), 201) as Conversation;
  const reply = await f.connected.grant('conversation.reply', 'execute', 10);
  const ask = (args: Record<string, unknown>) => f.connected.tool('flux_ask_question', { ...f.run(), grantId: reply.id, clientCommandId: randomUUID(), sources: [],
    conversationId: thread.id, question: 'Cut at the seam?', options: ['Yes', 'No'], ...args });
  const messages = async () => (await pool.query('SELECT count(*)::int AS n FROM project_messages WHERE conversation_id=$1', [thread.id])).rows[0].n as number;
  // Too few, too many and repeated options, an empty question and a person outside the project post nothing.
  for (const bad of [{ options: ['Only one'] }, { options: ['A', 'B', 'C', 'D', 'E'] }, { options: ['Same', 'same'] }, { question: '  ' }]) {
    const refused = await ask(bad);
    const failed = (refused?.result as { isError?: boolean } | undefined)?.isError === true || !!refused?.error;
    assert.ok(failed, `refused ${JSON.stringify(bad)}`);
  }
  const outsider = await person('Outside');
  assert.equal(toolFailure(await ask({ askUserId: outsider.id })).code, 'QUESTION_PERSON_UNAVAILABLE');
  assert.equal(toolFailure(await ask({ conversationId: randomUUID() })).code, 'OBJECT_NOT_FOUND');
  assert.equal(await messages(), 1);

  // By default the agent's owner is asked.
  const asked = toolValue(await ask({})) as { questionId: string };
  const row = (await pool.query('SELECT asked_user_id FROM agent_questions WHERE id=$1', [asked.questionId])).rows[0];
  assert.equal(row.asked_user_id, f.hubert.id);
  // Own words: recorded as the person's reply, and a viewer who can read the project cannot answer.
  const own = await f.hubert.browser.request('POST', `/api/v1/agent-questions/${asked.questionId}/answer`, { body: { text: '  Cut at the seam, yes  ' } });
  assert.equal(own.status, 200, own.text);
  assert.deepEqual([(own.json as AgentQuestion).answer?.optionIndex, (own.json as AgentQuestion).answer?.text], [null, 'Cut at the seam, yes']);
  assert.equal(await messages(), 3);
  const second = toolValue(await ask({ askUserId: f.eve.id })) as { questionId: string };
  assert.equal((await f.eve.browser.request('POST', `/api/v1/agent-questions/${second.questionId}/answer`, { body: { optionIndex: 0 } })).status, 403,
    'a reader who may not write cannot answer');
  assert.equal(await messages(), 4);
});
