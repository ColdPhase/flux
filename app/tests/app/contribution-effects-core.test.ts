import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { describe, test } from 'node:test';
import {
  ConflictError, contributionIdentity, createTaskDiscussionUseCases, createWorkContributions, createWorkUseCases, derivedUuid,
  ForbiddenError, InvalidInputError, normalizeMessage, RuleViolationError, VersionConflictError,
  type ActorRef, type DiscussionMessage, type NativeCommandReceipt, type NewDiscussionMessage, type Principal,
  type TaskDiscussionPorts, type WorkAccess, type WorkPorts, type WorkRecord, type WorkRepository,
} from '@flux/core';

// Pure rules of the explicit native contribution effects (#154) over in-memory ports: no database, no network.
// The log records every lock and write in call order, so the order contract is asserted, not assumed.

const workspaceId = randomUUID();
const projectId = randomUUID();
const writer: Principal = { kind: 'human', id: 'writer-1' };
const agent: Principal = { kind: 'agent', id: randomUUID() };
const at = new Date('2026-10-01T10:00:00.000Z');

function world(options: { writable?: boolean; taskIds?: string[]; hook?: boolean; prerequisites?: Record<string, string[]> } = {}) {
  const log: string[] = [];
  const tasks = new Map<string, WorkRecord>();
  const taskIds = options.taskIds ?? [randomUUID(), randomUUID(), randomUUID()];
  for (const [index, id] of taskIds.entries()) tasks.set(id, { id, workspaceId, projectId, number: index + 1, title: `Task ${id.slice(0, 4)}`, outcome: '', criteria: [], status: 'open', blocker: null, waitingFor: null, waitingOn: null, dropped: false, cameOfIt: null, dueOn: null,
    owner: null, createdBy: { kind: 'human', id: 'creator' }, version: 1, createdAt: at, updatedAt: at });
  const messages: DiscussionMessage[] = [];
  const conversations = new Map<string, { id: string; workspaceId: string; projectId: string; createdBy: ActorRef; createdAt: Date }>();
  const bindings = new Map<string, { workId: string; workspaceId: string; projectId: string; conversationId: string; rootMessageId: string }>();
  const receipts = new Map<string, NativeCommandReceipt>();
  const events: Array<{ kind: string; data: Record<string, unknown> }> = [];
  const key = (by: ActorRef, operation: string, commandId: string) => `${by.kind}:${by.id}:${operation}:${commandId}`;
  const copy = (row: WorkRecord) => structuredClone(row);
  const lockPreparedTaskUse = async (input: readonly string[]) => {
    const ids = [...new Set(input)].sort();
    log.push(`task.pass:${ids.join(',')}`);
    for (const id of ids) {
      log.push(`task.lock:${id}`);
      if (!tasks.has(id)) throw new RuleViolationError('A task target is unavailable', 'TASK_TARGET_NOT_FOUND');
      if (tasks.get(id)!.creationRevertedAt) throw new ConflictError('Task creation was undone', 'TASK_CREATION_REVERTED');
    }
    return { ids, projectIds: [projectId], async mark(used = ids) {
      if (used.some((id) => !ids.includes(id))) throw new Error('Unretained task use');
      for (const id of used) tasks.get(id)!.firstPersistedUseAt ??= at;
    } };
  };

  const access: WorkAccess = {
    async requireProject(_principal, action, _project, opts) {
      if (opts?.lock) log.push('access.lock');
      if (action === 'write' && options.writable === false) throw new ForbiddenError('Not allowed to perform this action on the project');
      return { workspaceId };
    },
    async requireWorkspace() { /* not used */ },
    async canRead() { return true; },
    async aiAllowed() { return true; },
  };
  const work = {
    async locate(_type: string, id: string) { return tasks.has(id) ? { projectId } : null; },
    async findWork(id: string, opts?: { lock?: boolean }) {
      if (opts?.lock) log.push(`task.lock:${id}`);
      const row = tasks.get(id);
      return row ? copy(row) : null;
    },
    async insertTaskUpdate() { /* the conversation line of a block or unblock (#550) is not part of this order */ },
    // Nothing waits for a task or a decision in these runs (#868); the real rows are covered by task-statuses.test.ts.
    async waiters() { return []; },
    async waitingTargets() { return new Map(); },
    async waitsFor() { return false; },
    async updateWork(id: string, changes: Partial<WorkRecord>) {
      log.push('work.update');
      const row = tasks.get(id)!;
      Object.assign(row, changes, { version: row.version + 1 });
      return copy(row);
    },
    async nativeCommand(_project: string, by: ActorRef, operation: string, commandId: string) {
      log.push(`receipt.lock:${commandId}`);
      return receipts.get(key(by, operation, commandId)) ?? null;
    },
    async recordNativeCommand(_scope: unknown, by: ActorRef, receipt: NativeCommandReceipt) {
      log.push('receipt.record');
      receipts.set(key(by, receipt.operation, receipt.commandId), structuredClone(receipt));
    },
    async insertLinks() { log.push('links.insert'); return []; },
    async links() { return []; },
    async titles() { return new Map(); },
    async names() { return new Map(); },
    async targetExists(_project: string, ref: { type: string; id: string }) { return ref.type !== 'work' || tasks.has(ref.id); },
    async taskUseTargets(refs: readonly { type: string; id: string }[]) { return [...new Set(refs.filter((ref) => ref.type === 'work').map((ref) => ref.id))].sort(); },
    lockPreparedTaskUse,
    async prepareTaskUse(ids: readonly string[]) { log.push('graph.lock'); return lockPreparedTaskUse(ids); },
    // The #152 task graph: the project graph lock and the complete sorted task pass.
    async taskPlans() { return new Map(); },
    async githubRules() { return new Map(); },
    async suspendGithubRule() { return false; },
    async lockTaskGraphs() { log.push('graph.lock'); },
    async directPrerequisiteIds(_workspace: string, ids: readonly string[]) {
      return [...new Set(ids.flatMap((id) => options.prerequisites?.[id] ?? []))].sort();
    },
    async lockTasks(_workspace: string, ids: readonly string[]) {
      log.push(`task.pass:${ids.join(',')}`);
      return ids.filter((id) => tasks.has(id)).map((id) => ({ id, projectId }));
    },
    async prerequisiteStates(_workspace: string, id: string) {
      return { projectId, prerequisites: (options.prerequisites?.[id] ?? []).map((prerequisite) => ({ id: prerequisite, status: tasks.get(prerequisite)!.status })) };
    },
    async replaceDependencies() { log.push('graph.edges'); },
  } as unknown as WorkRepository;
  const discussion: TaskDiscussionPorts['discussion'] = {
    async lockCommand(_project, _author, commandId) { log.push(`identity.lock:${commandId}`); },
    async existingMessage(_project, author, commandId) {
      return messages.find((row) => row.author.kind === author.kind && row.author.id === author.id && row.clientMessageId === commandId) ?? null;
    },
    async findBinding(workId) { log.push(`binding:${workId}`); return bindings.get(workId) ? { ...bindings.get(workId)!, rootSequence: 1 } as never : null; },
    async findConversation(id) { return conversations.get(id) ?? null; },
    async findMessage(id) { return messages.find((row) => row.id === id) ?? null; },
    async messages() { return [...messages].reverse(); },
    async sourceExists() { return true; },
    async taskOf(conversationId) { return [...bindings.values()].find((binding) => binding.conversationId === conversationId)?.workId ?? null; },
    async trailingAgentMessages() { return 0; },
    async createConversation(input) {
      log.push('conversation.create');
      const row = { ...input, createdAt: at };
      conversations.set(row.id, row);
      return row;
    },
    async append(conversation, author, input: NewDiscussionMessage) {
      log.push(`append:${input.kind ?? 'text'}`);
      const sequence = messages.filter((row) => row.conversationId === conversation.id).length + 1;
      const row: DiscussionMessage = { id: randomUUID(), conversationId: conversation.id, author, body: input.body, source: input.source, sequence,
        projectId: conversation.projectId, clientMessageId: input.clientMessageId, requestFingerprint: input.fingerprint,
        kind: input.kind ?? 'text', createdAt: at };
      messages.push(row);
      return row;
    },
    async bind(input) { log.push(`bind:${input.workId}`); bindings.set(input.workId, input); },
  };
  const eventLog = { async record(_principal: Principal, _workspace: string, kind: string, _project: string, data: Record<string, unknown>) {
    log.push(`event:${kind}`); events.push({ kind, data });
  } };
  const discussionPorts: TaskDiscussionPorts = { access, work, discussion, events: eventLog as TaskDiscussionPorts['events'] };
  const ports: WorkPorts = { access, work, events: eventLog as WorkPorts['events'], contributions: createWorkContributions(discussionPorts) };
  return {
    log, tasks, taskIds, messages, receipts, events, bindings, conversations, ports,
    use: createWorkUseCases({ run: (action) => action(ports) }),
    discussion: createTaskDiscussionUseCases({ run: (action) => action(discussionPorts) }),
  };
}

const index = (log: string[], prefix: string) => log.findIndex((line) => line.startsWith(prefix));

describe('an explicitly saved nonempty blocker contributes its exact text', () => {
  test('the saved text, trimmed as saved, becomes one authored blocker contribution with the task change', async () => {
    const w = world();
    const [task] = w.taskIds as [string];
    const view = await w.use.updateWork(writer, task, { status: 'blocked', blocker: '  Waiting for the hinge  ' }, 1);
    assert.equal(view.blocker, 'Waiting for the hinge');
    assert.equal(w.messages.length, 1);
    const [message] = w.messages;
    assert.deepEqual([message!.body, message!.kind, message!.author, message!.sequence],
      ['Waiting for the hinge', 'blocker', { kind: 'human', id: 'writer-1' }, 1]);
    assert.equal(w.bindings.get(task)!.rootMessageId, message!.id, 'the first contribution is the canonical root');
    assert.deepEqual(w.events.map((event) => event.kind), ['project.work_updated.v1', 'project.conversation_created.v1']);
  });

  test('an agent saving a blocker is the genuine author, never a person', async () => {
    const w = world();
    await w.use.updateWork(agent, w.taskIds[0]!, { status: 'blocked', blocker: 'Needs a calibration run' }, 1);
    assert.deepEqual(w.messages[0]!.author, { kind: 'agent', id: agent.id });
  });

  test('the order is access, command identity, message identity, task lock, task change, event, append, receipt', async () => {
    const w = world();
    const commandId = randomUUID();
    await w.use.updateWork(writer, w.taskIds[0]!, { status: 'blocked', blocker: 'Waiting', clientCommandId: commandId }, 1);
    const order = ['access.lock', 'receipt.lock:', 'identity.lock:', 'task.lock:', 'work.update', 'event:project.work_updated', 'append:blocker', 'receipt.record'];
    const positions = order.map((prefix) => index(w.log, prefix));
    assert.ok(positions.every((position) => position >= 0), `every step ran: ${w.log.join(' > ')}`);
    assert.deepEqual([...positions].sort((a, b) => a - b), positions, `in this order: ${w.log.join(' > ')}`);
    assert.ok(index(w.log, 'task.lock:') > index(w.log, 'identity.lock:'), 'no task lock before the command identities');
  });

  test('clearing a blocker, changing status/owner/text, or saving nothing contributes nothing', async () => {
    const w = world();
    const task = w.taskIds[0]!;
    let version: number = (await w.use.updateWork(writer, task, { status: 'blocked', blocker: 'First reason' }, 1)).version;
    assert.equal(w.messages.length, 1);
    const logBefore = w.log.length;
    for (const change of [{ blocker: null }, { blocker: '' }] as const) {
      version = (await w.use.updateWork(writer, task, { status: 'blocked', blocker: 'Again' }, version)).version;
      const before: number = w.messages.length;
      version = (await w.use.updateWork(writer, task, { ...change }, version)).version;
      assert.equal(w.messages.length, before, `clearing with ${JSON.stringify(change)} adds no message`);
    }
    for (const change of [{ status: 'in_progress' }, { title: 'Renamed' }, { outcome: 'A new outcome' }, { owner: { kind: 'human' as const, id: 'writer-1' } }] as const) {
      const before: number = w.messages.length;
      version = (await w.use.updateWork(writer, task, { ...change }, version)).version;
      assert.equal(w.messages.length, before, `${Object.keys(change)[0]} alone adds no message`);
    }
    assert.ok(w.log.length > logBefore);
    assert.deepEqual(w.messages.map((row) => row.body), ['First reason', 'Again', 'Again']);
    assert.ok(w.messages.every((row) => row.kind === 'blocker'));
    const quiet = w.log.slice(logBefore).filter((line) => line.startsWith('identity.lock:'));
    assert.equal(quiet.length, 2, 'only the two explicit nonempty saves prepared a message identity');
  });

  test('a blocker without a blocked status is rejected before anything is written', async () => {
    const w = world();
    await assert.rejects(w.use.updateWork(writer, w.taskIds[0]!, { blocker: 'Not blocked' }, 1), InvalidInputError);
    assert.deepEqual([w.messages.length, w.events.length, w.tasks.get(w.taskIds[0]!)!.version], [0, 0, 1]);
  });

  test('a stale version conflicts and contributes nothing, with or without a command UUID', async () => {
    const w = world();
    const task = w.taskIds[0]!;
    await w.use.updateWork(writer, task, { title: 'Moved on' }, 1);
    for (const clientCommandId of [undefined, randomUUID()]) {
      await assert.rejects(w.use.updateWork(writer, task, { status: 'blocked', blocker: 'Stale', ...(clientCommandId ? { clientCommandId } : {}) }, 1), VersionConflictError);
    }
    assert.equal(w.messages.length, 0);
    assert.equal(w.receipts.size, 0);
  });

  test('a viewer cannot save a blocker and nothing is contributed', async () => {
    const w = world({ writable: false });
    await assert.rejects(w.use.updateWork(writer, w.taskIds[0]!, { status: 'blocked', blocker: 'No' }, 1), ForbiddenError);
    assert.equal(w.messages.length, 0);
  });
});

describe('an exact retry of a native command returns its original outcome', () => {
  test('the same client command and intent appends no second message, event, receipt or version', async () => {
    const w = world();
    const task = w.taskIds[0]!;
    const command = { status: 'blocked' as const, blocker: 'Waiting for the hinge', clientCommandId: randomUUID() };
    const first = await w.use.updateWork(writer, task, command, 1);
    const events = w.events.length;
    const second = await w.use.updateWork(writer, task, command, 1);
    assert.deepEqual(second, first);
    assert.deepEqual([w.messages.length, w.events.length, w.receipts.size, w.tasks.get(task)!.version], [1, events, 1, 2]);
  });

  test('a changed intent under the same command conflicts; changed produced task state is stale, never overwritten', async () => {
    const w = world();
    const task = w.taskIds[0]!;
    const command = { status: 'blocked' as const, blocker: 'Waiting', clientCommandId: randomUUID() };
    await w.use.updateWork(writer, task, command, 1);
    await assert.rejects(w.use.updateWork(writer, task, { ...command, blocker: 'A different blocker' }, 1),
      (error) => error instanceof ConflictError && error.code === 'IDEMPOTENCY_CONFLICT');
    await assert.rejects(w.use.updateWork(writer, task, command, 2), (error) => error instanceof ConflictError && error.code === 'IDEMPOTENCY_CONFLICT',
      'the expected version is part of the intent');
    await w.use.updateWork(writer, task, { title: 'Someone else moved it' }, 2);
    await assert.rejects(w.use.updateWork(writer, task, command, 1), (error) => error instanceof ConflictError && error.code === 'COMMAND_POSTSTATE_STALE');
    assert.deepEqual([w.messages.length, w.tasks.get(task)!.title, w.tasks.get(task)!.version], [1, 'Someone else moved it', 3]);
  });

  test('a replay is checked against current authorization first and writes nothing when refused', async () => {
    const w = world();
    const command = { status: 'blocked' as const, blocker: 'Waiting', clientCommandId: randomUUID() };
    await w.use.updateWork(writer, w.taskIds[0]!, command, 1);
    const sealed = createWorkUseCases({ run: (action) => action({ ...w.ports, access: { ...w.ports.access,
      async requireProject() { throw new ForbiddenError('Not allowed to perform this action on the project'); } } }) });
    await assert.rejects(sealed.updateWork(writer, w.taskIds[0]!, command, 1), ForbiddenError);
    assert.equal(w.messages.length, 1);
  });

  test('the receipt is scoped to the real actor: another actor with the same UUID executes its own command', async () => {
    const w = world();
    const commandId = randomUUID();
    const view = await w.use.updateWork(writer, w.taskIds[0]!, { status: 'blocked', blocker: 'By a person', clientCommandId: commandId }, 1);
    await w.use.updateWork(agent, w.taskIds[0]!, { blocker: 'By an agent', clientCommandId: commandId }, view.version);
    assert.deepEqual(w.messages.map((row) => [row.author.kind, row.body]), [['human', 'By a person'], ['agent', 'By an agent']]);
    assert.equal(w.receipts.size, 2);
  });

  test('without a command UUID nothing deduplicates, but the version fence stops a stale identical retry', async () => {
    const w = world();
    const task = w.taskIds[0]!;
    const command = { status: 'blocked' as const, blocker: 'Waiting' };
    await w.use.updateWork(writer, task, command, 1);
    await assert.rejects(w.use.updateWork(writer, task, command, 1), VersionConflictError);
    assert.equal(w.messages.length, 1);
    assert.equal(w.receipts.size, 0);
  });
});

describe('the line saved at Done contributes to the finished task', () => {
  test('the saved text, trimmed as saved, becomes one authored "what came of it" contribution with the task change', async () => {
    const w = world();
    const [task] = w.taskIds as [string];
    const view = await w.use.updateWork(writer, task, { status: 'done', cameOfIt: '  The hinge holds at 40 N  ' }, 1);
    assert.equal(view.cameOfIt, 'The hinge holds at 40 N');
    assert.deepEqual(w.messages.map((row) => [row.kind, row.body, row.author]), [['came_of_it', 'The hinge holds at 40 N', { kind: 'human', id: 'writer-1' }]]);
    assert.equal(w.tasks.get(task)!.status, 'done');
    assert.ok(w.bindings.has(task), 'the task has its explicit root');
    const order = ['access.lock', 'identity.lock:', 'task.lock:', 'work.update', 'append:came_of_it'];
    const positions = order.map((prefix) => index(w.log, prefix));
    assert.ok(positions.every((position) => position >= 0), `every step ran: ${w.log.join(' > ')}`);
    assert.deepEqual([...positions].sort((a, b) => a - b), positions, `in this order: ${w.log.join(' > ')}`);
  });

  test('an agent finishing a task with a line is the genuine author', async () => {
    const w = world();
    await w.use.updateWork(agent, w.taskIds[0]!, { status: 'done', cameOfIt: 'Agent measured it' }, 1);
    assert.deepEqual(w.messages.map((row) => row.author), [{ kind: 'agent', id: agent.id }]);
  });

  test('finishing without a line, or with an empty one, contributes nothing', async () => {
    const w = world();
    const [a, b] = w.taskIds as [string, string];
    await w.use.updateWork(writer, a, { status: 'done' }, 1);
    await w.use.updateWork(writer, b, { status: 'done', cameOfIt: '' }, 1);
    assert.deepEqual([w.messages.length, w.bindings.size], [0, 0]);
  });

  test('message identities derive from the command and the exact task, so a different command or task never collides', () => {
    const task = randomUUID();
    const commandA = randomUUID();
    const commandB = randomUUID();
    const draft = (workId: string) => ({ workId, kind: 'came_of_it' as const, body: 'Title' });
    const one = contributionIdentity({ operation: 'work.update', commandId: commandA }, draft(task));
    assert.deepEqual(one, contributionIdentity({ operation: 'work.update', commandId: commandA.toUpperCase() }, draft(task.toUpperCase())));
    assert.notEqual(one.clientMessageId, contributionIdentity({ operation: 'work.update', commandId: commandB }, draft(task)).clientMessageId);
    assert.notEqual(one.clientMessageId, contributionIdentity({ operation: 'work.update', commandId: commandA }, draft(randomUUID())).clientMessageId);
    assert.match(one.clientMessageId, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.equal(derivedUuid('a', 'b'), derivedUuid('a', 'b'));
    assert.notEqual(derivedUuid('a', 'b'), derivedUuid('a', 'c'));
  });

  test('an exact retry of Done with its line appends no second message; a changed line under the same command conflicts', async () => {
    const w = world();
    const task = w.taskIds[0]!;
    const command = { status: 'done' as const, cameOfIt: 'Same line', clientCommandId: randomUUID() };
    const first = await w.use.updateWork(writer, task, command, 1);
    const again = await w.use.updateWork(writer, task, command, 1);
    assert.deepEqual(again, first);
    assert.deepEqual([w.messages.length, w.receipts.size], [1, 1]);
    await assert.rejects(w.use.updateWork(writer, task, { ...command, cameOfIt: 'Another line' }, 1),
      (error) => error instanceof ConflictError && error.code === 'IDEMPOTENCY_CONFLICT');
    assert.equal(w.messages.length, 1);
  });
});

describe('the contribution hook is mandatory', () => {
  test('a work adapter cannot be composed without it, and a missing hook never silently skips an effect', async () => {
    const w = world();
    const without = { access: w.ports.access, work: w.ports.work, events: w.ports.events };
    // @ts-expect-error WorkPorts.contributions is required: an adapter without the hook does not typecheck.
    const broken = createWorkUseCases({ run: (action) => action(without) });
    await assert.rejects(broken.updateWork(writer, w.taskIds[0]!, { status: 'blocked', blocker: 'Would be skipped' }, 1), TypeError);
    assert.deepEqual([w.messages.length, w.tasks.get(w.taskIds[0]!)!.version], [0, 1]);
  });

  test('the handle enforces prepare, then lockTasks, then append, once each, and rejects a foreign handle', async () => {
    const w = world();
    const task = w.taskIds[0]!;
    const draft = { workId: task, kind: 'blocker' as const, body: 'Waiting' };
    const anchor = { operation: 'work.update' as const, commandId: randomUUID() };
    const first = await w.ports.contributions.prepare(writer, projectId, anchor, [draft]);
    await assert.rejects(w.ports.contributions.append(first), /prepared, locked and appended in order/);
    await w.ports.contributions.lockTasks(first);
    await assert.rejects(w.ports.contributions.lockTasks(first), /in order/);
    await w.ports.contributions.append(first);
    await assert.rejects(w.ports.contributions.append(first), /in order/);
    await assert.rejects(w.ports.contributions.lockTasks({ workIds: [task] }), /Unknown contribution handle/);
    assert.equal(w.messages.length, 1);
  });

  test('a replayed message identity appends nothing; a reused identity for another intent conflicts', async () => {
    const w = world();
    const task = w.taskIds[0]!;
    const anchor = { operation: 'work.update' as const, commandId: randomUUID() };
    const run = async (body: string) => {
      const handle = await w.ports.contributions.prepare(writer, projectId, anchor, [{ workId: task, kind: 'blocker', body }]);
      await w.ports.contributions.lockTasks(handle);
      return w.ports.contributions.append(handle);
    };
    const [id] = await run('Waiting');
    assert.deepEqual(await run('Waiting'), [id]);
    assert.equal(w.messages.length, 1);
    assert.equal(w.events.length, 1, 'the replay queued no event');
    await assert.rejects(run('Changed'), (error) => error instanceof ConflictError && error.code === 'IDEMPOTENCY_CONFLICT');
  });
});

describe('an explicit public handoff uses the common contribution primitive', () => {
  test('a handoff becomes the first canonical root with its real author and kind; retries are exact', async () => {
    const w = world();
    const task = w.taskIds[0]!;
    const command = { body: 'Take over the bench test; the rig is ready.', clientMessageId: randomUUID(), kind: 'handoff' as const };
    const sent = await w.discussion.contribute(writer, task, command);
    assert.deepEqual([sent.contribution, sent.authorId, sent.sequence], [{ kind: 'handoff' }, 'writer-1', 1]);
    assert.equal(w.bindings.get(task)!.rootMessageId, sent.id);
    assert.deepEqual(await w.discussion.contribute(writer, task, command), sent);
    assert.equal(w.messages.length, 1);
    await assert.rejects(w.discussion.contribute(writer, task, { ...command, kind: 'text' }),
      (error) => error instanceof ConflictError && error.code === 'IDEMPOTENCY_CONFLICT', 'the kind is part of the intent');
  });

  test('plain text keeps its exact wire shape and original fingerprint; only handoff may be requested directly', async () => {
    const w = world();
    const task = w.taskIds[0]!;
    const plain = { body: 'Plain', clientMessageId: randomUUID() };
    const text = await w.discussion.contribute(writer, task, plain);
    assert.equal(Object.hasOwn(text, 'contribution'), false, 'ordinary text carries no marker');
    const legacy = createHash('sha256').update(JSON.stringify({ operation: 'task.contribute', workId: task, message: normalizeMessage(plain).fingerprint })).digest('hex');
    assert.equal(w.messages[0]!.requestFingerprint, legacy, 'a plain text contribution keeps the fingerprint every stored receipt was made with');
    assert.equal(w.messages[0]!.kind, 'text');
    for (const kind of ['blocker', 'came_of_it', 'other'] as const) {
      await assert.rejects(w.discussion.contribute(writer, task, { body: 'No', clientMessageId: randomUUID(), kind } as never), InvalidInputError);
    }
    assert.equal(w.messages.length, 1);
  });

  test('a genuine agent handoff keeps the tagged agent author', async () => {
    const w = world();
    const sent = await w.discussion.contribute(agent, w.taskIds[0]!, { body: 'Over to the reviewer.', clientMessageId: randomUUID(), kind: 'handoff' });
    assert.equal(sent.authorId, null);
    assert.deepEqual([sent.author?.kind, sent.author?.id, sent.contribution], ['agent', agent.id, { kind: 'handoff' }]);
  });
});

describe('every contribution kind reads back with its marker', () => {
  test('blocker, what came of it and handoff carry only their kind; plain text carries none', async () => {
    const w = world();
    const task = w.taskIds[0]!;
    const blocked = await w.use.updateWork(writer, task, { status: 'blocked', blocker: 'Waiting' }, 1);
    await w.use.updateWork(writer, task, { status: 'done', cameOfIt: 'Found it' }, blocked.version);
    await w.discussion.contribute(writer, task, { body: 'Hand off', clientMessageId: randomUUID(), kind: 'handoff' });
    await w.discussion.contribute(writer, task, { body: 'Plain reply', clientMessageId: randomUUID() });
    const read = await w.discussion.getDiscussion(writer, task);
    assert.deepEqual(read.messages.map((row) => row.contribution ?? null),
      [{ kind: 'blocker' }, { kind: 'came_of_it' }, { kind: 'handoff' }, null]);
    assert.deepEqual(read.root?.contribution, { kind: 'blocker' });
    assert.deepEqual(read.messages.map((row) => row.sequence), [1, 2, 3, 4]);
  });
});
