import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { BackgroundComputeUsage, InspectedComparisonSource, InsufficientComparisonOutcome,
  ProactiveComparisonOutcome, ProactiveComparisonProposal } from '@flux/contracts';
import { comparisonOutcomeUseCases, ConflictError, InvalidInputError, NotFoundError, VersionConflictError,
  type ComparisonOutcomePorts, type Principal } from '@flux/core';

const owner: Principal = { kind: 'human', id: 'outcome-owner' };
const projectId = randomUUID();
const sources: InspectedComparisonSource[] = [
  { type: 'result', id: randomUUID(), version: 1, title: 'Human low-light result' },
  { type: 'message', id: randomUUID(), version: 1, title: 'A source whose access was lost', conversationId: randomUUID(),
    excerpted: true, originalCharacters: 5000 },
];
const now = new Date('2026-09-30T08:00:00Z');
const insufficient: InsufficientComparisonOutcome = { kind: 'insufficient_evidence', id: randomUUID(), projectId,
  resultId: sources[0]!.id, ownerUserId: owner.id, agentId: randomUUID(), reason: 'The inspected evidence is not enough.',
  inspectedSources: sources, unavailableSourcesCount: 0, status: 'open', version: 1,
  createdAt: now.toISOString(), updatedAt: now.toISOString() };
const proposal: ProactiveComparisonProposal = { id: randomUUID(), projectId, resultId: sources[0]!.id,
  ownerUserId: owner.id, agentId: insufficient.agentId, audience: { kind: 'project', projectId },
  computeSource: 'owner_background_claude_platform', model: 'claude-sonnet-5', sources,
  fact: 'Camera missed gestures in low light.', interpretation: 'A sensor needs a comparable test.',
  suggestedAction: 'Repeat the same measurements with the sensor.', status: 'proposed', version: 1,
  editedByUserId: null, usedWorkId: null, createdAt: now.toISOString(), updatedAt: now.toISOString() };

function scene(items: ProactiveComparisonOutcome[] = [insufficient]) {
  const calls: string[] = [];
  let current: InsufficientComparisonOutcome | null = structuredClone(insufficient);
  const ports: ComparisonOutcomePorts = {
    access: {
      async requireProject(principal, place, mode) { calls.push(`access:${principal.id}:${place}:${mode}`); },
      async canOpenSource(_principal, _place, source) { return source.id !== sources[1]!.id; },
    },
    outcomes: {
      async listProject(place, limit, offset) {
        calls.push(`page:${place}:${limit}:${offset}`);
        return { items: structuredClone(items.slice(offset, offset + limit)), total: items.length };
      },
      async lockInsufficient() { return current; },
      async dismissInsufficient() {
        current = { ...current!, status: 'dismissed', version: current!.version + 1 };
        return current;
      },
      async ownerUsage(ownerId, at) {
        calls.push(`usage:${ownerId}:${at.toISOString()}`);
        return { asOf: at.toISOString(), utcDayStartsAt: '2026-09-30T00:00:00Z',
          rollingPeriodStartsAt: '2026-08-31T08:00:00Z', startedRequestsToday: 0,
          conservativeCountedCents: 0, observedEstimatedCents: 0, unknownPossibleCents: 0,
          inFlightCents: 0, currentLimits: null, candidates: [] } satisfies BackgroundComputeUsage;
      },
      async usageContext(place, resultId) {
        calls.push(`context:${place}:${resultId}`);
        return { projectTitle: 'Low-light trials', resultTitle: 'Camera missed gestures' };
      },
    },
  };
  return { ports, calls, cases: comparisonOutcomeUseCases({ run: (action) => action(ports) }),
    setCurrent(value: InsufficientComparisonOutcome | null) { current = value; } };
}

test('outcomes page is project-authorized and omits inaccessible inspected/cited titles with a count', async () => {
  const s = scene([insufficient, { kind: 'comparison', proposal, inspectedSources: sources, unavailableSourcesCount: 0 }]);
  const first = await s.cases.list(owner, projectId, 1, 0);
  assert.deepEqual([first.total, first.limit, first.offset], [2, 1, 0]);
  assert.deepEqual(s.calls.slice(0, 2), [`access:${owner.id}:${projectId}:read`, `page:${projectId}:1:0`]);
  assert.deepEqual(first.items[0]!.inspectedSources, [sources[0]]);
  assert.equal(first.items[0]!.unavailableSourcesCount, 1);
  const second = await s.cases.list(owner, projectId, 1, 1);
  assert.equal(second.items[0]!.kind, 'comparison');
  const comparison = second.items[0]! as Extract<ProactiveComparisonOutcome, { kind: 'comparison' }>;
  assert.deepEqual(comparison.proposal.sources, [sources[0]]);
  assert.equal(JSON.stringify([first, second]).includes(sources[1]!.title), false);
  assert.equal(sources.length, 2, 'the stored metadata was not mutated by a reader-specific projection');
});

test('legacy inspected metadata remains unknown even when a cited subset exists', async () => {
  const s = scene([{ kind: 'comparison', proposal, inspectedSources: null, unavailableSourcesCount: 0 }]);
  const item = (await s.cases.list(owner, projectId)).items[0]!;
  assert.equal(item.inspectedSources, null);
  assert.equal(item.unavailableSourcesCount, 0);
});

test('revoked project access denies the page before any outcomes or references are read', async () => {
  const s = scene();
  s.ports.access.requireProject = async () => { throw new NotFoundError('Project'); };
  await assert.rejects(s.cases.list(owner, projectId), NotFoundError);
  assert.deepEqual(s.calls, []);
});

test('dismissal needs current write access and expected version, and returns authorized references', async () => {
  const s = scene();
  await assert.rejects(s.cases.dismiss(owner, insufficient.id, 2), VersionConflictError);
  const changed = await s.cases.dismiss(owner, insufficient.id, 1);
  assert.deepEqual([changed.status, changed.version, changed.unavailableSourcesCount], ['dismissed', 2, 1]);
  assert.deepEqual(changed.inspectedSources, [sources[0]]);
  assert.ok(s.calls.every((call) => call.endsWith(':write')));
  await assert.rejects(s.cases.dismiss(owner, insufficient.id, 2), ConflictError);
  s.setCurrent(null);
  await assert.rejects(s.cases.dismiss(owner, insufficient.id, 1), NotFoundError);
});

test('owner usage has no caller-controlled owner selector and agents cannot read it', async () => {
  const s = scene();
  await s.cases.usage(owner, now);
  assert.deepEqual(s.calls, [`usage:${owner.id}:${now.toISOString()}`]);
  await assert.rejects(async () => s.cases.usage({ kind: 'agent', id: 'another-agent' }, now), InvalidInputError);
  assert.equal(s.calls.length, 1);
});

test('invalid page bounds never reach storage', () => {
  const s = scene();
  for (const [limit, offset] of [[101, 0], [0, 0], [1, -1], [1, 10001]])
    assert.throws(() => s.cases.list(owner, projectId, limit, offset), InvalidInputError);
  assert.deepEqual(s.calls, []);
});


test('usage enriches only current allowed exact pairs, with sorted locks and unchanged owner accounting', async () => {
  const s = scene();
  const denied = '00000000-0000-0000-0000-000000000001';
  const allowed = 'ffffffff-ffff-ffff-ffff-ffffffffffff';
  const resultId = randomUUID();
  const base = await s.ports.outcomes.ownerUsage(owner.id, now);
  const candidate = { id: randomUUID(), projectId: allowed, resultId, ruleId: randomUUID(), status: 'unknown' as const,
    reason: 'DISPATCH_LOST', createdAt: now.toISOString(), reservedAt: now.toISOString(), startedAt: now.toISOString(),
    finishedAt: now.toISOString(), reservedCents: 5, observedUsage: null };
  const original = { ...base, conservativeCountedCents: 15, unknownPossibleCents: 5,
    candidates: [candidate, { ...candidate, id: randomUUID(), projectId: denied, context: { projectTitle: 'Never return stored title', resultTitle: 'Private' } },
      { ...candidate, id: randomUUID() }, { ...candidate, id: randomUUID(), resultId: randomUUID() }] };
  s.calls.length = 0;
  s.ports.outcomes.ownerUsage = async () => structuredClone(original);
  s.ports.access.requireProject = async (_principal, place, mode) => {
    s.calls.push(`access:${place}:${mode}`);
    if (place === denied) throw new NotFoundError('Project');
  };
  s.ports.outcomes.usageContext = async (place, result) => {
    s.calls.push(`context:${place}:${result}`);
    return result === resultId ? { projectTitle: 'Low-light trials', resultTitle: 'Camera missed gestures' } : null;
  };
  const actual = await s.cases.usage(owner, now);
  assert.deepEqual(s.calls, [`access:${denied}:read`, `access:${allowed}:read`,
    `context:${allowed}:${resultId}`, `context:${allowed}:${original.candidates[3]!.resultId}`]);
  assert.deepEqual(actual.candidates.map((row) => row.context), [
    { projectTitle: 'Low-light trials', resultTitle: 'Camera missed gestures' }, null,
    { projectTitle: 'Low-light trials', resultTitle: 'Camera missed gestures' }, null]);
  const withoutContext = (value: BackgroundComputeUsage) => ({ ...value, candidates: value.candidates.map((row) => Object.fromEntries(Object.entries(row).filter(([field]) => field !== 'context'))) });
  assert.deepEqual(withoutContext(actual), withoutContext(original));
  assert.ok(!JSON.stringify(actual).includes('Private'));
});

test('unexpected usage policy and metadata failures propagate rather than claim successful redaction', async () => {
  const s = scene();
  const base = await s.ports.outcomes.ownerUsage(owner.id, now);
  s.ports.outcomes.ownerUsage = async () => ({ ...base, candidates: [{ id: randomUUID(), projectId, resultId: randomUUID(),
    ruleId: randomUUID(), status: 'queued', reason: null, createdAt: now.toISOString(), reservedAt: null,
    startedAt: null, finishedAt: null, reservedCents: 0, observedUsage: null }] });
  s.ports.access.requireProject = async () => { throw new Error('policy unavailable'); };
  await assert.rejects(s.cases.usage(owner, now), /policy unavailable/);
  assert.ok(!s.calls.some((call) => call.startsWith('context:')));
  s.ports.access.requireProject = async () => undefined;
  s.ports.outcomes.usageContext = async () => { throw new Error('metadata unavailable'); };
  await assert.rejects(s.cases.usage(owner, now), /metadata unavailable/);
});
