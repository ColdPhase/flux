import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { agentProjectReads, DomainError, type AgentConnectionContext } from '@flux/core';

test('malformed project and object IDs are refused before any object lookup', async () => {
  const projectId = randomUUID();
  const workspaceId = randomUUID();
  const context: AgentConnectionContext = { connectionId: randomUUID(), ownerUserId: 'owner', agentId: randomUUID(), computeSource: 'user_operated_external_client' };
  let lookups = 0;
  const reads = agentProjectReads({ async scopeOf() { lookups++; return { workspaceId, projectId }; } });
  await assert.rejects(reads.requireObject(context, workspaceId, 'not-a-project-id', 'work', randomUUID()),
    (error: unknown) => error instanceof DomainError && error.code === 'PROJECT_NOT_FOUND');
  assert.equal(lookups, 0);
  await assert.rejects(reads.requireObject(context, workspaceId, projectId, 'doc', 'bad-id'),
    (error: unknown) => error instanceof DomainError && error.code === 'OBJECT_NOT_FOUND');
  assert.equal(lookups, 0);
  await reads.requireObject(context, workspaceId, projectId, 'doc', randomUUID());
  assert.equal(lookups, 1);
});

test('foreign workspace/project and missing metadata return the same content-free error', async () => {
  const projectId = randomUUID(); const workspaceId = randomUUID();
  const context: AgentConnectionContext = { connectionId: randomUUID(), ownerUserId: 'owner', agentId: randomUUID(),
    computeSource: 'user_operated_external_client' };
  for (const scope of [null, { workspaceId: randomUUID(), projectId }, { workspaceId, projectId: randomUUID() }]) {
    const reads = agentProjectReads({ scopeOf: async () => scope });
    await assert.rejects(reads.requireObject(context, workspaceId, projectId, 'material', randomUUID()),
      (error: unknown) => error instanceof DomainError && error.code === 'OBJECT_NOT_FOUND' && error.status === 404);
  }
});
