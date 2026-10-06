import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { DomainError, normalizeCoWorkUnitTransition, requireCoWorkUnitTransition, validateCoWorkUnitTransitionPolicy,
  type CoWorkContext, type CoWorkTransitionUnit, type CoWorkUnitTransitionFacts, type CoWorkUnitTransitionInput } from '@flux/core';

// Pure #153 completion/transfer rules over in-memory facts; the SQL composition is covered by cowork-unit-transitions.
const code = (expected: string) => (error: unknown) => error instanceof DomainError && error.code === expected;
const now = new Date('2026-10-05T12:00:00.000Z');
function scene(role: CoWorkTransitionUnit['role'] = 'execute') {
  const context: CoWorkContext = { workspaceId: randomUUID(), projectId: randomUUID(), connectionId: randomUUID(), agentId: randomUUID(),
    ownerId: 'owner-a', runtimeSessionId: randomUUID() };
  const unit: CoWorkTransitionUnit = { id: randomUUID(), projectId: context.projectId, taskId: randomUUID(), lineageTaskId: randomUUID(),
    runId: randomUUID(), role, assignmentConnectionId: context.connectionId, state: 'claimed', version: 2, generation: 1,
    lease: { id: randomUUID(), runtimeSessionId: context.runtimeSessionId, expiresAt: new Date(now.getTime() + 60_000) } };
  const assignee = { id: randomUUID(), ownerUserId: 'owner-b' };
  const facts: CoWorkUnitTransitionFacts = { unit, openRequests: 0, assignee, now,
    runUnits: [{ id: unit.id, role, assignmentConnectionId: context.connectionId, ownerUserId: 'owner-a' }] };
  const fence = { expectedVersion: 2, generation: 1, leaseId: unit.lease!.id };
  const complete: CoWorkUnitTransitionInput = { operation: 'complete', ...fence, outcome: { type: 'result', id: randomUUID() } };
  const transfer: CoWorkUnitTransitionInput = { operation: 'transfer', ...fence, assignmentConnectionId: assignee.id };
  return { context, unit, assignee, facts, fence, complete, transfer };
}
const policy = { reviewSeparation: 'distinct_connection' as const };

test('payloads are exact: a native outcome or an assignee plus the holder fence; GitHub outcomes stay unavailable', () => {
  const leaseId = randomUUID().toUpperCase(), result = randomUUID().toUpperCase(), assignee = randomUUID().toUpperCase();
  assert.deepEqual(normalizeCoWorkUnitTransition('complete', { expectedVersion: 2, generation: 1, leaseId, outcome: { type: 'result', id: result } }),
    { operation: 'complete', expectedVersion: 2, generation: 1, leaseId: leaseId.toLowerCase(), outcome: { type: 'result', id: result.toLowerCase() } });
  assert.deepEqual(normalizeCoWorkUnitTransition('transfer', { expectedVersion: 2, generation: 1, leaseId, assignmentConnectionId: assignee }),
    { operation: 'transfer', expectedVersion: 2, generation: 1, leaseId: leaseId.toLowerCase(), assignmentConnectionId: assignee.toLowerCase() });
  const fence = { expectedVersion: 2, generation: 1, leaseId };
  for (const payload of [null, [], { ...fence }, { ...fence, outcome: { type: 'result', id: result }, assignmentConnectionId: assignee },
    { ...fence, outcome: { type: 'result', id: result }, prompt: 'x' }, { ...fence, outcome: { type: 'result' } },
    { ...fence, outcome: { type: 'doc', id: result } }, { ...fence, outcome: { type: 'result', id: result, version: 1 } },
    { ...fence, outcome: 'done' }, { expectedVersion: 0, generation: 1, leaseId, outcome: { type: 'result', id: result } },
    { expectedVersion: 2, generation: 0, leaseId, outcome: { type: 'result', id: result } },
    { expectedVersion: 2, generation: 1, leaseId: 'lease', outcome: { type: 'result', id: result } }])
    assert.throws(() => normalizeCoWorkUnitTransition('complete', payload), code('INVALID_INPUT'), JSON.stringify(payload));
  assert.throws(() => normalizeCoWorkUnitTransition('complete', { ...fence,
    outcome: { type: 'github_pr', bindingId: randomUUID(), linkId: randomUUID(), headSha: 'a'.repeat(40) } }), code('COWORK_OUTCOME_UNAVAILABLE'));
  for (const payload of [{ ...fence }, { ...fence, assignmentConnectionId: 'someone' }, { ...fence, assignmentConnectionId: assignee, state: 'pending' },
    { ...fence, assignmentConnectionId: assignee, outcome: { type: 'result', id: result } }])
    assert.throws(() => normalizeCoWorkUnitTransition('transfer', payload), code('INVALID_INPUT'), JSON.stringify(payload));
  assert.throws(() => validateCoWorkUnitTransitionPolicy({ reviewSeparation: 'anyone' as 'distinct_owner' }), /policy is required/);
});

test('only the current holder under its live claim completes or transfers, and nothing addressed to the unit may be open', () => {
  for (const which of ['complete', 'transfer'] as const) {
    const s = scene();
    const input = s[which];
    assert.equal(requireCoWorkUnitTransition(s.context, s.facts, input, policy), s.unit);
    const refuse = (facts: Partial<CoWorkUnitTransitionFacts>, expected: string, change: Partial<CoWorkContext> = {}, inputChange: object = {}) =>
      assert.throws(() => requireCoWorkUnitTransition({ ...s.context, ...change }, { ...s.facts, ...facts },
        { ...input, ...inputChange } as CoWorkUnitTransitionInput, policy), code(expected), `${which}: ${expected}`);
    refuse({ unit: null }, 'COWORK_UNIT_NOT_FOUND');
    refuse({ unit: { ...s.unit, assignmentConnectionId: randomUUID() } }, 'COWORK_UNIT_NOT_FOUND');
    refuse({ unit: { ...s.unit, projectId: randomUUID() } }, 'COWORK_UNIT_NOT_FOUND');
    refuse({}, 'COWORK_VERSION_CONFLICT', {}, { expectedVersion: 3 });
    for (const state of ['pending', 'paused', 'completed', 'stopped'] as const)
      refuse({ unit: { ...s.unit, state, lease: null } }, 'COWORK_CLAIM_LOST');
    refuse({}, 'COWORK_CLAIM_LOST', {}, { generation: 2 });
    refuse({}, 'COWORK_CLAIM_LOST', {}, { leaseId: randomUUID() });
    refuse({}, 'COWORK_CLAIM_LOST', { runtimeSessionId: randomUUID() });
    refuse({ now: s.unit.lease!.expiresAt }, 'COWORK_CLAIM_LOST');
    refuse({ openRequests: 1 }, 'COWORK_UNIT_REQUESTS_OPEN');
  }
});

test('a transfer goes to another eligible connection and keeps author and reviewer apart within the run', () => {
  const s = scene();
  const refuse = (facts: Partial<CoWorkUnitTransitionFacts>, expected: string, inputChange: object = {}, separation = policy) =>
    assert.throws(() => requireCoWorkUnitTransition(s.context, { ...s.facts, ...facts }, { ...s.transfer, ...inputChange } as CoWorkUnitTransitionInput,
      separation), code(expected), expected);
  refuse({}, 'COWORK_ASSIGNMENT_REFUSED', { assignmentConnectionId: s.context.connectionId });
  refuse({ assignee: null }, 'COWORK_ASSIGNEE_UNAVAILABLE');
  refuse({ assignee: { id: randomUUID(), ownerUserId: 'owner-b' } }, 'COWORK_ASSIGNEE_UNAVAILABLE');
  // An execute unit cannot go to the run's reviewer; a review unit cannot go to the run's author.
  const reviewer = { id: randomUUID(), role: 'review' as const, assignmentConnectionId: s.assignee.id, ownerUserId: 'owner-b' };
  refuse({ runUnits: [...s.facts.runUnits, reviewer] }, 'COWORK_REVIEW_SEPARATION');
  const r = scene('review');
  const author = { id: randomUUID(), role: 'execute' as const, assignmentConnectionId: r.assignee.id, ownerUserId: 'owner-b' };
  assert.throws(() => requireCoWorkUnitTransition(r.context, { ...r.facts, runUnits: [...r.facts.runUnits, author] }, r.transfer, policy),
    code('COWORK_REVIEW_SEPARATION'));
  // distinct_owner: the run's author's owner, or an unknown (deleted) owner, cannot receive the review unit.
  const sameOwner = { ...author, assignmentConnectionId: randomUUID(), ownerUserId: 'owner-b' };
  const strict = { reviewSeparation: 'distinct_owner' as const };
  assert.equal(requireCoWorkUnitTransition(r.context, { ...r.facts, runUnits: [...r.facts.runUnits, sameOwner] }, r.transfer, policy), r.unit);
  assert.throws(() => requireCoWorkUnitTransition(r.context, { ...r.facts, runUnits: [...r.facts.runUnits, sameOwner] }, r.transfer, strict),
    code('COWORK_REVIEW_SEPARATION'));
  assert.throws(() => requireCoWorkUnitTransition(r.context, { ...r.facts, runUnits: [...r.facts.runUnits, { ...sameOwner, ownerUserId: null }] },
    r.transfer, strict), code('COWORK_REVIEW_SEPARATION'));
  assert.equal(requireCoWorkUnitTransition(r.context, { ...r.facts, runUnits: [...r.facts.runUnits, { ...sameOwner, ownerUserId: 'owner-c' }] },
    r.transfer, strict), r.unit);
  // A plan unit has no opposite role.
  const p = scene('plan');
  assert.equal(requireCoWorkUnitTransition(p.context, { ...p.facts, runUnits: [...p.facts.runUnits, reviewer, author] }, p.transfer, strict), p.unit);
});
