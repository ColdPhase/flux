import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, test } from 'node:test';
import { createTaskDiscussionUseCases, DomainError, ForbiddenError, InvalidInputError, NotFoundError,
  type DiscussionMessage, type Principal, type TaskDiscussionPorts } from '@flux/core';

// Pure task-discussion rules (#154) over in-memory ports: no database, no network.

const ids = { work: randomUUID(), project: randomUUID(), workspace: randomUUID(), conversation: randomUUID(), root: randomUUID() };
const caller: Principal = { kind: 'human', id: randomUUID() };
const author = { kind: 'human' as const, id: randomUUID() };
const created = new Date('2026-10-01T10:00:00.000Z');
const command = () => ({ body: 'A genuine contribution.', clientMessageId: randomUUID() });

interface Options { bound?: boolean; visible?: boolean; writable?: boolean; rootSequence?: number; rootProject?: string; hasRoot?: boolean }

/** One task in one project; every write port records its use so a read can prove it wrote nothing. */
function world({ bound = false, visible = true, writable = true, rootSequence = 1, rootProject = ids.project, hasRoot = true }: Options = {}) {
  const access: Array<{ action: string; projectId: string; lock: boolean | undefined }> = [];
  const writes: string[] = [];
  const root: DiscussionMessage = { id: ids.root, conversationId: ids.conversation, author, body: 'The first genuine message.', source: null,
    sequence: rootSequence, projectId: rootProject, clientMessageId: randomUUID(), requestFingerprint: 'fingerprint', kind: 'text', resultId: null, createdAt: created };
  const ports: TaskDiscussionPorts = {
    access: {
      async requireProject(_principal, action, projectId, options) {
        access.push({ action, projectId, lock: options?.lock });
        if (!visible) throw new NotFoundError('Project', 'PROJECT_NOT_FOUND');
        if (action === 'write' && !writable) throw new ForbiddenError('Not allowed to perform this action on the project');
        return { workspaceId: ids.workspace };
      },
      async requireWorkspace() { writes.push('access.requireWorkspace'); },
      async canRead() { return true; },
    },
    work: {
      async locate(_type, id) { return id === ids.work ? { projectId: ids.project } : null; },
      async findWork(id) { return id === ids.work ? ({ id } as never) : null; },
      async names() { return new Map(); },
    },
    discussion: {
      async lockCommand() { writes.push('lockCommand'); },
      async existingMessage() { return null; },
      // The stored row carries more than the contract, exactly like the database adapter returns it.
      async findBinding(workId) {
        return bound ? { workId, workspaceId: ids.workspace, projectId: ids.project, conversationId: ids.conversation,
          rootMessageId: ids.root, rootSequence: 1 } as never : null;
      },
      async findConversation() { return null; },
      async findMessage(id) { return hasRoot && id === ids.root ? root : null; },
      async messages() { return [root]; },
      async sourceExists() { return true; },
      async createConversation() { writes.push('createConversation'); throw new Error('a read must not create a conversation'); },
      async append() { writes.push('append'); throw new Error('a read must not append'); },
      async bind() { writes.push('bind'); },
    },
    events: { async record() { writes.push('events.record'); } },
  };
  return { use: createTaskDiscussionUseCases({ run: (action) => action(ports) }), access, writes };
}

const failure = async (action: Promise<unknown>) => {
  try { await action; } catch (error) { return error as DomainError; }
  return assert.fail('expected the operation to fail');
};
const shape = (error: DomainError) => ({ type: error.constructor.name, status: error.status, code: error.code, message: error.message });
const declared = ['conversationId', 'messagePage', 'messages', 'projectId', 'root', 'rootMessageId', 'workId', 'workspaceId'];

describe('task discussion existence', () => {
  const operations = {
    getDiscussion: (use: ReturnType<typeof world>['use'], workId: string) => use.getDiscussion(caller, workId),
    getDiscussionRoot: (use: ReturnType<typeof world>['use'], workId: string) => use.getDiscussionRoot(caller, workId),
    contribute: (use: ReturnType<typeof world>['use'], workId: string) => use.contribute(caller, workId, command()),
  };

  for (const [name, operate] of Object.entries(operations)) {
    test(`${name}: a task in a project the caller cannot see is reported exactly like an unknown task`, async () => {
      const hidden = world({ visible: false });
      const unknown = world({ visible: false });
      const hiddenTask = shape(await failure(operate(hidden.use, ids.work)));
      const unknownTask = shape(await failure(operate(unknown.use, randomUUID())));
      assert.deepEqual(hiddenTask, unknownTask, 'identical type, status, code and message');
      assert.deepEqual(hiddenTask, { type: 'NotFoundError', status: 404, code: 'WORK_NOT_FOUND', message: 'Work item not found' });
      assert.deepEqual(hidden.writes, []);
    });
  }

  test('a visible task the caller may not change stays forbidden rather than hidden', async () => {
    const error = await failure(world({ writable: false }).use.contribute(caller, ids.work, command()));
    assert.equal(error.status, 403);
    assert.equal(error.code, 'FORBIDDEN');
  });

  test('every read and command rejects a non-UUID task id with the same 400', async () => {
    const { use } = world();
    for (const operate of Object.values(operations)) {
      const error = await failure(operate(use, 'not-a-task'));
      assert.ok(error instanceof InvalidInputError);
      assert.deepEqual([error.status, error.code], [400, 'INVALID_INPUT']);
    }
  });
});

describe('task discussion response contract', () => {
  test('getDiscussion returns exactly the declared keys, unbound and bound', async () => {
    const unbound = await world().use.getDiscussion(caller, ids.work);
    assert.deepEqual(Object.keys(unbound).sort(), declared);
    assert.deepEqual(unbound, { workId: ids.work, workspaceId: ids.workspace, projectId: ids.project, conversationId: null,
      rootMessageId: null, root: null, messages: [], messagePage: { hasMoreBefore: false, nextBeforeSequence: null, limit: 50 } });
    const bound = await world({ bound: true }).use.getDiscussion(caller, ids.work);
    assert.deepEqual(Object.keys(bound).sort(), declared, 'the stored binding row (rootSequence) is not part of the contract');
    assert.equal(bound.conversationId, ids.conversation);
    assert.equal(bound.rootMessageId, ids.root);
    assert.equal(bound.root?.sequence, 1);
  });
});

describe('getDiscussionRoot', () => {
  test('is null while the visible task has no genuine contribution', async () => {
    const { use, writes } = world();
    assert.equal(await use.getDiscussionRoot(caller, ids.work), null);
    assert.equal(await use.getDiscussionRoot(caller, ids.work.toUpperCase()), null);
    assert.deepEqual(writes, []);
  });

  test('returns exactly the canonical identity keys and nothing from the stored row', async () => {
    const { use, writes } = world({ bound: true });
    const expected = { workId: ids.work, workspaceId: ids.workspace, projectId: ids.project,
      conversationId: ids.conversation, rootMessageId: ids.root };
    assert.deepEqual(await use.getDiscussionRoot(caller, ids.work), expected);
    assert.deepEqual(await use.getDiscussionRoot(caller, ids.work.toUpperCase()), expected, 'task ids are case-insensitive');
    const discussion = await use.getDiscussion(caller, ids.work);
    assert.deepEqual({ workId: discussion.workId, workspaceId: discussion.workspaceId, projectId: discussion.projectId,
      conversationId: discussion.conversationId, rootMessageId: discussion.rootMessageId }, expected);
    assert.deepEqual(writes, [], 'repeated reads create no conversation, message, binding or event');
  });

  test('asks for current project.read without the access-row lock; the window read keeps it', async () => {
    const root = world({ bound: true });
    await root.use.getDiscussionRoot(caller, ids.work);
    assert.deepEqual(root.access, [{ action: 'read', projectId: ids.project, lock: false }]);
    const window = world({ bound: true });
    await window.use.getDiscussion(caller, ids.work);
    assert.deepEqual(window.access, [{ action: 'read', projectId: ids.project, lock: true }]);
  });

  test('refuses a stored root that is not the exact sequence-1 message of its conversation and project', async () => {
    for (const broken of [{ rootSequence: 2 }, { hasRoot: false }, { rootProject: randomUUID() }]) {
      const { use } = world({ bound: true, ...broken });
      await assert.rejects(use.getDiscussionRoot(caller, ids.work), /Task discussion root invariant failed/);
      await assert.rejects(use.getDiscussion(caller, ids.work), /Task discussion root invariant failed/);
    }
  });
});
