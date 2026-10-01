import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { agentOrientationUseCases, DomainError, normalizeAgentCheckpoint, type AgentConnectionContext } from '@flux/core';

const workspaceId = randomUUID(), projectId = randomUUID();
const context: AgentConnectionContext = { connectionId: randomUUID(), ownerUserId: randomUUID(), agentId: randomUUID(),
  scopes: ['flux.context.read'], selectedProjectIds: [projectId], computeSource: 'user_operated_external_client' };

test('orientation rejects unselected projects and malformed/duplicate checkpoints before querying metadata', async () => {
  let queried = false;
  const reads = agentOrientationUseCases({ list: async () => { queried = true; return { items: [], total: 0 }; },
    find: async () => { queried = true; return null; } });
  await assert.rejects(reads.list(context, { workspaceId, projectId: randomUUID() }, 'work'),
    (error: unknown) => error instanceof DomainError && error.code === 'PROJECT_NOT_FOUND');
  for (const known of [[{ kind: 'conversation', id: randomUUID(), sequence: -1 }],
    [{ kind: 'work', id: randomUUID(), version: 2_147_483_648 }]]) {
    await assert.rejects(reads.changes(context, { workspaceId, projectId }, known as Parameters<typeof reads.changes>[2]));
  }
  const id = randomUUID();
  await assert.rejects(reads.changes(context, { workspaceId, projectId }, [{ kind: 'result', id }, { kind: 'result', id: id.toUpperCase() }]));
  assert.equal(queried, false);
  assert.throws(() => normalizeAgentCheckpoint({ kind: 'result', id, version: 1 } as never));
});

test('map checkpoint changes despite an unchanged map row version and index adapters cannot cross scope', async () => {
  const id = randomUUID();
  const reference = { workspaceId, projectId, title: 'Canonical map', state: null,
    checkpoint: { kind: 'map' as const, id, version: 1, updatedAt: '2026-10-01T10:00:00.001Z' } };
  const reads = agentOrientationUseCases({ list: async () => ({ items: [reference], total: 1 }), find: async () => reference });
  const result = await reads.changes(context, { workspaceId, projectId }, [{ ...reference.checkpoint, updatedAt: '2026-10-01T10:00:00.000Z' }]);
  assert.equal(result.changed.length, 1); assert.deepEqual(result.unchanged, []);
  assert.equal(result.coverage, 'supplied_references_only');
  const faulty = agentOrientationUseCases({ list: async () => ({ items: [{ ...reference, projectId: randomUUID() }], total: 1 }), find: async () => null });
  await assert.rejects(faulty.list(context, { workspaceId, projectId }, 'map'));
});
