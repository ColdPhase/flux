import { createHash, randomUUID } from 'node:crypto';
import type { AgentProjectOwner, ConversationMessage, ConversationWindowQuery, TaskContributionCommand, TaskDiscussion } from '@flux/contracts';
import { ConflictError, InvalidInputError, NotFoundError, RuleViolationError } from '../access/errors.js';
import { normalizeConversationWindow, normalizeMessage } from '../conversation/commands.js';
import type { Principal } from '../principal.js';
import type { ActorRef, ContributionDraft, PreparedContributions, WorkContributions, WorkRecord } from '../work/ports.js';
import { id } from '../work/validation.js';
import { contributionIdentity, messageContribution } from './identity.js';
import type { DiscussionBinding, DiscussionMessage, NewDiscussionMessage, TaskDiscussionPorts, TaskDiscussionRoot, TaskDiscussionUnitOfWork } from './ports.js';

const missing = () => new NotFoundError('Work item', 'WORK_NOT_FOUND');
const wire = (row: DiscussionMessage, names: Map<string, string>, owners: ReadonlyMap<string, AgentProjectOwner> = new Map()): ConversationMessage => {
  const contribution = messageContribution(row.kind, row.resultId);
  return { id: row.id, conversationId: row.conversationId,
    ...(row.author.kind === 'human' ? { authorId: row.author.id } : { authorId: null,
      author: { kind: 'agent' as const, id: row.author.id, name: names.get(`agent:${row.author.id}`) ?? 'Agent',
        ...(owners.has(row.author.id) ? { projectOwner: owners.get(row.author.id)! } : {}) } }),
    body: row.body, source: row.source, sequence: row.sequence, createdAt: row.createdAt.toISOString(),
    ...(contribution ? { contribution } : {}), ...(row.files?.length ? { files: row.files } : {}) };
};

/**
 * Finds the task's project and asks the policy. A task in a project the caller cannot see is
 * reported exactly like an unknown task (same status and code), so its existence never leaks.
 * Reads that only look up the root pass `lock: false`; commands and the window read keep the lock.
 */
async function authorize(ports: TaskDiscussionPorts, principal: Principal, workId: string, action: 'read' | 'write', lock = true) {
  const located = await ports.work.locate('work', workId);
  if (!located) throw missing();
  try {
    const project = await ports.access.requireProject(principal, action, located.projectId, { lock });
    return { ...project, projectId: located.projectId };
  } catch (error) {
    if (error instanceof NotFoundError) throw missing();
    throw error;
  }
}

/** The real actor of a command: a signed-in person or an agent, never a fixture or a client-supplied author. */
function actorOf(principal: Principal): ActorRef {
  if (principal.kind !== 'human' && principal.kind !== 'agent') throw new InvalidInputError('A signed-in person or agent is required');
  return { kind: principal.kind, id: principal.kind === 'agent' ? id(principal.id, 'agentId') : principal.id };
}

/** Exactly the contract keys. The stored binding row also carries `rootSequence`, so it is never spread. */
const identity = (project: { workspaceId: string; projectId: string }, binding: DiscussionBinding): TaskDiscussionRoot => ({
  workId: binding.workId, workspaceId: project.workspaceId, projectId: project.projectId,
  conversationId: binding.conversationId, rootMessageId: binding.rootMessageId });

/** The task's binding and its exact sequence-1 root, or null while no genuine contribution exists. */
async function boundRoot(ports: TaskDiscussionPorts, project: { projectId: string }, workId: string) {
  const binding = await ports.discussion.findBinding(workId);
  if (!binding) return null;
  const root = await ports.discussion.findMessage(binding.rootMessageId);
  if (!root || root.projectId !== project.projectId || root.conversationId !== binding.conversationId || root.sequence !== 1)
    throw new Error('Task discussion root invariant failed');
  return { binding, root };
}

/**
 * The one canonical append, shared by direct contributions and by every explicit native effect. The caller
 * holds current project write access, the message command identity and the task row lock, in that order.
 * An exact retry finds its earlier message and appends nothing and queues no event; a reused identity for
 * another intent conflicts.
 */
async function appendToTask(ports: TaskDiscussionPorts, project: { workspaceId: string; projectId: string },
  author: ActorRef, workId: string, input: NewDiscussionMessage): Promise<{ message: DiscussionMessage; replayed: boolean }> {
  const binding = await ports.discussion.findBinding(workId);
  const existing = await ports.discussion.existingMessage(project.projectId, author, input.clientMessageId);
  if (existing) {
    if (existing.requestFingerprint !== input.fingerprint || existing.conversationId !== binding?.conversationId)
      throw new ConflictError('This clientMessageId was used for another contribution', 'IDEMPOTENCY_CONFLICT');
    return { message: existing, replayed: true };
  }
  if (input.source && !await ports.discussion.sourceExists(project.projectId, input.source))
    throw new NotFoundError('Material version', 'MATERIAL_VERSION_NOT_FOUND');
  const conversation = binding ? await ports.discussion.findConversation(binding.conversationId)
    : await ports.discussion.createConversation({ id: randomUUID(), workspaceId: project.workspaceId, projectId: project.projectId, createdBy: author });
  if (!conversation || conversation.projectId !== project.projectId || conversation.workspaceId !== project.workspaceId)
    throw new Error('Task discussion conversation invariant failed');
  const sent = await ports.discussion.append(conversation, author, input);
  if (!binding) await ports.discussion.bind({ workId, workspaceId: project.workspaceId, projectId: project.projectId,
    conversationId: conversation.id, rootMessageId: sent.id });
  await ports.events.record(author, project.workspaceId,
    binding ? 'project.message_sent.v1' : 'project.conversation_created.v1', project.projectId,
    { conversationId: conversation.id, messageId: sent.id, workId, rootMessageId: binding?.rootMessageId ?? sent.id });
  return { message: sent, replayed: false };
}

/** A direct contribution is ordinary text or an explicit public handoff; blocker/result come from their own commands. */
function directKind(value: unknown): 'text' | 'handoff' {
  if (value === undefined || value === 'text') return 'text';
  if (value === 'handoff') return 'handoff';
  throw new InvalidInputError('kind must be text or handoff');
}

/** A genuine text contribution creates the root; opening a task never does. */
export function createTaskDiscussionUseCases(unit: TaskDiscussionUnitOfWork) {
  return {
    async getDiscussion(principal: Principal, workIdInput: string, query?: ConversationWindowQuery): Promise<TaskDiscussion> {
      const workId = id(workIdInput, 'workId');
      const window = normalizeConversationWindow(query);
      return unit.run(async (ports) => {
        const project = await authorize(ports, principal, workId, 'read');
        if (!await ports.work.findWork(workId)) throw missing();
        const bound = await boundRoot(ports, project, workId);
        if (!bound) return { workId, workspaceId: project.workspaceId, projectId: project.projectId,
          conversationId: null, rootMessageId: null, root: null, messages: [],
          messagePage: { hasMoreBefore: false, nextBeforeSequence: null, limit: window.limit } };
        const { binding, root } = bound;
        const rows = await ports.discussion.messages(binding.conversationId, window);
        const hasMoreBefore = rows.length > window.limit;
        const names = await ports.work.names([root.author, ...rows.map((row) => row.author)]);
        const selected = rows.slice(0, window.limit).reverse();
        const owners = await ports.authorOwners?.read(project.projectId, project.workspaceId,
          [root, ...selected].flatMap((row) => row.author.kind === 'agent' ? [row.author.id] : [])) ?? new Map<string, AgentProjectOwner>();
        const messages = selected.map((row) => wire(row, names, owners));
        return { ...identity(project, binding), root: wire(root, names, owners), messages,
          messagePage: { hasMoreBefore, nextBeforeSequence: hasMoreBefore ? messages[0]!.sequence : null, limit: window.limit } };
      });
    },

    /**
     * Read-only seam for alias consumers (#153/#155): the canonical task-to-conversation identity, or null
     * while the task has no genuine contribution yet. Needs current `project.read` without the access-row
     * lock. A task in a project the caller cannot see is `WORK_NOT_FOUND`, like an unknown task. It creates
     * no conversation, message, binding or event, so a caller transaction queues no event intent for it.
     */
    async getDiscussionRoot(principal: Principal, workIdInput: string): Promise<TaskDiscussionRoot | null> {
      const workId = id(workIdInput, 'workId');
      return unit.run(async (ports) => {
        const project = await authorize(ports, principal, workId, 'read', false);
        if (!await ports.work.findWork(workId)) throw missing();
        const bound = await boundRoot(ports, project, workId);
        return bound && identity(project, bound.binding);
      });
    },

    /**
     * Direct public contribution: ordinary text, or an explicit public handoff instruction (#154). Both use the
     * one canonical append. The handoff carries no authority; #153 supplies its own sender/claim fencing and
     * heartbeats, acknowledgments and private logs never call this.
     */
    async contribute(principal: Principal, workIdInput: string, command: TaskContributionCommand): Promise<ConversationMessage> {
      const workId = id(workIdInput, 'workId');
      const kind = directKind(command?.kind);
      const input = normalizeMessage(command);
      // The operation/task identity prevents reuse of a generic conversation's receipt. Plain text keeps
      // its original fingerprint so every stored receipt still replays exactly.
      input.fingerprint = createHash('sha256').update(JSON.stringify(kind === 'text'
        ? { operation: 'task.contribute', workId, message: input.fingerprint }
        : { operation: 'task.contribute', workId, kind, message: input.fingerprint })).digest('hex');
      return unit.run(async (ports) => {
        const project = await authorize(ports, principal, workId, 'write');
        const author = actorOf(principal);
        await ports.discussion.lockCommand(project.projectId, author, input.clientMessageId);
        const existing = await ports.discussion.existingMessage(project.projectId, author, input.clientMessageId);
        let files;
        if (!existing && input.attachmentIds.length) {
          if (!ports.attachments) throw new InvalidInputError('Files are unavailable from this entry point', 'AGENT_FILES_UNAVAILABLE');
          files = await ports.attachments.lock(project.projectId, author, input.attachmentIds);
        }
        if (!await ports.work.findWork(workId, { lock: true })) throw missing();
        const { message } = await appendToTask(ports, project, author, workId, { ...input, kind, files });
        return wire(message, await ports.work.names([message.author]));
      });
    },
  };
}

interface PreparedItem { draft: ContributionDraft; clientMessageId: string; fingerprint: string }

/** The handle's private state. Its stage makes the lock order structural: prepare, then lockTasks, then append. */
class Prepared implements PreparedContributions {
  stage: 'prepared' | 'locked' | 'appended' = 'prepared';
  locked: WorkRecord[] = [];
  constructor(readonly author: ActorRef, readonly projectId: string, readonly items: readonly PreparedItem[]) {}
  get workIds(): readonly string[] { return this.items.map((item) => item.draft.workId); }
}

/**
 * The work use cases' mandatory contribution hook over the SAME ports (and so the same transaction and
 * event collector) as the discussion use cases. Locks and appends exactly as a direct contribution does:
 * message identity, then the complete sorted task set, then the canonical append; it commits and flushes nothing.
 */
export function createWorkContributions(ports: TaskDiscussionPorts): WorkContributions {
  const own = (handle: PreparedContributions, stage: Prepared['stage']): Prepared => {
    if (!(handle instanceof Prepared)) throw new Error('Unknown contribution handle');
    if (handle.stage !== stage) throw new Error(`Contributions must be prepared, locked and appended in order (at ${handle.stage}, needs ${stage})`);
    return handle;
  };
  return {
    async prepare(principal, projectId, anchor, drafts) {
      const author = actorOf(principal);
      const items: PreparedItem[] = drafts.map((draft) => {
        const workId = id(draft.workId, 'workId');
        if (!draft.body.trim() || draft.body.length > 100_000) throw new InvalidInputError('A contribution needs 1–100000 characters');
        if ((draft.kind === 'result') !== (draft.resultId !== undefined)) throw new Error('A result contribution names its canonical result; nothing else does');
        const normalized = { ...draft, workId };
        return { draft: normalized, ...contributionIdentity(anchor, normalized) };
      }).sort((a, b) => (a.draft.workId < b.draft.workId ? -1 : a.draft.workId > b.draft.workId ? 1 : 0));
      if (new Set(items.map((item) => item.draft.workId)).size !== items.length) throw new Error('One contribution per task');
      for (const item of items) await ports.discussion.lockCommand(projectId, author, item.clientMessageId);
      return new Prepared(author, projectId, items);
    },
    async lockTasks(handle) {
      const prepared = own(handle, 'prepared');
      const rows: WorkRecord[] = [];
      for (const workId of prepared.workIds) {
        const row = await ports.work.findWork(workId, { lock: true });
        if (!row || row.projectId !== prepared.projectId) throw new RuleViolationError('The work is not part of this project', 'LINK_TARGET_NOT_FOUND');
        rows.push(row);
      }
      prepared.locked = rows;
      prepared.stage = 'locked';
      return rows;
    },
    async append(handle) {
      const prepared = own(handle, 'locked');
      const ids: string[] = [];
      for (const item of prepared.items) {
        const task = prepared.locked.find((row) => row.id === item.draft.workId)!;
        const { message } = await appendToTask(ports, { workspaceId: task.workspaceId, projectId: prepared.projectId }, prepared.author, task.id,
          { body: item.draft.body, clientMessageId: item.clientMessageId, fingerprint: item.fingerprint, source: null,
            kind: item.draft.kind, resultId: item.draft.resultId ?? null });
        ids.push(message.id);
      }
      prepared.stage = 'appended';
      return ids;
    },
    async confirm(principal, projectId, messageIds) {
      const author = actorOf(principal);
      for (const messageId of messageIds) {
        const stored = await ports.discussion.findMessage(messageId);
        if (!stored || stored.projectId !== projectId || stored.author.kind !== author.kind || stored.author.id !== author.id) return false;
      }
      return true;
    },
  };
}
