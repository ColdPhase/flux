import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { AGENT_MCP_ENTRIES, type AgentConnection, type AgentMcpPolicy, type SaveAgentMcpPolicy } from '@flux/contracts';
import { DomainError, agentMcpPolicyUseCases, initialAgentMcpPolicy, mcpPolicyAdmissionActions,
  mcpPolicyWithinConsent, validateMcpPolicy } from '@flux/core';

const connection = (): AgentConnection => ({ id: randomUUID(), workspaceId: randomUUID(), ownerUserId: randomUUID(),
  agentId: randomUUID(), name: 'Local assistant', clientDesignation: 'codex', selectedProjectIds: [randomUUID()],
  scopes: ['flux.context.read', 'flux.action.execute'], computeSource: 'user_operated_external_client',
  revokedAt: null, createdAt: new Date().toISOString() });
const off: SaveAgentMcpPolicy = { enabledCapabilityIds: [], enabledEntryIds: [], selectedProjectIds: [] };

test('initial captured entry membership follows original consent and does not admit unsupported operations', () => {
  const original = { ...connection(), scopes: ['flux.context.read'] as const };
  const policy = initialAgentMcpPolicy({ ...original, scopes: [...original.scopes] });
  assert.ok(policy.enabledEntryIds.includes('tool:flux_get_doc'));
  assert.ok(policy.enabledEntryIds.includes('resource:flux_project_policy'));
  assert.ok(!policy.enabledEntryIds.includes('tool:flux_create_task'));
  assert.ok(!AGENT_MCP_ENTRIES.some((entry) => entry.operation === 'cowork.request'));
  assert.equal(new Set(policy.enabledEntryIds).size, policy.enabledEntryIds.length);
});

test('empty settings are valid while duplicates, unknown entries and original-ceiling expansion are refused', () => {
  assert.deepEqual(validateMcpPolicy(off), off);
  const original = connection();
  assert.equal(mcpPolicyWithinConsent(original, off), true);
  assert.equal(mcpPolicyWithinConsent(original, { ...off, selectedProjectIds: [randomUUID()] }), false);
  assert.equal(mcpPolicyWithinConsent(original, { ...off, enabledCapabilityIds: ['proposal.create'] }), false);
  for (const value of [{ ...off, enabledEntryIds: ['tool:future_alias'] },
    { ...off, enabledEntryIds: ['tool:flux_get_doc', 'tool:flux_get_doc'] },
    { ...off, selectedProjectIds: ['not-a-project'] }]) {
    assert.throws(() => validateMcpPolicy(value), { code: 'INVALID_INPUT' });
  }
});

test('turning knowledge read On never requires an unrelated retained write grant', () => {
  const original = connection();
  const previous: AgentMcpPolicy = { connectionId: original.id, version: 8,
    enabledCapabilityIds: ['work.create'], enabledEntryIds: ['tool:flux_create_task'],
    selectedProjectIds: [...original.selectedProjectIds] };
  const readOn: SaveAgentMcpPolicy = { enabledCapabilityIds: ['work.create', 'project.knowledge.read'],
    enabledEntryIds: ['tool:flux_create_task', 'tool:flux_get_doc'], selectedProjectIds: [...previous.selectedProjectIds] };
  assert.deepEqual(mcpPolicyAdmissionActions(previous, readOn), [{ projectId: original.selectedProjectIds[0], action: 'project.read' }]);
  const readAlias = { ...previous, enabledCapabilityIds: readOn.enabledCapabilityIds };
  assert.deepEqual(mcpPolicyAdmissionActions(readAlias, readOn), [{ projectId: original.selectedProjectIds[0], action: 'project.read' }]);
  const noWrite = { ...previous, enabledCapabilityIds: [] };
  assert.deepEqual(mcpPolicyAdmissionActions(noWrite, previous), [{ projectId: original.selectedProjectIds[0], action: 'project.write' }]);
  const anotherProject = randomUUID();
  const actions = mcpPolicyAdmissionActions(previous, { ...previous, selectedProjectIds: [...previous.selectedProjectIds, anotherProject] });
  assert.deepEqual(actions, [{ projectId: anotherProject, action: 'project.write' }]);
  assert.deepEqual(mcpPolicyAdmissionActions(previous, off), []);
});

test('ordinary owner management permits all Off and reports stale writes without another authentication flow', async () => {
  const original = connection(); let saved = initialAgentMcpPolicy(original); let saves = 0;
  const service = agentMcpPolicyUseCases({
    async get(ownerId, id) { return ownerId === original.ownerUserId && id === original.id ? { connection: original, policy: saved } : null; },
    async save(ownerId, id, version, input) {
      saves++;
      if (ownerId !== original.ownerUserId || id !== original.id) return 'CONNECTION_NOT_FOUND';
      if (version !== saved.version) return 'POLICY_VERSION_CONFLICT';
      saved = { connectionId: id, version: version + 1, ...input }; return saved;
    },
  });
  const human = { kind: 'human' as const, id: original.ownerUserId };
  assert.deepEqual(await service.save(human, original.id, 1, off), { connectionId: original.id, version: 2, ...off });
  assert.equal((await service.get(human, original.id)).policy.version, 2);
  await assert.rejects(service.save(human, original.id, 1, off), (cause: unknown) => cause instanceof DomainError
    && cause.code === 'POLICY_VERSION_CONFLICT' && cause.status === 409);
  const before = saves;
  await assert.rejects(service.save({ kind: 'agent', id: original.agentId }, original.id, 2, off), { code: 'CONNECTION_NOT_FOUND' });
  assert.equal(saves, before, 'agent cannot reach structural owner management');
  assert.equal(saved.version, 2, 'stale and denied writes leave saved state unchanged');
});
