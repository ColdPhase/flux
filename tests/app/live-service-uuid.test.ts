import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { DomainError, liveUseCases, type LivePorts, type LiveSessionRecord } from '@flux/core';

test('a standard UUID can start a live session; malformed context and retry ids are rejected', async () => {
  const projectId = randomUUID();
  const context = { type: 'conversation' as const, id: randomUUID() };
  const clientSessionId = randomUUID();
  const principal = { kind: 'human' as const, id: randomUUID() };
  const roomId = 'live_regression_room';
  const record: LiveSessionRecord = {
    id: randomUUID(), projectId, context, roomId, state: 'available', generation: 1,
    createdBy: principal.id, createdAt: new Date().toISOString(),
  };
  let resolved = 0;
  let created = 0;
  const ports: LivePorts = {
    access: {
      async resolveContext() { resolved++; return { projectId }; },
      async requireProject() {},
      async requirePresentation() {},
    },
    sessions: {
      async createOrGet(caller, locatedProject, locatedContext, key) {
        assert.deepEqual(caller, principal);
        assert.equal(locatedProject, projectId);
        assert.deepEqual(locatedContext, context);
        assert.equal(key, clientSessionId);
        created++;
        return record;
      },
      async find() { return record; },
      async withAdmission(_principal, _sessionId, issue) { return issue(record); },
      async present() {},
    },
    media: {
      async ensureRoom() {},
      async grant() { return { token: 'unused', expiresAt: new Date() }; },
      async participants() { return []; },
      async removeParticipant() {},
      async deleteRoom() {},
    },
    mediaUrl: 'wss://live.example.test',
  };
  const live = liveUseCases(ports);

  const started = await live.start(principal, context, clientSessionId);
  assert.equal(started.id, record.id);
  assert.deepEqual(started.context, context);
  assert.equal(resolved, 1);
  assert.equal(created, 1);

  const malformed = (error: unknown) => error instanceof DomainError && error.code === 'INVALID_INPUT';
  await assert.rejects(live.start(principal, { ...context, id: 'a-b-c-d-e' }, randomUUID()), malformed);
  await assert.rejects(live.start(principal, context, '12345678-1234-1234-123456789012'), malformed);
  assert.equal(resolved, 1, 'invalid IDs stop before context lookup');
  assert.equal(created, 1, 'invalid IDs cannot create a room');
});
