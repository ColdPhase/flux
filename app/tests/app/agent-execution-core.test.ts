import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { AGENT_OPERATIONS, AGENT_OPERATION_CLASSES,
  type AgentExecutionCommand, type AgentOperation, type AgentPostcondition } from '@flux/contracts';
import { DomainError, normalizeAgentExecution, validateAgentPostconditions } from '@flux/core';

function command(): AgentExecutionCommand {
  const projectId = randomUUID();
  return { runtimeSessionId: randomUUID(), clientCommandId: randomUUID(), projectId,
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
});

test('canonical postcondition registry rejects missing, duplicate, malformed or cross-operation evidence', () => {
  const id = randomUUID();
  validateAgentPostconditions('work.update', [{ kind: 'work', id, version: 2 }]);
  const checkpoint = { kind: 'map_checkpoint', id, updatedAt: new Date().toISOString() };
  validateAgentPostconditions('map.positions.update', [checkpoint]);
  for (const value of [null, [], [null], [{ kind: 'work', id, version: 0 }], [{ kind: 'work', id, version: 2, arbitrary: true }],
    [{ kind: 'message', id }], [{ kind: 'work', id, version: 2 }, { kind: 'work', id, version: 2 }]])
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

const invalidInput = (error: unknown) => error instanceof DomainError && error.code === 'INVALID_INPUT';

test('every operation has a registered postcondition entry; an incomplete sample table does not typecheck', () => {
  const uuid = () => randomUUID();
  const claim = (): AgentPostcondition => ({ kind: 'cowork.claim_state', workspaceId: uuid(), projectId: uuid(), connectionId: uuid(),
    unitId: uuid(), role: 'execute', version: 1, generation: 0, state: 'pending', leaseId: null, leaseSessionId: null, leaseExpiresAt: null, checkpointId: null });
  const at = new Date().toISOString();
  // A Record over AgentOperation: adding an operation without a fixture here is a compile error, and a fixture the core
  // POSTCONDITIONS registry does not accept for that operation fails below.
  const samples: Record<AgentOperation, AgentPostcondition[]> = {
    'work.create': [{ kind: 'work', id: uuid(), version: 1 }], 'work.update': [{ kind: 'work', id: uuid(), version: 2 }],
    'work.creation.revert': [{ kind: 'work', id: uuid(), version: 2 }],
    'decision.propose': [{ kind: 'decision', id: uuid(), version: 1 }],
    'map.create': [{ kind: 'map', id: uuid(), version: 1 }], 'map.rename': [{ kind: 'map', id: uuid(), version: 2 }],
    'map.thought.create': [{ kind: 'thought', id: uuid(), version: 1 }, { kind: 'map_checkpoint', id: uuid(), updatedAt: at }],
    'map.thought.update': [{ kind: 'thought', id: uuid(), version: 2 }, { kind: 'map_checkpoint', id: uuid(), updatedAt: at }],
    'map.thought.delete': [{ kind: 'map_checkpoint', id: uuid(), updatedAt: at }],
    'map.positions.update': [{ kind: 'thought', id: uuid(), version: 2 }, { kind: 'map_checkpoint', id: uuid(), updatedAt: at }],
    'map.link.create': [{ kind: 'map_checkpoint', id: uuid(), updatedAt: at }], 'map.link.delete': [{ kind: 'map_checkpoint', id: uuid(), updatedAt: at }],
    'doc.create': [{ kind: 'doc', id: uuid(), version: 1 }], 'doc.update': [{ kind: 'doc', id: uuid(), version: 2 }],
    'doc.delete': [{ kind: 'doc_removed', id: uuid() }],
    'conversation.create': [{ kind: 'message', id: uuid() }], 'conversation.reply': [{ kind: 'message', id: uuid() }],
    'cowork.claim': [claim()], 'cowork.renew': [claim()], 'cowork.release': [claim()],
    'cowork.unit.create': [{ kind: 'cowork.unit_state', workspaceId: uuid(), projectId: uuid(), unitId: uuid(), taskId: uuid(),
      lineageTaskId: uuid(), runId: uuid(), role: 'review', assignmentConnectionId: uuid(), version: 1, state: 'pending' }],
    'cowork.unit.complete': [{ kind: 'cowork.unit_state', workspaceId: uuid(), projectId: uuid(), unitId: uuid(), taskId: uuid(),
      lineageTaskId: uuid(), runId: uuid(), role: 'execute', assignmentConnectionId: uuid(), version: 3, state: 'completed' }],
    'cowork.unit.transfer': [{ kind: 'cowork.unit_state', workspaceId: uuid(), projectId: uuid(), unitId: uuid(), taskId: uuid(),
      lineageTaskId: uuid(), runId: uuid(), role: 'execute', assignmentConnectionId: uuid(), version: 3, state: 'pending' }],
    'cowork.unit.decline': [{ kind: 'cowork.unit_state', workspaceId: uuid(), projectId: uuid(), unitId: uuid(), taskId: uuid(),
      lineageTaskId: uuid(), runId: uuid(), role: 'execute', assignmentConnectionId: uuid(), version: 4, state: 'paused' }],
    // #1217: a picture on a run's answer is no object of the space, so no coordination command can produce it.
    'answer.picture.attach': [],
  };
  for (const operation of AGENT_OPERATIONS) if (operation !== 'answer.picture.attach') validateAgentPostconditions(operation, samples[operation]);
  assert.throws(() => validateAgentPostconditions('answer.picture.attach', [{ kind: 'message', id: uuid() }]), /produced post-state/);
  // @ts-expect-error a table without its cowork.claim entry must not satisfy the exhaustive operation record
  const incomplete: Record<AgentOperation, AgentPostcondition[]> = {} as Omit<typeof samples, 'cowork.claim'>;
  assert.equal(incomplete['cowork.claim'], undefined);
});

test('doc and conversation commands: creates have no target, changes name their doc or conversation, post-state is exact', () => {
  const projectId = randomUUID();
  const base = { runtimeSessionId: randomUUID(), clientCommandId: randomUUID(), projectId,
    peerRequestClass: 'plan' as const, audience: { kind: 'project' as const, projectId }, sources: [], payload: { body: 'Text' } };
  for (const operation of ['doc.create', 'conversation.create'] as const) {
    assert.deepEqual(AGENT_OPERATION_CLASSES[operation], ['execute', 'plan']);
    assert.equal(normalizeAgentExecution({ ...base, operation, objectId: null }).objectId, null);
    assert.throws(() => normalizeAgentExecution({ ...base, operation, objectId: randomUUID() }), invalidInput);
  }
  for (const operation of ['doc.update', 'doc.delete', 'conversation.reply'] as const) {
    const target = randomUUID();
    assert.equal(normalizeAgentExecution({ ...base, operation, objectId: target }).objectId, target);
    assert.throws(() => normalizeAgentExecution({ ...base, operation, objectId: null }), invalidInput);
    assert.throws(() => normalizeAgentExecution({ ...base, operation, objectId: target, peerRequestClass: 'review' }), invalidInput,
      'review authority never writes docs or messages');
  }
  const id = randomUUID();
  validateAgentPostconditions('doc.update', [{ kind: 'doc', id, version: 3 }]);
  validateAgentPostconditions('conversation.reply', [{ kind: 'message', id }]);
  validateAgentPostconditions('doc.delete', [{ kind: 'doc_removed', id }]);
  for (const [operation, value] of [
    ['doc.delete', [{ kind: 'doc', id, version: 3 }]], ['doc.delete', [{ kind: 'doc_removed', id, version: 3 }]], ['doc.update', [{ kind: 'doc_removed', id }]],
    ['doc.update', [{ kind: 'doc', id }]], ['doc.update', [{ kind: 'material', id, version: 3 }]], ['doc.create', [{ kind: 'message', id }]],
    ['conversation.reply', [{ kind: 'message', id, version: 1 }]], ['conversation.create', [{ kind: 'message', id, body: 'text' }]],
    ['conversation.create', [{ kind: 'message', id }, { kind: 'message', id: randomUUID() }]], ['conversation.reply', [{ kind: 'doc', id, version: 1 }]],
  ] as const) assert.throws(() => validateAgentPostconditions(operation, value), { code: 'COMMAND_POSTSTATE_INVALID' });
});

test('cowork.unit.create targets the native task; its class is the created role and its post-state is exact', () => {
  assert.deepEqual(AGENT_OPERATION_CLASSES['cowork.unit.create'], ['execute', 'review', 'plan']);
  const projectId = randomUUID(), task = randomUUID();
  const base: AgentExecutionCommand = { runtimeSessionId: randomUUID(), clientCommandId: randomUUID(), projectId,
    operation: 'cowork.unit.create', peerRequestClass: 'review', audience: { kind: 'project', projectId }, objectId: task, sources: [],
    payload: { unitKey: 'review-a', expectedTaskVersion: 1, assignmentConnectionId: randomUUID(), parent: null } };
  assert.equal(normalizeAgentExecution(base).objectId, task, 'the object is the task the unit is for');
  assert.throws(() => normalizeAgentExecution({ ...base, objectId: null }), invalidInput);
  const unit = { kind: 'cowork.unit_state', workspaceId: randomUUID(), projectId, unitId: randomUUID(), taskId: task, lineageTaskId: task,
    runId: randomUUID(), role: 'review', assignmentConnectionId: randomUUID(), version: 1, state: 'pending' };
  validateAgentPostconditions('cowork.unit.create', [unit]);
  for (const changed of [
    { ...unit, state: 'queued' }, { ...unit, role: 'reviewer' }, { ...unit, version: 0 }, { ...unit, runId: 'run' },
    { ...unit, connectionId: randomUUID() }, Object.fromEntries(Object.entries(unit).filter(([key]) => key !== 'assignmentConnectionId')),
  ]) assert.throws(() => validateAgentPostconditions('cowork.unit.create', [changed]), { code: 'COMMAND_POSTSTATE_INVALID' });
  assert.throws(() => validateAgentPostconditions('cowork.unit.create', [unit, unit]), { code: 'COMMAND_POSTSTATE_INVALID' });
  // A unit post-state proves no claim, and a claim proves no creation.
  assert.throws(() => validateAgentPostconditions('cowork.claim', [unit]), { code: 'COMMAND_POSTSTATE_INVALID' });
});

test('cowork.unit.complete/.transfer target the holder\'s unit; their class is its role and their post-state is the unit state', () => {
  const projectId = randomUUID(), unitId = randomUUID();
  for (const operation of ['cowork.unit.complete', 'cowork.unit.transfer'] as const) {
    assert.deepEqual(AGENT_OPERATION_CLASSES[operation], ['execute', 'review', 'plan']);
    const base: AgentExecutionCommand = { runtimeSessionId: randomUUID(), clientCommandId: randomUUID(), projectId,
      operation, peerRequestClass: 'execute', audience: { kind: 'project', projectId }, objectId: unitId, sources: [],
      payload: { expectedVersion: 2, generation: 1, leaseId: randomUUID(), assignmentConnectionId: randomUUID() } };
    assert.equal(normalizeAgentExecution(base).objectId, unitId, 'the object is the holder\'s own unit');
    assert.throws(() => normalizeAgentExecution({ ...base, objectId: null }), invalidInput);
    const unit = { kind: 'cowork.unit_state', workspaceId: randomUUID(), projectId, unitId, taskId: randomUUID(), lineageTaskId: randomUUID(),
      runId: randomUUID(), role: 'execute', assignmentConnectionId: randomUUID(), version: 3,
      state: operation === 'cowork.unit.complete' ? 'completed' : 'pending' };
    validateAgentPostconditions(operation, [unit]);
    for (const changed of [{ ...unit, state: 'done' }, { ...unit, outcomeRef: { type: 'result', id: randomUUID() } }, { ...unit, generation: 2 }])
      assert.throws(() => validateAgentPostconditions(operation, [changed]), { code: 'COMMAND_POSTSTATE_INVALID' });
    // A claim post-state proves no transition, and a transition post-state proves no claim.
    const claimed = { kind: 'cowork.claim_state', workspaceId: unit.workspaceId, projectId, connectionId: randomUUID(), unitId, role: 'execute',
      version: 3, generation: 2, state: 'paused', leaseId: null, leaseSessionId: null, leaseExpiresAt: null, checkpointId: null };
    assert.throws(() => validateAgentPostconditions(operation, [claimed]), { code: 'COMMAND_POSTSTATE_INVALID' });
    assert.throws(() => validateAgentPostconditions('cowork.claim', [unit]), { code: 'COMMAND_POSTSTATE_INVALID' });
  }
});
