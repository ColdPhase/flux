import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { agentMcpPolicyPath, type AgentMcpPolicy, type SaveAgentMcpPolicy } from '@flux/contracts';
import { pool } from './support/db.js';
import { expect, toolValue } from './support/mcp.js';
import { actionScene, toolFailure } from './support/mcp-actions.js';

// Exact receipt replay under the owner's switches (#316 AC-3/AC-4): a committed effect keeps its receipt, Off refuses
// the retry, a newly admitted retry after On observes the stored receipt without a new effect or debit, and a
// consumed or revoked grant never authorizes another command.
test('an exact retry observes its committed receipt only while the switch is On; Off, revocation and new commands refuse', async () => {
  const f = await actionScene(pool);
  const path = agentMcpPolicyPath(f.connectionId);
  const read = async () => (expect(await f.owner.request('GET', path), 200) as { policy: AgentMcpPolicy }).policy;
  const initial = await read();
  const save = async (input: SaveAgentMcpPolicy) => {
    const current = await read();
    await f.owner.request('PATCH', path, { body: input, headers: { 'if-match': `"mcp-policy-${current.version}"` } }).then((r) => expect(r, 200));
  };
  const input = (policy: AgentMcpPolicy): SaveAgentMcpPolicy => ({ enabledCapabilityIds: [...policy.enabledCapabilityIds],
    enabledEntryIds: [...policy.enabledEntryIds], selectedProjectIds: [...policy.selectedProjectIds] });
  const counts = async () => ({ tasks: await f.tasks(),
    receipts: (await pool.query('SELECT count(*)::int AS n FROM agent_command_receipts WHERE connection_id=$1', [f.connectionId])).rows[0].n as number });
  const create = await f.grant('work.create', 'plan', 1);
  const command = (clientCommandId: string, title = 'Compare against the baseline') => ({ projectId: f.projectId,
    runtimeSessionId: f.runtimeSessionId, grantId: create.id, clientCommandId, peerRequestClass: 'plan', sources: [f.source],
    task: { title, criteria: ['The comparison names both runs'], dependencyIds: [f.prerequisiteId],
      planIntent: { ...f.source, intentKey: 'compare-step' } } });
  const first = randomUUID();
  const created = toolValue(await f.tool('flux_create_task', command(first)));
  assert.equal(created.replayed, false);
  assert.equal(await f.used(create.id), 1, 'the last use is consumed');
  const committed = await counts();

  // Off: the retry is refused and neither the receipt, the task nor the debit changes.
  await save({ ...input(initial), enabledCapabilityIds: initial.enabledCapabilityIds.filter((id) => id !== 'work.create') });
  assert.equal(toolFailure(await f.tool('flux_create_task', command(first))).code, 'MCP_ENTRY_UNAVAILABLE');
  assert.deepEqual(await counts(), committed);
  assert.equal(await f.used(create.id), 1);

  // On again: a newly admitted exact retry observes the stored receipt, even though the grant has no use left.
  await save(input(initial));
  assert.deepEqual(toolValue(await f.tool('flux_create_task', command(first))), { ...created, replayed: true });
  assert.deepEqual(await counts(), committed, 'observation performs no new effect or receipt');
  assert.equal(await f.used(create.id), 1, 'observation performs no debit');

  // The same consumed grant never authorizes another command, with the switch On or after an Off/On cycle.
  const other = randomUUID();
  const refused = command(other, 'A second task');
  refused.task.planIntent = { ...f.source, intentKey: 'second-step' };
  const failure = toolFailure(await f.tool('flux_create_task', refused));
  assert.notEqual(failure.code, 'MCP_ENTRY_UNAVAILABLE');
  assert.deepEqual(await counts(), committed);
  assert.equal(await f.used(create.id), 1);

  // Revocation ends observation too, and a later On cannot restore it.
  expect(await f.owner.request('DELETE', `/api/v1/agent-connections/${f.connectionId}/action-grants/${create.id}`), 204);
  assert.equal(toolFailure(await f.tool('flux_create_task', command(first))).code, 'AGENT_EXECUTION_UNAVAILABLE');
  await save({ ...input(initial), enabledCapabilityIds: initial.enabledCapabilityIds.filter((id) => id !== 'work.create') });
  await save(input(initial));
  assert.equal(toolFailure(await f.tool('flux_create_task', command(first))).code, 'AGENT_EXECUTION_UNAVAILABLE');
  assert.deepEqual(await counts(), committed, 'the committed history is preserved throughout');
});
