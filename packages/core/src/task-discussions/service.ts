import { createHash, randomUUID } from 'node:crypto';
import type { ConversationMessage, ConversationWindowQuery, SendMessageCommand, TaskDiscussion } from '@flux/contracts';
import { ConflictError, InvalidInputError, NotFoundError } from '../access/errors.js';
import { normalizeConversationWindow, normalizeMessage } from '../conversation/commands.js';
import type { Principal } from '../principal.js';
import { id } from '../work/validation.js';
import type { DiscussionMessage, TaskDiscussionPorts, TaskDiscussionUnitOfWork } from './ports.js';

const missing = () => new NotFoundError('Work item', 'WORK_NOT_FOUND');
const wire = (row: DiscussionMessage): ConversationMessage => ({ id: row.id, conversationId: row.conversationId,
  authorId: row.authorId, body: row.body, source: row.source, sequence: row.sequence, createdAt: row.createdAt.toISOString() });

async function authorize(ports: TaskDiscussionPorts, principal: Principal, workId: string, action: 'read' | 'write') {
  const located = await ports.work.locate('work', workId);
  if (!located) throw missing();
  const project = await ports.access.requireProject(principal, action, located.projectId, { lock: true });
  return { ...project, projectId: located.projectId };
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
        const binding = await ports.discussion.findBinding(workId);
        if (!binding) return { workId, ...project, conversationId: null, rootMessageId: null, root: null, messages: [],
          messagePage: { hasMoreBefore: false, nextBeforeSequence: null, limit: window.limit } };
        const root = await ports.discussion.findMessage(binding.rootMessageId);
        if (!root || root.projectId !== project.projectId || root.conversationId !== binding.conversationId || root.sequence !== 1)
          throw new Error('Task discussion root invariant failed');
        const rows = await ports.discussion.messages(binding.conversationId, window);
        const hasMoreBefore = rows.length > window.limit;
        const messages = rows.slice(0, window.limit).reverse().map(wire);
        return { ...project, ...binding, root: wire(root), messages,
          messagePage: { hasMoreBefore, nextBeforeSequence: hasMoreBefore ? messages[0]!.sequence : null, limit: window.limit } };
      });
    },

    async contribute(principal: Principal, workIdInput: string, command: SendMessageCommand): Promise<ConversationMessage> {
      const workId = id(workIdInput, 'workId');
      const input = normalizeMessage(command);
      // The operation/task identity prevents reuse of a generic conversation's receipt.
      input.fingerprint = createHash('sha256').update(JSON.stringify({ operation: 'task.contribute', workId, message: input.fingerprint })).digest('hex');
      return unit.run(async (ports) => {
        const project = await authorize(ports, principal, workId, 'write');
        // Agent identities/files are additive follow-up slices, never fabricated human authors.
        if (principal.kind !== 'human') throw new InvalidInputError('A signed-in person is required for this text contribution');
        await ports.discussion.lockCommand(project.projectId, principal.id, input.clientMessageId);
        if (!await ports.work.findWork(workId, { lock: true })) throw missing();
        const binding = await ports.discussion.findBinding(workId);
        const existing = await ports.discussion.existingMessage(project.projectId, principal.id, input.clientMessageId);
        if (existing) {
          if (existing.requestFingerprint !== input.fingerprint || existing.conversationId !== binding?.conversationId)
            throw new ConflictError('This clientMessageId was used for another contribution', 'IDEMPOTENCY_CONFLICT');
          return wire(existing);
        }
        if (input.source && !await ports.discussion.sourceExists(project.projectId, input.source))
          throw new NotFoundError('Material version', 'MATERIAL_VERSION_NOT_FOUND');
        const conversation = binding ? await ports.discussion.findConversation(binding.conversationId)
          : await ports.discussion.createConversation({ id: randomUUID(), ...project, createdBy: principal.id });
        if (!conversation || conversation.projectId !== project.projectId || conversation.workspaceId !== project.workspaceId)
          throw new Error('Task discussion conversation invariant failed');
        const sent = await ports.discussion.append(conversation, principal.id, input);
        if (!binding) await ports.discussion.bind({ workId, ...project, conversationId: conversation.id, rootMessageId: sent.id });
        await ports.events.record(principal, project.workspaceId,
          binding ? 'project.message_sent.v1' : 'project.conversation_created.v1', project.projectId,
          { conversationId: conversation.id, messageId: sent.id, workId, rootMessageId: binding?.rootMessageId ?? sent.id });
        return wire(sent);
      });
    },
  };
}
