import assert from 'node:assert/strict';
import { test } from 'node:test';
import { creationUndoEligibility, mayUndoTaskCreation, type TaskCreationUndoFacts } from '@flux/core';

// #238 AC-U1/AC-U2: who may undo, and the bounded read-only reasons, decided only from server-recorded facts.
const agent = { kind: 'agent' as const, id: '00000000-0000-4000-8000-0000000000a1' };
const owner = { kind: 'human' as const, id: 'agent-owner' };
const nativeTask: TaskCreationUndoFacts = { reverted: false, origin: 'native_agent', baselineVersion: 1, version: 1, used: false,
  baselineMatches: true, prerequisites: 0, createdBy: agent, owner: null, creatorAgentOwnerUserId: owner.id };

test('a native agent task is undoable by its agent and the agent owner only, with current write', () => {
  assert.deepEqual(creationUndoEligibility(nativeTask, agent, true), { eligible: true, reason: 'eligible' });
  assert.deepEqual(creationUndoEligibility(nativeTask, owner, true), { eligible: true, reason: 'eligible' });
  assert.deepEqual(creationUndoEligibility(nativeTask, owner, false), { eligible: false, reason: 'not_authorized' }, 'current write is required');
  for (const other of [{ kind: 'human', id: 'unrelated-writer' }, { kind: 'agent', id: '00000000-0000-4000-8000-0000000000b2' }, { kind: 'system', id: 'x' }])
    assert.deepEqual(creationUndoEligibility(nativeTask, other, true), { eligible: false, reason: 'not_authorized' }, JSON.stringify(other));
  // A current human owner of the task qualifies; the owner of a different (assigned) agent does not.
  assert.equal(mayUndoTaskCreation({ ...nativeTask, owner: { kind: 'human', id: 'assignee' } }, { kind: 'human', id: 'assignee' }), true);
  assert.equal(mayUndoTaskCreation({ ...nativeTask, owner: { kind: 'agent', id: 'other-agent' }, creatorAgentOwnerUserId: null }, owner), false);
});

test('a proposal-use task belongs to the person who used the proposal; the suggesting agent gains nothing', () => {
  const human = { kind: 'human' as const, id: 'proposal-user' };
  const used: TaskCreationUndoFacts = { ...nativeTask, origin: 'ai_proposal', createdBy: human, creatorAgentOwnerUserId: null };
  assert.deepEqual(creationUndoEligibility(used, human, true), { eligible: true, reason: 'eligible' });
  assert.deepEqual(creationUndoEligibility(used, agent, true), { eligible: false, reason: 'not_authorized' });
  assert.deepEqual(creationUndoEligibility(used, owner, true), { eligible: false, reason: 'not_authorized' });
});

test('every refusal reason is bounded and decided before authority', () => {
  const cases: [Partial<TaskCreationUndoFacts>, string][] = [
    [{ reverted: true }, 'already_reverted'],
    [{ origin: null, baselineVersion: null }, 'eligibility_unknown'],
    [{ baselineVersion: null }, 'eligibility_unknown'],
    [{ origin: 'human', createdBy: owner, creatorAgentOwnerUserId: null }, 'not_ai_origin'],
    [{ used: true }, 'task_used'],
    [{ version: 2 }, 'creation_changed'],
    [{ baselineMatches: false }, 'creation_changed'],
    [{ prerequisites: 1 }, 'task_used'],
  ];
  for (const [change, reason] of cases)
    assert.deepEqual(creationUndoEligibility({ ...nativeTask, ...change }, agent, true), { eligible: false, reason }, JSON.stringify(change));
  // Negative control: the unchanged facts are eligible, so each refusal above comes from its one change.
  assert.equal(creationUndoEligibility(nativeTask, agent, true).eligible, true);
});
