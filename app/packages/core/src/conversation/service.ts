import type {
  AgentColour, Conversation, DecisionDiscussion, ConversationMessage, ConversationRootQuery, ConversationRootWindow, ConversationSummary, ConversationWindowQuery,
  EditMessageCommand, MaterialOrDoc, MaterialVersion, Page, PageQuery, SendMessageCommand, SentConversationMessage,
} from '@flux/contracts';
import type { Principal } from '../types.js';
import { normalizeConversationWindow, normalizeMessage, normalizeMessageEdit, normalizeRootWindow } from './commands.js';

/** Show everyone (#842): the agent whose answer a person posts as their message, with its colour (#1232), shown as "Ada's Assistant". Only the server sets it, from the answer itself. */
export interface ViaAgent { via?: string | null; viaColour?: AgentColour | null }

/** Storage and current-access boundary. The adapter must authorize before every read and
 * authorize under the write transaction before every mutation or idempotent replay. */
export interface ConversationPort {
  listConversations(principal: Principal, projectId: string, query?: PageQuery): Promise<Page<ConversationSummary>>;
  /** The project's one stream (UI116-1): authorize the project first, then count and page its roots. */
  listRoots(principal: Principal, projectId: string, window: ReturnType<typeof normalizeRootWindow>): Promise<ConversationRootWindow>;
  getConversation(principal: Principal, conversationId: string, window: ReturnType<typeof normalizeConversationWindow>): Promise<Conversation>;
  createConversation(principal: Principal, projectId: string, input: ReturnType<typeof normalizeMessage> & ViaAgent): Promise<Conversation>;
  /** A person's reply also answers what they were asked or mentioned in this conversation (#1170): `answered` names those Inbox items. */
  sendMessage(principal: Principal, conversationId: string, input: ReturnType<typeof normalizeMessage> & ViaAgent): Promise<SentConversationMessage>;
  /** A decision's one discussion (#1424): the thread on its card, read by whoever reads its space; empty before anyone wrote. */
  decisionDiscussion(principal: Principal, decisionId: string, window: ReturnType<typeof normalizeConversationWindow>): Promise<DecisionDiscussion>;
  /** A message about a decision (#1424): the first starts the thread on its card, the others are replies in it. */
  discussDecision(principal: Principal, decisionId: string, input: ReturnType<typeof normalizeMessage> & ViaAgent): Promise<SentConversationMessage>;
  /** The author changes the words of their own message in place (#1006); only the author, with write access, on a plain message. */
  editMessage(principal: Principal, conversationId: string, messageId: string, input: ReturnType<typeof normalizeMessageEdit>): Promise<ConversationMessage>;
  /** The author deletes their own message (#1006): a marker stays in its place; the words, its files and its notices go. */
  removeMessage(principal: Principal, conversationId: string, messageId: string): Promise<ConversationMessage>;
  /** A page by its id (every saved source is a page, #1508); its current version may be agent-written (#152). */
  getMaterial(principal: Principal, materialId: string): Promise<MaterialOrDoc>;
  getMaterialVersion(principal: Principal, materialId: string, version: number): Promise<MaterialVersion>;
}

/** HTTP and future entry points share command rules; the adapter owns persistence and locks. */
export function conversationUseCases(port: ConversationPort) {
  return {
    listConversations: (principal: Principal, projectId: string, query?: PageQuery) => port.listConversations(principal, projectId, query),
    listRoots: (principal: Principal, projectId: string, query?: ConversationRootQuery) =>
      port.listRoots(principal, projectId, normalizeRootWindow(query)),
    getConversation: (principal: Principal, conversationId: string, query?: ConversationWindowQuery) =>
      port.getConversation(principal, conversationId, normalizeConversationWindow(query)),
    createConversation: (principal: Principal, projectId: string, command: SendMessageCommand, via?: string, viaColour?: AgentColour) =>
      port.createConversation(principal, projectId, { ...normalizeMessage(command), via: via ?? null, viaColour: via ? viaColour ?? null : null }),
    sendMessage: (principal: Principal, conversationId: string, command: SendMessageCommand, via?: string, viaColour?: AgentColour) =>
      port.sendMessage(principal, conversationId, { ...normalizeMessage(command), via: via ?? null, viaColour: via ? viaColour ?? null : null }),
    decisionDiscussion: (principal: Principal, decisionId: string, query?: ConversationWindowQuery) =>
      port.decisionDiscussion(principal, decisionId, normalizeConversationWindow(query)),
    discussDecision: (principal: Principal, decisionId: string, command: SendMessageCommand) =>
      port.discussDecision(principal, decisionId, { ...normalizeMessage(command), via: null, viaColour: null }),
    editMessage: (principal: Principal, conversationId: string, messageId: string, command: EditMessageCommand) =>
      port.editMessage(principal, conversationId, messageId, normalizeMessageEdit(command)),
    removeMessage: (principal: Principal, conversationId: string, messageId: string) => port.removeMessage(principal, conversationId, messageId),
    getMaterial: (principal: Principal, materialId: string) => port.getMaterial(principal, materialId),
    getMaterialVersion: (principal: Principal, materialId: string, version: number) => port.getMaterialVersion(principal, materialId, version),
  };
}
