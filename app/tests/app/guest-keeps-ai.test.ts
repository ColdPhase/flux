import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { before, describe, test } from 'node:test';
import { AGENT_CHATS_PATH, AGENT_CONNECTIONS_PATH, ASSISTANT_RUNS_PATH, MY_AGENTS_PATH, PERSONAL_ASSISTANT_PATH, agentAssistantRunsPath, agentChatMessagesPath,
  agentConnectionPath, backgroundComputeConnectionPath, backgroundComputeConnectionsPath, myAgentPath, type AgentConnection, type BackgroundComputeConnection,
  type MyAgent, type PersonalAssistantStatus } from '@flux/contracts';
import { pool } from './support/db.js';
import { expectStatus, person, type Person } from './support/people.js';

// A member made a guest keeps their agents, API keys and client connections, hidden and refused everywhere while they are a guest of the
// company, and has them back, the same ones, as a member again (#1035, C-50, AG-2). The company's role decides; a role elsewhere changes nothing.
// The keys part runs on any stack. The agents part needs AI switched on for the server (the check stack with FLUX_TEST_PERSONAL_RUNS=anthropic-mock and
// FLUX_TEST_ANTHROPIC_URL=http://providermock:8095) because saving the first key makes the person's Assistant there; it is skipped otherwise.

const live = process.env.FLUX_TEST_PERSONAL_RUNS === 'anthropic-mock';
const keyBody = (tag: string) => ({ name: `Key ${tag}`, provider: 'anthropic', model: 'claude-sonnet-5', timeZone: 'Europe/Warsaw', dailyBudgetCents: 50,
  apiKey: `sk-ant-api03-keeps-ai-key-keeps-ai-key-keeps-ai-key-${tag}` });

describe('a member made a guest keeps their AI, hidden and refused, and has it back as a member (#1035)', () => {
  let boss: Person; let keeper: Person; let company: string;
  const becomes = async (role: 'guest' | 'member') => expectStatus(await boss.browser.request('PATCH', `/api/v1/workspaces/${company}/members/${keeper.id}`, { body: { role } }), 200);
  const count = async (table: string) => Number((await pool.query(`SELECT count(*)::int AS n FROM ${table} WHERE owner_user_id = $1 AND revoked_at IS NULL`, [keeper.id])).rows[0].n);
  const keys = async () => expectStatus(await keeper.browser.request('GET', backgroundComputeConnectionsPath), 200) as BackgroundComputeConnection[];

  before(async () => {
    [boss, keeper] = await Promise.all(['gka-boss', 'gka-keeper'].map(person));
    company = (await pool.query<{ id: string }>('SELECT id FROM workspaces WHERE company')).rows[0]!.id;
    for (const [someone, role] of [[boss, 'owner'], [keeper, 'member']] as const)
      await pool.query('INSERT INTO workspace_members (workspace_id, user_id, role, created_by) VALUES ($1, $2, $3, $2)', [company, someone.id, role]);
  });

  test('the API key is hidden and refused for a guest, stays saved, and is back for a member', async () => {
    const saved = expectStatus(await keeper.browser.request('POST', backgroundComputeConnectionsPath, { body: keyBody('KP01') }), 201) as BackgroundComputeConnection;
    assert.deepEqual((await keys()).map((item) => item.id), [saved.id]);

    await becomes('guest');

    assert.deepEqual(await keys(), [], 'no key is listed');
    assert.equal((await keeper.browser.request('PATCH', backgroundComputeConnectionPath(saved.id), { body: { name: 'Renamed by a guest' } })).status, 404, 'renaming is refused');
    assert.equal((await keeper.browser.request('DELETE', backgroundComputeConnectionPath(saved.id))).status, 404, 'so is removing');
    assert.equal(await count('background_compute_connections'), 1, 'it is kept, sealed and unrevoked');

    await becomes('member');

    assert.deepEqual((await keys()).map((item) => [item.id, item.name]), [[saved.id, 'Key KP01']], 'the same key is back');
    assert.equal((await keeper.browser.request('PATCH', backgroundComputeConnectionPath(saved.id), { body: { name: 'Back as a member' } })).status, 200);
  });

  test('the agent, its client connection, its chat and its status are hidden and refused for a guest, change nothing, and come back for a member', { skip: !live && 'needs FLUX_TEST_PERSONAL_RUNS=anthropic-mock' }, async () => {
    // The key above made Assistant (the first connection); it has its connection.
    const agents = async () => (expectStatus(await keeper.browser.request('GET', MY_AGENTS_PATH), 200) as { items: MyAgent[] }).items;
    const [assistant] = await agents();
    assert.equal(assistant?.name, 'Assistant');
    const connections = async () => expectStatus(await keeper.browser.request('GET', AGENT_CONNECTIONS_PATH), 200) as AgentConnection[];
    const [connection] = await connections();
    assert.ok(connection, 'Assistant has a connection');
    const status = async () => expectStatus(await keeper.browser.request('GET', PERSONAL_ASSISTANT_PATH), 200) as PersonalAssistantStatus;
    assert.equal((await status()).state, 'ready');
    const before = [await count('agents'), await count('agent_connections')];
    assert.deepEqual(before, [1, 1]);

    await becomes('guest');

    assert.deepEqual(await agents(), [], 'the agent list is empty');
    assert.equal((await keeper.browser.request('GET', myAgentPath(assistant!.id))).status, 404, 'its page is not found');
    assert.equal((await keeper.browser.request('PATCH', myAgentPath(assistant!.id), { body: { name: 'Renamed by a guest' } })).status, 404, 'renaming is refused');
    assert.equal((await keeper.browser.request('DELETE', myAgentPath(assistant!.id))).status, 404, 'so is deleting');
    assert.equal((await keeper.browser.request('GET', `${myAgentPath(assistant!.id)}/memory`)).status, 404, 'and its memory');
    const asleep = await status();
    assert.equal(asleep.state, 'not_enabled', 'the assistant is not set up');
    assert.equal(asleep.enablement, null);
    assert.deepEqual(await connections(), [], 'no client connection is listed');
    assert.equal((await keeper.browser.request('PATCH', agentConnectionPath(connection.id), { body: { mayDo: 'act' } })).status, 404);
    assert.equal((await keeper.browser.request('DELETE', agentConnectionPath(connection.id))).status, 404);
    assert.deepEqual(expectStatus(await keeper.browser.request('GET', AGENT_CHATS_PATH), 200), { items: [] }, 'no agent conversation in Messages');
    assert.equal((expectStatus(await keeper.browser.request('GET', ASSISTANT_RUNS_PATH), 200) as { total: number }).total, 0, 'and no run is listed');
    assert.equal((await keeper.browser.request('GET', agentChatMessagesPath(assistant!.id))).status, 404);
    const run = await keeper.browser.request('POST', agentAssistantRunsPath(assistant!.id), { body: { clientRunId: randomUUID(), kind: 'ask', prompt: 'Hello' } });
    assert.ok(run.status >= 400 && run.status < 500, `a chat with it is refused: ${run.status}`);
    assert.deepEqual([await count('agents'), await count('agent_connections')], before, 'nothing was removed');

    await becomes('member');

    assert.deepEqual((await agents()).map((agent) => [agent.id, agent.name]), [[assistant!.id, 'Assistant']], 'the same agent is back');
    assert.equal((await status()).state, 'ready');
    assert.deepEqual((await connections()).map((item) => item.id), [connection.id], 'and its connection');
    assert.equal((await keeper.browser.request('PATCH', myAgentPath(assistant!.id), { body: { name: 'Back as a member' } })).status, 200);
  });
});
