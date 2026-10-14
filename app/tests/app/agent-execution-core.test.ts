import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { AGENT_OPERATIONS, AGENT_OPERATION_CLASSES, AGENT_PEER_REQUEST_CLASSES,
  type AgentExecutionCommand, type AgentOperation, type AgentPostcondition } from '@flux/contracts';
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

function request(overrides: Partial<AgentExecutionCommand> = {}): AgentExecutionCommand {
  const projectId = randomUUID();
  return { runtimeSessionId: randomUUID(), grantId: randomUUID(), clientCommandId: randomUUID(), projectId,
    operation: 'cowork.request', peerRequestClass: 'execute', audience: { kind: 'project', projectId }, objectId: randomUUID(),
    sources: [], payload: { kind: 'review', recipientConnectionId: randomUUID(), intentKey: 'review-round-1' }, ...overrides };
}
const invalidInput = (error: unknown) => error instanceof DomainError && error.code === 'INVALID_INPUT';

test('cowork.request is reserved for the sender unit role only: never a recipient class, request kind or ACK/selection operation', () => {
  assert.ok(AGENT_OPERATIONS.includes('cowork.request'));
  assert.deepEqual(AGENT_OPERATION_CLASSES['cowork.request'], ['execute', 'review', 'plan']);
  assert.deepEqual([...AGENT_OPERATIONS].sort(), Object.keys(AGENT_OPERATION_CLASSES).sort(), 'every operation has exactly one class entry');
  for (const peerRequestClass of AGENT_PEER_REQUEST_CLASSES) {
    // A sender's execution/plan/review role requests a peer review without holding that peer's review class:
    // the class is the sender's, and the requested `kind` and recipient live in the fingerprinted payload.
    const command = request({ peerRequestClass });
    const normalized = normalizeAgentExecution(command);
    assert.equal(normalized.peerRequestClass, peerRequestClass);
    assert.equal(normalized.objectId, command.objectId!.toLowerCase(), 'the object is the sender unit');
    assert.notEqual(normalizeAgentExecution({ ...command, payload: { kind: 'fix', recipientConnectionId: randomUUID(), intentKey: 'x' } }).fingerprint, normalized.fingerprint);
  }
  const base = request();
  for (const changed of [
    { ...base, objectId: null },
    // Request kinds, the recipient and anything other than the three sender roles are never classes.
    ...['help', 'review_request', 'fix', 'handoff', 'recipient', 'peer', ''].map((peerRequestClass) => ({ ...base, peerRequestClass })),
    // ACK, deferral and selection are retained state changes, not debited operations.
    ...['cowork.ack', 'cowork.defer', 'cowork.select', 'cowork.request.ack', 'cowork.requests', 'cowork.request.review'].map((operation) => ({ ...base, operation })),
  ]) assert.throws(() => normalizeAgentExecution(changed as unknown as AgentExecutionCommand), invalidInput);
  assert.throws(() => normalizeAgentExecution({ ...base, payload: { recipient: Infinity } }), invalidInput);
  assert.throws(() => normalizeAgentExecution({ ...base, accidentalRecipientAuthority: true } as unknown as AgentExecutionCommand), invalidInput);
});

test('a cowork.request grant cannot authorize cowork.claim and a claim grant cannot authorize a request', () => {
  const same = { runtimeSessionId: randomUUID(), grantId: randomUUID(), clientCommandId: randomUUID(), projectId: randomUUID(),
    objectId: randomUUID(), sources: [], payload: { expectedVersion: 1 } };
  const asRequest = request({ ...same, audience: { kind: 'project', projectId: same.projectId } });
  const asClaim = { ...asRequest, operation: 'cowork.claim' as const };
  assert.notEqual(normalizeAgentExecution(asRequest).fingerprint, normalizeAgentExecution(asClaim).fingerprint,
    'the operation is part of the durable fingerprint, so one command ID cannot cover both');
  for (const operation of ['cowork.request', 'cowork.claim'] as const) {
    const grant = normalizeStandingGrant({ clientCommandId: randomUUID(), projectId: same.projectId, operation, peerRequestClass: 'review',
      maximumUses: 1, expiresAt: new Date(Date.now() + 60_000).toISOString() });
    assert.equal(grant.operation, operation, 'a grant keeps exactly its own operation');
  }
  const requested: AgentPostcondition = { kind: 'cowork.request_state', workspaceId: randomUUID(), projectId: same.projectId, connectionId: randomUUID(),
    unitId: same.objectId, requestId: randomUUID(), role: 'execute', version: 1, state: 'queued' };
  const claimed: AgentPostcondition = { kind: 'cowork.claim_state', workspaceId: randomUUID(), projectId: same.projectId, connectionId: randomUUID(),
    unitId: same.objectId, role: 'execute', version: 2, generation: 1, state: 'pending', leaseId: null, leaseSessionId: null, leaseExpiresAt: null, checkpointId: null };
  validateAgentPostconditions('cowork.request', [requested]); validateAgentPostconditions('cowork.claim', [claimed]);
  for (const operation of ['cowork.claim', 'cowork.renew', 'cowork.release'] as const)
    assert.throws(() => validateAgentPostconditions(operation, [requested]), { code: 'COMMAND_POSTSTATE_INVALID' });
  assert.throws(() => validateAgentPostconditions('cowork.request', [claimed]), { code: 'COMMAND_POSTSTATE_INVALID' });
  assert.throws(() => validateAgentPostconditions('work.create', [requested]), { code: 'COMMAND_POSTSTATE_INVALID' });
});

test('request conditions are content-free, exact and singular', () => {
  const condition = { kind: 'cowork.request_state', workspaceId: randomUUID(), projectId: randomUUID(), connectionId: randomUUID(),
    unitId: randomUUID(), requestId: randomUUID(), role: 'plan', version: 1, state: 'queued' };
  validateAgentPostconditions('cowork.request', [condition]);
  for (const state of ['queued', 'deferred', 'claimed', 'resolved', 'declined', 'superseded', 'expired', 'cancelled'])
    validateAgentPostconditions('cowork.request', [{ ...condition, state }]);
  const withoutId = Object.fromEntries(Object.entries(condition).filter(([key]) => key !== 'requestId'));
  for (const changed of [
    withoutId, { ...condition, requestId: 'not-a-uuid' }, { ...condition, unitId: null }, { ...condition, workspaceId: undefined },
    { ...condition, role: 'recipient' }, { ...condition, role: 'help' }, { ...condition, state: 'accepted' }, { ...condition, state: 'acknowledged' },
    { ...condition, version: 0 }, { ...condition, version: 1.5 }, { ...condition, version: 2_147_483_648 },
    // Recipient, kind, references, intent key and any body belong to the fingerprinted payload, never the post-state.
    { ...condition, recipientConnectionId: randomUUID() }, { ...condition, requestKind: 'review' }, { ...condition, intentKey: 'k' },
    { ...condition, body: 'free text' }, { ...condition, id: randomUUID() },
  ]) assert.throws(() => validateAgentPostconditions('cowork.request', [changed]), { code: 'COMMAND_POSTSTATE_INVALID' });
  for (const value of [null, [], [condition, condition], [condition, { ...condition, requestId: randomUUID() }], [condition, { kind: 'work', id: randomUUID(), version: 1 }]])
    assert.throws(() => validateAgentPostconditions('cowork.request', value), { code: 'COMMAND_POSTSTATE_INVALID' });
});

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
    'result.record': [{ kind: 'result', id: uuid() }], 'decision.propose': [{ kind: 'decision', id: uuid(), version: 1 }],
    'map.create': [{ kind: 'map', id: uuid(), version: 1 }], 'map.rename': [{ kind: 'map', id: uuid(), version: 2 }],
    'map.thought.create': [{ kind: 'thought', id: uuid(), version: 1 }, { kind: 'map_checkpoint', id: uuid(), updatedAt: at }],
    'map.thought.update': [{ kind: 'thought', id: uuid(), version: 2 }, { kind: 'map_checkpoint', id: uuid(), updatedAt: at }],
    'map.thought.delete': [{ kind: 'map_checkpoint', id: uuid(), updatedAt: at }],
    'map.positions.update': [{ kind: 'thought', id: uuid(), version: 2 }, { kind: 'map_checkpoint', id: uuid(), updatedAt: at }],
    'map.link.create': [{ kind: 'map_checkpoint', id: uuid(), updatedAt: at }], 'map.link.delete': [{ kind: 'map_checkpoint', id: uuid(), updatedAt: at }],
    'doc.create': [{ kind: 'doc', id: uuid(), version: 1 }], 'doc.update': [{ kind: 'doc', id: uuid(), version: 2 }],
    'conversation.create': [{ kind: 'message', id: uuid() }], 'conversation.reply': [{ kind: 'message', id: uuid() }],
    'cowork.claim': [claim()], 'cowork.renew': [claim()], 'cowork.release': [claim()],
    'cowork.request': [{ kind: 'cowork.request_state', workspaceId: uuid(), projectId: uuid(), connectionId: uuid(), unitId: uuid(),
      requestId: uuid(), role: 'review', version: 1, state: 'queued' }],
    'cowork.request.claim': [{ kind: 'cowork.request_state', workspaceId: uuid(), projectId: uuid(), connectionId: uuid(), unitId: uuid(),
      requestId: uuid(), role: 'review', version: 2, state: 'claimed' }],
    'cowork.request.respond': [{ kind: 'cowork.request_state', workspaceId: uuid(), projectId: uuid(), connectionId: uuid(), unitId: uuid(),
      requestId: uuid(), role: 'review', version: 3, state: 'resolved' }],
    'cowork.unit.create': [{ kind: 'cowork.unit_state', workspaceId: uuid(), projectId: uuid(), unitId: uuid(), taskId: uuid(),
      lineageTaskId: uuid(), runId: uuid(), role: 'review', assignmentConnectionId: uuid(), version: 1, state: 'pending' }],
    'cowork.unit.complete': [{ kind: 'cowork.unit_state', workspaceId: uuid(), projectId: uuid(), unitId: uuid(), taskId: uuid(),
      lineageTaskId: uuid(), runId: uuid(), role: 'execute', assignmentConnectionId: uuid(), version: 3, state: 'completed' }],
    'cowork.unit.transfer': [{ kind: 'cowork.unit_state', workspaceId: uuid(), projectId: uuid(), unitId: uuid(), taskId: uuid(),
      lineageTaskId: uuid(), runId: uuid(), role: 'execute', assignmentConnectionId: uuid(), version: 3, state: 'pending' }],
  };
  for (const operation of AGENT_OPERATIONS) validateAgentPostconditions(operation, samples[operation]);
  // @ts-expect-error a table without its cowork.request entry must not satisfy the exhaustive operation record
  const incomplete: Record<AgentOperation, AgentPostcondition[]> = {} as Omit<typeof samples, 'cowork.request'>;
  assert.equal(incomplete['cowork.request'], undefined);
});

test('doc and conversation commands: creates have no target, changes name their doc or conversation, post-state is exact', () => {
  const projectId = randomUUID();
  const base = { runtimeSessionId: randomUUID(), grantId: randomUUID(), clientCommandId: randomUUID(), projectId,
    peerRequestClass: 'plan' as const, audience: { kind: 'project' as const, projectId }, sources: [], payload: { body: 'Text' } };
  for (const operation of ['doc.create', 'conversation.create'] as const) {
    assert.deepEqual(AGENT_OPERATION_CLASSES[operation], ['execute', 'plan']);
    assert.equal(normalizeAgentExecution({ ...base, operation, objectId: null }).objectId, null);
    assert.throws(() => normalizeAgentExecution({ ...base, operation, objectId: randomUUID() }), invalidInput);
  }
  for (const operation of ['doc.update', 'conversation.reply'] as const) {
    const target = randomUUID();
    assert.equal(normalizeAgentExecution({ ...base, operation, objectId: target }).objectId, target);
    assert.throws(() => normalizeAgentExecution({ ...base, operation, objectId: null }), invalidInput);
    assert.throws(() => normalizeAgentExecution({ ...base, operation, objectId: target, peerRequestClass: 'review' }), invalidInput,
      'review authority never writes docs or messages');
  }
  const id = randomUUID();
  validateAgentPostconditions('doc.update', [{ kind: 'doc', id, version: 3 }]);
  validateAgentPostconditions('conversation.reply', [{ kind: 'message', id }]);
  for (const [operation, value] of [
    ['doc.update', [{ kind: 'doc', id }]], ['doc.update', [{ kind: 'material', id, version: 3 }]], ['doc.create', [{ kind: 'message', id }]],
    ['conversation.reply', [{ kind: 'message', id, version: 1 }]], ['conversation.create', [{ kind: 'message', id, body: 'text' }]],
    ['conversation.create', [{ kind: 'message', id }, { kind: 'message', id: randomUUID() }]], ['conversation.reply', [{ kind: 'doc', id, version: 1 }]],
  ] as const) assert.throws(() => validateAgentPostconditions(operation, value), { code: 'COMMAND_POSTSTATE_INVALID' });
});

test('cowork.unit.create targets the native task; its class is the created role and its post-state is exact', () => {
  assert.deepEqual(AGENT_OPERATION_CLASSES['cowork.unit.create'], ['execute', 'review', 'plan']);
  const projectId = randomUUID(), task = randomUUID();
  const base: AgentExecutionCommand = { runtimeSessionId: randomUUID(), grantId: randomUUID(), clientCommandId: randomUUID(), projectId,
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
  // A unit post-state proves no claim or request, and they prove no creation.
  assert.throws(() => validateAgentPostconditions('cowork.claim', [unit]), { code: 'COMMAND_POSTSTATE_INVALID' });
  assert.throws(() => validateAgentPostconditions('cowork.request', [unit]), { code: 'COMMAND_POSTSTATE_INVALID' });
});

test('cowork.unit.complete/.transfer target the holder\'s unit; their class is its role and their post-state is the unit state', () => {
  const projectId = randomUUID(), unitId = randomUUID();
  for (const operation of ['cowork.unit.complete', 'cowork.unit.transfer'] as const) {
    assert.deepEqual(AGENT_OPERATION_CLASSES[operation], ['execute', 'review', 'plan']);
    const base: AgentExecutionCommand = { runtimeSessionId: randomUUID(), grantId: randomUUID(), clientCommandId: randomUUID(), projectId,
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
