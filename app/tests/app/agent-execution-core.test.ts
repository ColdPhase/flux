import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { AgentExecutionCommand } from '@flux/contracts';
import { DomainError, normalizeAgentExecution, normalizeStandingGrant, validateAgentPostconditions } from '@flux/core';

function command(): AgentExecutionCommand {
  const projectId = randomUUID();
  return { runtimeSessionId: randomUUID(), grantId: randomUUID(), clientCommandId: randomUUID(), projectId,
    operation: 'work.create', peerRequestClass: 'execute', audience: { kind: 'project', projectId }, objectId: null,
    sources: [{ materialId: randomUUID(), version: 1 }, { materialId: randomUUID(), version: 2 }], payload: { title: 'A task', detail: { a: 1, b: 2 } } };
}
test('durable command normalization is deterministic and rejects ambiguous, wildcard, mismatched or unbounded inputs', () => {
  const original = command(); const normalized = normalizeAgentExecution(original);
  assert.equal(normalizeAgentExecution({ ...original, sources: [...original.sources].reverse(), payload: { detail: { b: 2, a: 1 }, title: 'A task' } }).fingerprint, normalized.fingerprint);
  for (const changed of [
    { ...original, operation: 'work.*' }, { ...original, peerRequestClass: 'review' },
    { ...original, audience: { kind: 'project', projectId: randomUUID() } },
    { ...original, objectId: randomUUID() }, { ...original, sources: [original.sources[0], original.sources[0]] },
    { ...original, sources: [{ materialId: original.sources[0]!.materialId, version: 1.5 }] },
    { ...original, payload: { value: Infinity } }, { ...original, payload: { value: 'x'.repeat(200_001) } },
    { ...original, accidentalAuthority: true },
  ]) assert.throws(() => normalizeAgentExecution(changed as AgentExecutionCommand), (error: unknown) => error instanceof DomainError && error.code === 'INVALID_INPUT');
  assert.throws(() => normalizeStandingGrant({ clientCommandId: randomUUID(), projectId: original.projectId,
    operation: 'result.record', peerRequestClass: 'review', maximumUses: 2, expiresAt: new Date().toISOString() }),
  (error: unknown) => error instanceof DomainError && error.code === 'INVALID_INPUT');
});

test('canonical postcondition registry rejects missing, duplicate, malformed or cross-operation evidence', () => {
  const id = randomUUID();
  validateAgentPostconditions('work.update', [{ kind: 'work', id, version: 2 }]);
  const checkpoint = { kind: 'map_checkpoint', id, updatedAt: new Date().toISOString() };
  validateAgentPostconditions('map.positions.update', [checkpoint]);
  for (const value of [null, [], [null], [{ kind: 'work', id, version: 0 }], [{ kind: 'work', id, version: 2, arbitrary: true }],
    [{ kind: 'result', id }], [{ kind: 'work', id, version: 2 }, { kind: 'work', id, version: 2 }]])
    assert.throws(() => validateAgentPostconditions('work.update', value), (error: unknown) => error instanceof DomainError && error.code === 'COMMAND_POSTSTATE_INVALID');
  assert.throws(() => validateAgentPostconditions('map.thought.update', [checkpoint]), { code: 'COMMAND_POSTSTATE_INVALID' });
});

test('claim conditions retain actual role/state/session and allow historical expired lease observation only as post-state', () => {
  const condition = { kind: 'cowork.claim_state', workspaceId: randomUUID(), projectId: randomUUID(), connectionId: randomUUID(),
    unitId: randomUUID(), role: 'review', version: 2, generation: 1, state: 'claimed', leaseId: randomUUID(),
    leaseSessionId: randomUUID(), leaseExpiresAt: '2020-01-01T00:00:00.000Z', checkpointId: null };
  validateAgentPostconditions('cowork.claim', [condition]);
  for (const changed of [{ ...condition, leaseSessionId: null }, { ...condition, state: 'paused' },
    { ...condition, role: 'anything' }, { ...condition, leaseExpiresAt: 'yesterday' }])
    assert.throws(() => validateAgentPostconditions('cowork.claim', [changed]), { code: 'COMMAND_POSTSTATE_INVALID' });
});
