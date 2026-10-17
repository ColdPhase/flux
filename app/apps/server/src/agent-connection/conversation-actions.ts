import { z } from 'zod';
import { AGENT_OPERATION_CLASSES, type AgentJsonValue, type AgentOperation, type SendMessageCommand } from '@flux/contracts';
import { derivedUuid, DomainError, normalizeMessage, type Database } from '@flux/core';
import { guardedAgentThreadInEventSession } from '../conversation/store.js';
import { actionAnnotations as annotations, actionId as id, actionInput, actionVersion as version, nativeActionExecutor } from './action-execution.js';
import type { FluxMcpClaims } from './context.js';
import type { AgentToolRegistry } from './tool-registry.js';
import { toolError, toolResult } from './tool-results.js';

const execution = actionInput(['execute', 'plan']);
const message = z.strictObject({
  body: z.string().min(1).max(100_000).describe('Plain message text, visible to everyone with current access to this project.'),
  cite: z.strictObject({ materialId: id, version }).optional()
    .describe('One material or doc version of this project the message refers to; it keeps citing exactly that version.'),
});
type AgentMessage = z.infer<typeof message>;

/**
 * The canonical message command, as the agent: its client message ID is derived from this connection and the
 * standing-grant command ID, so a retry computes the same send and another connection of the same agent never
 * collides with it. Ordinary text only; blocker, result and handoff contributions come from their own commands.
 */
function send(connectionId: string, clientCommandId: string, { body, cite }: AgentMessage): SendMessageCommand {
  return { body, clientMessageId: derivedUuid('flux.agent-conversation-message.v1', connectionId.toLowerCase(), clientCommandId.toLowerCase()),
    ...(cite ? { source: cite } : {}) };
}

/**
 * Standing-grant contributions to the project's conversations through the canonical start and reply commands
 * (#36/#154), in the same one-transaction executor as the work and map actions. The audience is always the
 * project: a direct message, a private note or another project's conversation is never a target.
 */
export function registerAgentConversationActions(tools: AgentToolRegistry, db: Database, claims: FluxMcpClaims) {
  const execute = nativeActionExecutor(db, claims);
  const register = (operation: AgentOperation) => tools.forScope('flux.action.execute', { operation, classes: AGENT_OPERATION_CLASSES[operation] });
  const run = (handler: () => Promise<unknown>) => handler().then(toolResult, toolError);
  const grantNote = 'Needs a live standing grant for this operation and the runtime from flux_bootstrap. The message is attributed '
    + 'to this connection\'s agent, acting for its owner.';

  register('conversation.create').registerTool('flux_start_conversation', {
    title: 'Start a project conversation under a standing grant',
    description: `Start one new conversation in the project with its first message. ${grantNote}`,
    inputSchema: z.strictObject({ ...execution, message }), annotations,
  }, ({ message: posted, ...input }) => run(() => execute(input, 'conversation.create', null, posted as unknown as AgentJsonValue,
    async ({ conversations, agent, runtime }) => {
      const started = await conversations.createConversation(agent, input.projectId, send(runtime.connectionId, input.clientCommandId, posted));
      const first = started.messages[0]!;
      return { value: { conversationId: started.id, messageId: first.id, sequence: first.sequence },
        postconditions: [{ kind: 'message', id: first.id }] };
    })));

  register('conversation.reply').registerTool('flux_reply_in_conversation', {
    title: 'Reply in a project conversation under a standing grant',
    description: 'Add one reply to an existing conversation of the project, including a task\'s discussion thread. '
      + `${grantNote} A grant can name this conversation or the whole project.`,
    inputSchema: z.strictObject({ ...execution,
      conversationId: id.describe('A conversation of this project, from flux_list_conversations or a task.'), message }), annotations,
  }, ({ conversationId, message: posted, ...input }) => run(() => execute(input, 'conversation.reply', conversationId,
    posted as unknown as AgentJsonValue, async ({ conversations, agent, runtime }) => {
      const sent = await conversations.sendMessage(agent, conversationId, send(runtime.connectionId, input.clientCommandId, posted));
      return { value: { conversationId: sent.conversationId, messageId: sent.id, sequence: sent.sequence },
        postconditions: [{ kind: 'message', id: sent.id }] };
    })));

  // The task's agents' thread (#400): the grant and the strict command are the reply operation's; the server selects
  // the private task mode, so a client cannot choose it. The five-turn guard debits inside the same transaction.
  const executeThread = nativeActionExecutor(db, claims, 'task-agent-thread/v1');
  register('conversation.reply').registerTool('flux_post_agent_thread', {
    title: 'Write to a task\'s agents\' thread under a standing grant',
    description: 'Write one work message (a plan, progress, a hand-off note) in the agents\' thread of a task, visible to everyone who can read '
      + 'the task and quiet for people unless they open it. At most five agent messages in a row without a person\'s message or a new '
      + `artifact version or request change (AGENT_THREAD_TURN_LIMIT). ${grantNote} A grant can name the whole project.`,
    inputSchema: z.strictObject({ ...execution, taskId: id.describe('The task of this project the message is about.'),
      body: message.shape.body, replyToMessageId: id.optional().describe('Accepted for compatibility; the thread is flat.') }), annotations,
  }, ({ taskId, body, replyToMessageId: _reply, ...input }) => run(async () => {
    void _reply;
    try {
      return await executeThread(input, 'conversation.reply', taskId, { body, taskId } as unknown as AgentJsonValue,
        async ({ transaction, events, runtime }) => {
          const normalized = normalizeMessage({ body,
            clientMessageId: derivedUuid('flux.agent-thread-message.v1', runtime.connectionId.toLowerCase(), input.clientCommandId.toLowerCase()) });
          const sent = await guardedAgentThreadInEventSession(transaction, events, runtime,
            { clientCommandId: input.clientCommandId, grantId: input.grantId }, taskId, { ...normalized, projectId: input.projectId });
          return { value: { taskId, conversationId: sent.conversationId, messageId: sent.id, sequence: sent.sequence },
            postconditions: [{ kind: 'message', id: sent.id }] };
        });
    } catch (error) {
      for (let cause: unknown = error; cause && typeof cause === 'object'; cause = 'cause' in cause ? cause.cause : null) {
        if ('constraint' in cause && cause.constraint === 'agent_thread_turn_limit')
          throw new DomainError(409, 'AGENT_THREAD_TURN_LIMIT', 'Five agent messages in a row need a person\'s message, a new artifact version or a request change first');
      }
      throw error;
    }
  }));
}
