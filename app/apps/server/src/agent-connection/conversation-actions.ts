import { z } from 'zod';
import { AGENT_OPERATION_CLASSES, type AgentJsonValue, type AgentOperation, type SendMessageCommand } from '@flux/contracts';
import { derivedUuid, type Principal } from '@flux/core';
import { assistantChangeRows, taskDiscussionRows, type Database, type DbExecutor, type Transaction } from '@flux/db';
import { taskDiscussionInEventSession } from '../work/task-discussions.js';
import { actionAnnotations as annotations, actionId as id, actionInput, actionVersion as version, coordinationExecutor, coordinationInput,
  nativeActionExecutor } from './action-execution.js';
import { recordDiscussionLine } from './assistant-changes.js';
import type { AgentToolRegistry, ToolCall } from './tool-registry.js';
import { toolError, toolResult } from './tool-results.js';

const execution = actionInput();
const message = z.strictObject({
  body: z.string().min(1).max(100_000).describe('Plain message text, visible to everyone with current access to this project.'),
  cite: z.strictObject({ materialId: id, version }).optional()
    .describe('One material or doc version of this project the message refers to; it keeps citing exactly that version.'),
});
type AgentMessage = z.infer<typeof message>;

/**
 * The canonical message command, as the agent: its client message ID is derived from this connection and the
 * command ID, so a retry computes the same send and another connection of the same agent never
 * collides with it. Ordinary text only; blocker, result and handoff contributions come from their own commands.
 */
function send(connectionId: string, clientCommandId: string, { body, cite }: AgentMessage): SendMessageCommand {
  return { body, clientMessageId: derivedUuid('flux.agent-conversation-message.v1', connectionId.toLowerCase(), clientCommandId.toLowerCase()),
    ...(cite ? { source: cite } : {}) };
}

/**
 * The mark a local client's post carries: the client it came through, as its owner sees it ("Claude Code", "Codex", or the name of
 * another client), the same as the "via" of an answer posted with Show everyone.
 */
async function clientMark(tx: Transaction, connectionId: string): Promise<string> {
  const connection = await assistantChangeRows(tx as DbExecutor).connection(connectionId);
  return (connection?.label ?? 'Agent client').replace(/ on this computer$/i, '').slice(0, 80);
}

/**
 * Contributions to the project's conversations through the canonical start and reply commands
 * (#36/#154), in the same one-transaction executor as the work and map actions. The audience is always the
 * project: a direct message, a private note or another project's conversation is never a target.
 */
export function registerAgentConversationActions(tools: AgentToolRegistry, db: Database) {
  const execute = ({ claims }: ToolCall) => nativeActionExecutor(db, claims);
  const register = (operation: AgentOperation) => tools.forAccess('write', { operation, classes: AGENT_OPERATION_CLASSES[operation] });
  const run = (handler: () => Promise<unknown>) => handler().then(toolResult, toolError);
  const note = 'The message is attributed to this connection\'s agent, acting for its owner.';
  const asOwner = 'The message is posted as your owner, marked "via" this client; it is theirs to edit or delete.';

  register('conversation.create').registerTool('flux_start_conversation', {
    title: 'Start a project conversation',
    description: `Start one new conversation in the project with its first message. ${asOwner}`,
    inputSchema: z.strictObject({ ...execution, message }), annotations,
  }, ({ message: posted, ...input }, call) => run(() => execute(call)(input, 'conversation.create', null, posted as unknown as AgentJsonValue,
    async ({ conversations, transaction, runtime }) => {
      // As the owner, marked with the client (LC-2, #1091): a person's own message, so the database accepts its `via`.
      const owner: Principal = { kind: 'human', id: runtime.ownerUserId };
      const started = await conversations.createConversation(owner, input.projectId, send(runtime.connectionId, input.clientCommandId, posted),
        await clientMark(transaction, runtime.connectionId));
      const first = started.messages[0]!;
      return { value: { conversationId: started.id, messageId: first.id, sequence: first.sequence },
        postconditions: [{ kind: 'message', id: first.id }], asOwner: true };
    })));

  register('conversation.reply').registerTool('flux_reply_in_conversation', {
    title: 'Reply in a project conversation',
    description: 'Add one reply to an existing conversation of the project, including a task\'s discussion thread. '
      + 'In a space\'s conversation the message is posted as your owner, marked "via" this client, and is theirs to edit or delete. '
      + 'In a task\'s discussion the line is this connection\'s agent\'s own, acting for its owner, and at most five agent messages in a row are accepted until a person writes (AGENT_TURN_LIMIT).',
    inputSchema: z.strictObject({ ...execution,
      conversationId: id.describe('A conversation of this project, from flux_list_conversations or a task.'), message }), annotations,
  }, ({ conversationId, message: posted, ...input }, call) => run(() => execute(call)(input, 'conversation.reply', conversationId,
    posted as unknown as AgentJsonValue, async ({ conversations, transaction, agent, runtime }) => {
      // A task's discussion is the agents' own talk about the task (C-51, TA-3): the line stays the agent's, counted and its owner's to delete.
      // Any other conversation is people's: the post is the owner's own message, marked with the client (LC-2, #1091).
      if (await taskDiscussionRows(transaction as DbExecutor).taskOf(conversationId) !== null) {
        const sent = await conversations.sendMessage(agent, conversationId, send(runtime.connectionId, input.clientCommandId, posted));
        return { value: { conversationId: sent.conversationId, messageId: sent.id, sequence: sent.sequence }, postconditions: [{ kind: 'message', id: sent.id }] };
      }
      const owner: Principal = { kind: 'human', id: runtime.ownerUserId };
      const sent = await conversations.sendMessage(owner, conversationId, send(runtime.connectionId, input.clientCommandId, posted),
        await clientMark(transaction, runtime.connectionId));
      return { value: { conversationId: sent.conversationId, messageId: sent.id, sequence: sent.sequence },
        postconditions: [{ kind: 'message', id: sent.id }], asOwner: true };
    })));

  // The task's one discussion (#868): the strict command is the reply operation's; the server selects the task target, so a client cannot
  // choose it. It is the agent's own talk about the task, not a change to a person's things, so it does not wait. The task discussion's
  // use case writes it as the agent, under the task's use fence, and stops the sixth agent message in a row (AGENT_TURN_LIMIT, C-51); the
  // line is recorded as the reply change flux_reply_in_conversation records, so its owner deletes it the same way (#961).
  const executeDiscussion = ({ claims }: ToolCall) => coordinationExecutor(db, claims, 'task-discussion/v1');
  register('conversation.reply').registerTool('flux_discuss_task', {
    title: 'Write in a task\'s discussion',
    description: 'Write one message in the one discussion of a task, where people and agents talk about it (a plan, progress, a hand-off note). '
      + 'Everyone who can read the task reads it. At most five agent messages in a row are accepted until a person writes (AGENT_TURN_LIMIT). '
      + `${note} Needs the runtime from flux_bootstrap.`,
    inputSchema: z.strictObject({ ...coordinationInput(), taskId: id.describe('The task of this project the message is about.'),
      body: message.shape.body }), annotations,
  }, ({ taskId, body, ...input }, call) => run(() => executeDiscussion(call)(input, 'conversation.reply', taskId, { body, taskId } as unknown as AgentJsonValue,
    async ({ transaction, events, agent, runtime }) => {
      const sent = await taskDiscussionInEventSession(transaction, events).contribute(agent, taskId,
        { body, clientMessageId: derivedUuid('flux.task-discussion-message.v1', runtime.connectionId.toLowerCase(), input.clientCommandId.toLowerCase()) });
      const produced = { value: { taskId, conversationId: sent.conversationId, messageId: sent.id, sequence: sent.sequence },
        postconditions: [{ kind: 'message' as const, id: sent.id }] };
      await recordDiscussionLine(transaction, call.claims, runtime, { tool: 'flux_discuss_task', args: { ...input, taskId, body } }, input, produced);
      return produced;
    })));
}
