import assert from 'node:assert/strict';
import { test } from 'node:test';
import { collectComparisonSourceChanges, comparisonChangeWindow, COMPARISON_MAX_WAIT_MS, COMPARISON_QUIET_WINDOW_MS,
  reconsiderComparisonSources, type ComparisonSchedulingPorts, type ComparisonSourceEvent } from '@flux/core';

const start = new Date('2030-01-01T00:00:00Z');
const at = (minutes: number) => new Date(start.getTime() + minutes * 60_000);
function scene(events: ComparisonSourceEvent[] = []) {
  let cursor = 0; let range = { first: events[0]?.seq ?? null, last: events.at(-1)?.seq ?? null };
  const windows = new Map<string, ReturnType<typeof comparisonChangeWindow>>();
  const calls: string[] = [];
  const ports: ComparisonSchedulingPorts = {
    events: { async lockCursor() { return cursor; }, async retainedRange() { return range; },
      async after(seq, limit) { return events.filter((event) => event.seq > seq).slice(0, limit); }, async storeCursor(seq) { cursor = seq; calls.push(`cursor:${seq}`); } },
    projects: { async forHumanSourceEvent() { calls.push('metadata'); return 'project'; }, async enabledAfter() { return []; } },
    changes: { async lockProject(id) { return windows.get(id) ?? null; }, async save(window) { windows.set(window.projectId, window); },
      async dueProjectIds(now) { return [...windows.values()].filter((window) => window.dueAt <= now).map((window) => window.projectId); }, async remove(id) { windows.delete(id); } },
    rules: { async enabledForProject(projectId) { return [{ id: 'rule', ownerUserId: 'owner', agentId: 'agent', projectId }]; } },
    access: { async currentOwnerAndAgent() { calls.push('access'); return true; } },
    sources: { async negativeResultsAfter() { return ['result']; }, async snapshot() { calls.push('snapshot'); return { fingerprint: 'a'.repeat(64) }; } },
    candidates: { async stopObsoleteQueued() { calls.push('obsolete'); return 1; }, async insert() { calls.push('insert'); return true; } },
  };
  return { ports, calls, windows, unit: { run: <T>(action: (value: ComparisonSchedulingPorts) => Promise<T>) => action(ports) },
    cursor: () => cursor, setCursor(value: number) { cursor = value; }, setRange(value: typeof range) { range = value; } };
}

test('human edit bursts extend quiet time but never exceed the first-change maximum', () => {
  let window = comparisonChangeWindow('project', null, start);
  assert.equal(window.dueAt.getTime(), start.getTime() + COMPARISON_QUIET_WINDOW_MS);
  for (let minute = 1; minute <= 20; minute++) window = comparisonChangeWindow('project', window, at(minute));
  assert.equal(window.firstChangedAt.getTime(), start.getTime());
  assert.equal(window.dueAt.getTime(), start.getTime() + COMPARISON_MAX_WAIT_MS);
  const backwards = comparisonChangeWindow('project', window, at(3));
  assert.equal(backwards.lastChangedAt.getTime(), at(20).getTime());
});

test('agent/proposal/private-layout event kinds never request source metadata', async () => {
  const s = scene([
    { seq: 1, actorId: 'agent:agent', kind: 'project.work_updated.v1', objectId: 'project', data: {} },
    { seq: 2, actorId: 'human:owner', kind: 'sketch.changed.v1', objectId: 'sketch', data: { op: 'thoughts_moved' } },
    { seq: 3, actorId: 'human:owner', kind: 'project.proposal_used.v1', objectId: 'project', data: {} },
    { seq: 4, actorId: 'human:owner', kind: 'project.material_updated.v1', objectId: 'project', data: {} },
  ]);
  assert.deepEqual(await collectComparisonSourceChanges(s.unit, start), { processed: 4, marked: 1, cursor: 4, recovered: false });
  assert.deepEqual(s.calls, ['metadata', 'cursor:4']);
});

test('both cursor recovery directions page every enabled project once', async () => {
  for (const [cursor, range] of [[0, { first: 9, last: 12 }], [90, { first: 1, last: 4 }]] as const) {
    const s = scene(); s.setCursor(cursor); s.setRange(range);
    const ids = Array.from({ length: 205 }, (_, n) => `project-${String(n).padStart(3, '0')}`);
    s.ports.projects.enabledAfter = async (after, limit) => ids.filter((id) => after === null || id > after).slice(0, limit);
    const result = await collectComparisonSourceChanges(s.unit, start);
    assert.equal(result.marked, 205); assert.equal(result.recovered, true); assert.equal(s.windows.size, 205);
    assert.equal(s.cursor(), range.last);
    assert.equal((await collectComparisonSourceChanges(s.unit, start)).recovered, false);
  }
});

test('reconsideration checks current policy before selection and pages beyond 100 results', async () => {
  const s = scene(); s.windows.set('project', comparisonChangeWindow('project', null, start));
  assert.deepEqual(await reconsiderComparisonSources(s.unit, at(1)), { processed: 0, created: 0, obsolete: 0 });
  s.ports.access.currentOwnerAndAgent = async () => false;
  assert.deepEqual(await reconsiderComparisonSources(s.unit, at(2)), { processed: 1, created: 0, obsolete: 0 });
  assert.equal(s.calls.includes('snapshot'), false);
  s.windows.set('project', comparisonChangeWindow('project', null, start));
  s.ports.access.currentOwnerAndAgent = async () => { s.calls.push('access'); return true; };
  const ids = Array.from({ length: 123 }, (_, n) => `result-${String(n).padStart(3, '0')}`);
  s.ports.sources.negativeResultsAfter = async (_project, after, limit) => ids.filter((id) => after === null || id > after).slice(0, limit);
  assert.deepEqual(await reconsiderComparisonSources(s.unit, at(2)), { processed: 1, created: 123, obsolete: 123 });
  assert.equal(s.calls[0], 'access');
  assert.equal(s.calls.filter((call) => call === 'snapshot').length, 123);
});
