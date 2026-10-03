import { z } from 'zod';
import { AGENT_OPERATION_CLASSES, type AgentJsonValue, type AgentOperation, type SendMessageCommand } from '@flux/contracts';
import { derivedUuid, type Database } from '@flux/core';
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
}
