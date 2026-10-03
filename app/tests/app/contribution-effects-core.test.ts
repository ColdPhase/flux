import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { describe, test } from 'node:test';
import {
  ConflictError, contributionIdentity, createTaskDiscussionUseCases, createWorkContributions, createWorkUseCases, derivedUuid,
  ForbiddenError, InvalidInputError, normalizeMessage, VersionConflictError,
  type ActorRef, type DiscussionMessage, type NativeCommandReceipt, type NewDiscussionMessage, type Principal,
  type ResultRecord, type TaskDiscussionPorts, type WorkAccess, type WorkPorts, type WorkRecord, type WorkRepository,
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
  for (const id of taskIds) tasks.set(id, { id, workspaceId, projectId, title: `Task ${id.slice(0, 4)}`, outcome: '', criteria: [], status: 'open', blocker: null,
    owner: null, parked: null, createdBy: { kind: 'human', id: 'creator' }, version: 1, createdAt: at, updatedAt: at });
  const messages: DiscussionMessage[] = [];
  const conversations = new Map<string, { id: string; workspaceId: string; projectId: string; createdBy: ActorRef; createdAt: Date }>();
  const bindings = new Map<string, { workId: string; workspaceId: string; projectId: string; conversationId: string; rootMessageId: string }>();
  const results = new Map<string, ResultRecord>();
  const receipts = new Map<string, NativeCommandReceipt>();
  const events: Array<{ kind: string; data: Record<string, unknown> }> = [];
  const key = (by: ActorRef, operation: string, commandId: string) => `${by.kind}:${by.id}:${operation}:${commandId}`;
  const copy = (row: WorkRecord) => structuredClone(row);

  const access: WorkAccess = {
    async requireProject(_principal, action, _project, opts) {
      if (opts?.lock) log.push('access.lock');
      if (action === 'write' && options.writable === false) throw new ForbiddenError('Not allowed to perform this action on the project');
      return { workspaceId };
    },
    async requireWorkspace() { /* not used */ },
    async canRead() { return true; },
  };
  const work = {
    async locate(_type: string, id: string) { return tasks.has(id) ? { projectId } : results.has(id) ? { projectId } : null; },
    async findWork(id: string, opts?: { lock?: boolean }) {
      if (opts?.lock) log.push(`task.lock:${id}`);
      const row = tasks.get(id);
      return row ? copy(row) : null;
    },
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
    async findResult(id: string) { return results.get(id) ?? null; },
    async insertResult(result: Omit<ResultRecord, 'createdAt'>) {
      log.push('result.insert');
      const row = { ...result, createdAt: at };
      results.set(row.id, row);
      return row;
    },
    async insertLinks() { log.push('links.insert'); },
    async links() { return []; },
    async titles() { return new Map(); },
    async names() { return new Map(); },
    async targetExists(_project: string, ref: { type: string; id: string }) { return ref.type !== 'work' || tasks.has(ref.id); },
    // The #152 task graph: the project graph lock and the complete sorted task pass.
    async taskPlans() { return new Map(); },
    async lockTaskGraphs() { log.push('graph.lock'); },
    async directPrerequisiteIds(_workspace: string, ids: readonly string[]) {
      return [...new Set(ids.flatMap((id) => options.prerequisites?.[id] ?? []))].sort();
    },
    async lockTasks(_workspace: string, ids: readonly string[]) {
      log.push(`task.pass:${ids.join(',')}`);
      return ids.filter((id) => tasks.has(id)).map((id) => ({ id, projectId }));
    },
    async prerequisiteStates(_workspace: string, id: string) {
      return { projectId, prerequisites: (options.prerequisites?.[id] ?? []).map((prerequisite) => ({ id: prerequisite, status: tasks.get(prerequisite)!.status, parked: false })) };
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
        kind: input.kind ?? 'text', resultId: input.resultId ?? null, createdAt: at };
      messages.push(row);
      return row;
    },
    async bind(input) { log.push(`bind:${input.workId}`); bindings.set(input.workId, input); },
  };
  const eventLog = { async record(_principal: Principal, _workspace: string, kind: string, _project: string, data: Record<string, unknown>) {
    log.push(`event:${kind}`); events.push({ kind, data });
  } };
  const discussionPorts: TaskDiscussionPorts = { access, work, discussion, events: eventLog as TaskDiscussionPorts['events'] };
  const ports: WorkPorts = { access, work, events: eventLog as WorkPorts['events'], contributions: createWorkContributions(discussionPorts),
    backgroundComparison: { enqueueHumanNegative: async () => 0 } };
  return {
    log, tasks, taskIds, messages, results, receipts, events, bindings, conversations, ports,
    use: createWorkUseCases({ run: (action) => action(ports) }),
    discussion: createTaskDiscussionUseCases({ run: (action) => action(discussionPorts) }),
  };
}

const index = (log: string[], prefix: string) => log.findIndex((line) => line.startsWith(prefix));
const sorted = (ids: string[]) => [...ids].sort();

describe('an explicitly saved nonempty blocker contributes its exact text', () => {
  test('the saved text, trimmed as saved, becomes one authored blocker contribution with the task change', async () => {
    const w = world();
    const [task] = w.taskIds as [string];
    const view = await w.use.updateWork(writer, task, { status: 'blocked', blocker: '  Waiting for the hinge  ' }, 1);
    assert.equal(view.blocker, 'Waiting for the hinge');
    assert.equal(w.messages.length, 1);
    const [message] = w.messages;
    assert.deepEqual([message!.body, message!.kind, message!.resultId, message!.author, message!.sequence],
      ['Waiting for the hinge', 'blocker', null, { kind: 'human', id: 'writer-1' }, 1]);
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

describe('a published result contributes to every linked task', () => {
  test('one canonical result, one deterministic contribution per task naming that result, in sorted task order', async () => {
    const w = world();
    const [a, b, c] = sorted(w.taskIds) as [string, string, string];
    const result = await w.use.createResult(writer, projectId, { title: 'The hinge holds at 40 N', finding: 'positive', evidence: 'Bench log', work: [c, a, b] });
    assert.equal(w.results.size, 1);
    assert.deepEqual(w.messages.map((row) => [row.kind, row.resultId, row.body, row.author]),
      [c, a, b].map(() => ['result', result.id, 'The hinge holds at 40 N', { kind: 'human', id: 'writer-1' }]));
    const appends = w.log.filter((line) => line.startsWith('binding:')).map((line) => line.slice('binding:'.length));
    assert.deepEqual(appends, [a, b, c], 'tasks are appended in sorted order');
    const identities = w.log.filter((line) => line.startsWith('identity.lock:'));
    const locks = w.log.filter((line) => line.startsWith('task.lock:')).map((line) => line.slice('task.lock:'.length));
    assert.equal(identities.length, 3);
    assert.deepEqual(locks, [a, b, c], 'the complete sorted task set is locked');
    const lastIdentity = w.log.lastIndexOf(identities[2]!);
    assert.ok(lastIdentity < index(w.log, 'task.lock:'), 'every command identity precedes the first task lock');
    assert.ok(index(w.log, 'task.lock:') < index(w.log, 'result.insert'));
    assert.ok(w.log.lastIndexOf(`task.lock:${c}`) < index(w.log, 'append:'), 'the full task set is locked before the first append');
    assert.ok(index(w.log, 'result.insert') < index(w.log, 'append:'), 'the canonical result exists before a message names it');
    for (const id of [a, b, c]) assert.ok(w.bindings.has(id), 'each task now has its explicit root');
  });

  test('message identities derive from the result and the exact task, so a different result or task never collides', () => {
    const task = randomUUID();
    const resultA = randomUUID();
    const resultB = randomUUID();
    const draft = (workId: string, resultId: string) => ({ workId, kind: 'result' as const, body: 'Title', resultId });
    const one = contributionIdentity({ operation: 'result.create', resultId: resultA }, draft(task, resultA));
    assert.deepEqual(one, contributionIdentity({ operation: 'result.create', resultId: resultA.toUpperCase() }, draft(task.toUpperCase(), resultA.toUpperCase())));
    assert.notEqual(one.clientMessageId, contributionIdentity({ operation: 'result.create', resultId: resultB }, draft(task, resultB)).clientMessageId);
    assert.notEqual(one.clientMessageId, contributionIdentity({ operation: 'result.create', resultId: resultA }, draft(randomUUID(), resultA)).clientMessageId);
    assert.match(one.clientMessageId, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.equal(derivedUuid('a', 'b'), derivedUuid('a', 'b'));
    assert.notEqual(derivedUuid('a', 'b'), derivedUuid('a', 'c'));
  });

  test('finishing a linked task is locked in the same sorted set and still version-fenced', async () => {
    const w = world();
    const [a, b] = sorted(w.taskIds) as [string, string, string];
    await assert.rejects(w.use.createResult(writer, projectId, { title: 'Stale finish', finding: 'positive', work: [b, a], finishes: { id: b, expectedVersion: 7 } }), VersionConflictError);
    assert.deepEqual([w.results.size, w.messages.length], [0, 0]);
    await w.use.createResult(writer, projectId, { title: 'Done', finding: 'positive', work: [b, a], finishes: { id: b, expectedVersion: 1 } });
    assert.equal(w.tasks.get(b)!.status, 'done');
    assert.equal(w.messages.length, 2);
  });

  test('finishing locks the graph after every identity, then ONE ascending pass over linked tasks and prerequisites, then the handle', async () => {
    const ids = sorted([randomUUID(), randomUUID(), randomUUID()]) as [string, string, string];
    const [linked, finishing, prerequisite] = ids;
    const w = world({ taskIds: ids, prerequisites: { [finishing]: [prerequisite] } });
    w.tasks.get(prerequisite)!.status = 'done';
    await w.use.createResult(writer, projectId, { title: 'Finished with a prerequisite', finding: 'positive', work: [finishing, linked],
      finishes: { id: finishing, expectedVersion: 1 } });
    const graph = index(w.log, 'graph.lock');
    const pass = w.log.filter((line) => line.startsWith('task.pass:'));
    assert.deepEqual(pass, [`task.pass:${ids.join(',')}`], 'one ascending pass over the union, never two passes');
    assert.ok(w.log.lastIndexOf(w.log.filter((line) => line.startsWith('identity.lock:')).at(-1)!) < graph, 'every message identity precedes the graph lock');
    assert.ok(graph < index(w.log, 'task.pass:'), 'the graph lock precedes the task pass');
    assert.ok(index(w.log, 'task.pass:') < index(w.log, 'task.lock:'), 'the pass precedes the handle that completes the contribution stage');
    assert.ok(index(w.log, 'task.pass:') < index(w.log, 'append:'));
    assert.equal(w.tasks.get(finishing)!.status, 'done');
    assert.deepEqual(w.messages.map((row) => row.kind), ['result', 'result']);
  });

  test('a result with no linked task creates no task thread, identity lock or task lock', async () => {
    const w = world();
    await w.use.createResult(writer, projectId, { title: 'A project-level finding', finding: 'negative', decisions: [] });
    assert.equal(w.results.size, 1);
    assert.deepEqual([w.messages.length, w.bindings.size, w.conversations.size], [0, 0, 0]);
    assert.deepEqual(w.log.filter((line) => /^(identity|task)\.lock/.test(line)), []);
    assert.deepEqual(w.events.map((event) => event.kind), ['project.result_recorded.v1']);
  });

  test('an agent publishing a result is the genuine author of every contribution', async () => {
    const w = world();
    await w.use.createResult(agent, projectId, { title: 'Agent measured it', finding: 'positive', work: [w.taskIds[0]!] });
    assert.deepEqual(w.messages.map((row) => row.author), [{ kind: 'agent', id: agent.id }]);
  });

  test('an exact retry returns the original result without another result or message; a changed intent conflicts', async () => {
    const w = world();
    const command = { title: 'Same finding', finding: 'positive' as const, evidence: 'log', work: [w.taskIds[1]!, w.taskIds[0]!], clientCommandId: randomUUID() };
    const first = await w.use.createResult(writer, projectId, command);
    const events = w.events.length;
    const again = await w.use.createResult(writer, projectId, { ...command, work: [w.taskIds[0]!, w.taskIds[1]!] });
    assert.deepEqual(again, first, 'the order of the linked tasks is not part of the intent');
    assert.deepEqual([w.results.size, w.messages.length, w.events.length, w.receipts.size], [1, 2, events, 1]);
    await assert.rejects(w.use.createResult(writer, projectId, { ...command, title: 'A different finding' }),
      (error) => error instanceof ConflictError && error.code === 'IDEMPOTENCY_CONFLICT');
    await assert.rejects(w.use.createResult(writer, projectId, { ...command, work: [w.taskIds[0]!] }),
      (error) => error instanceof ConflictError && error.code === 'IDEMPOTENCY_CONFLICT');
    assert.deepEqual([w.results.size, w.messages.length], [1, 2]);
  });

  test('without a command UUID two identical publications are two results; nothing deduplicates them', async () => {
    const w = world();
    const command = { title: 'Twice', finding: 'positive' as const, work: [w.taskIds[0]!] };
    await w.use.createResult(writer, projectId, command);
    await w.use.createResult(writer, projectId, command);
    assert.deepEqual([w.results.size, w.messages.length], [2, 2]);
    assert.equal(new Set(w.messages.map((row) => row.resultId)).size, 2);
  });
});

describe('the contribution hook is mandatory', () => {
  test('a work adapter cannot be composed without it, and a missing hook never silently skips an effect', async () => {
    const w = world();
    const without = { access: w.ports.access, work: w.ports.work, events: w.ports.events };
    // @ts-expect-error WorkPorts.contributions is required: an adapter without the hook does not typecheck.
    const broken = createWorkUseCases({ run: (action) => action(without) });
    await assert.rejects(broken.updateWork(writer, w.taskIds[0]!, { status: 'blocked', blocker: 'Would be skipped' }, 1), TypeError);
    await assert.rejects(broken.createResult(writer, projectId, { title: 'Would be skipped', finding: 'positive', work: [w.taskIds[0]!] }), TypeError);
    assert.deepEqual([w.messages.length, w.results.size, w.tasks.get(w.taskIds[0]!)!.version], [0, 0, 1]);
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
    for (const kind of ['blocker', 'result', 'other'] as const) {
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
  test('a result contribution carries its canonical result id; blocker and handoff carry only their kind', async () => {
    const w = world();
    const task = w.taskIds[0]!;
    await w.use.updateWork(writer, task, { status: 'blocked', blocker: 'Waiting' }, 1);
    const result = await w.use.createResult(writer, projectId, { title: 'Found it', finding: 'positive', work: [task] });
    await w.discussion.contribute(writer, task, { body: 'Hand off', clientMessageId: randomUUID(), kind: 'handoff' });
    await w.discussion.contribute(writer, task, { body: 'Plain reply', clientMessageId: randomUUID() });
    const read = await w.discussion.getDiscussion(writer, task);
    assert.deepEqual(read.messages.map((row) => row.contribution ?? null),
      [{ kind: 'blocker' }, { kind: 'result', resultId: result.id }, { kind: 'handoff' }, null]);
    assert.deepEqual(read.root?.contribution, { kind: 'blocker' });
    assert.deepEqual(read.messages.map((row) => row.sequence), [1, 2, 3, 4]);
  });
});
